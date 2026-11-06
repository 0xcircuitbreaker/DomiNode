import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { DEFAULT_POLICY, type ActivePolicy } from "@dominusnode/shared";
import { NodeTunnelServer } from "./server.js";
import { NodeRegistry } from "./registry.js";
import { PROXY_V2_SIG, PreAuthLimiter, parseProxyV2, parseTrustedProxyIps } from "./ingress.js";

const KEY = "dn_node_" + "cd".repeat(32);

function proxyV2(src: string, dst = "10.0.0.1"): Buffer {
  const b = Buffer.alloc(16 + 12);
  PROXY_V2_SIG.copy(b, 0);
  b[12] = 0x21;
  b[13] = 0x11;
  b.writeUInt16BE(12, 14);
  src.split(".").forEach((o, i) => (b[16 + i] = Number(o)));
  dst.split(".").forEach((o, i) => (b[20 + i] = Number(o)));
  b.writeUInt16BE(40000, 24);
  b.writeUInt16BE(8443, 26);
  return b;
}

function upgradeReq(port: number, extra = ""): string {
  return `GET /v1/tunnel HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
    `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer ${KEY}\r\n${extra}\r\n`;
}

function rawStatus(port: number, payload: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(payload));
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) {
        s.destroy();
        resolve(Number(m[1]));
      }
    });
    s.on("close", () => resolve(0));
    s.on("error", reject);
  });
}

let server: NodeTunnelServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(opts: ConstructorParameters<typeof NodeTunnelServer>[2] = {}) {
  let lookups = 0;
  const policy: ActivePolicy = { version: 1, sha256: "f".repeat(64), body: DEFAULT_POLICY, createdAt: null };
  server = new NodeTunnelServer(new NodeRegistry(), {
    getNodeForTunnelAuth: async () => { lookups++; return null; },
    markOnline: async () => true,
    markOffline: async () => true,
    getPolicy: () => policy,
    geoLookup: () => ({ country: "US", asn: 1 }),
  }, { port: 0, host: "127.0.0.1", ...opts });
  const port = await server.listen();
  return { port, lookups: () => lookups };
}

describe("PROXY v2 parsing", () => {
  it("parses TCP4 and rejects garbage", () => {
    expect(parseProxyV2(proxyV2("8.8.8.8"))).toEqual({ kind: "proxy", length: 28, srcIp: "8.8.8.8" });
    expect(parseProxyV2(proxyV2("8.8.8.8").subarray(0, 20)).kind).toBe("incomplete");
    expect(parseProxyV2(Buffer.from("GET / HTTP/1.1\r\n")).kind).toBe("invalid");
  });
  it("validates TUNNEL_TRUSTED_PROXY_IPS", () => {
    expect([...parseTrustedProxyIps(" 10.0.0.2, ::1 ")]).toEqual(["10.0.0.2", "::1"]);
    expect(parseTrustedProxyIps(undefined).size).toBe(0);
    expect(() => parseTrustedProxyIps("10.0.0.0/8")).toThrow();
    expect(() => parseTrustedProxyIps("caddy")).toThrow();
  });
});

describe("tunnel peer IP", () => {
  it("production: untrusted loopback peer is refused; X-Forwarded-For is ignored", async () => {
    const { port, lookups } = await start({ production: true });
    expect(await rawStatus(port, Buffer.from(upgradeReq(port, "X-Forwarded-For: 8.8.8.8\r\n")))).toBe(403);
    expect(lookups()).toBe(0);
  });

  it("untrusted source: PROXY header is not honoured", async () => {
    const { port } = await start({ production: true });
    const st = await rawStatus(port, Buffer.concat([proxyV2("8.8.8.8"), Buffer.from(upgradeReq(port))]));
    expect(st === 400 || st === 0).toBe(true);
  });

  it("trusted proxy: PROXY v2 source address is used", async () => {
    const { port, lookups } = await start({ production: true, trustedProxyIps: new Set(["127.0.0.1"]) });
    expect(await rawStatus(port, Buffer.concat([proxyV2("8.8.8.8"), Buffer.from(upgradeReq(port))]))).toBe(401);
    expect(lookups()).toBe(1);
  });

  it("trusted proxy: missing PROXY header drops the connection", async () => {
    const { port, lookups } = await start({ trustedProxyIps: new Set(["127.0.0.1"]) });
    expect(await rawStatus(port, Buffer.from(upgradeReq(port)))).toBe(0);
    expect(lookups()).toBe(0);
  });
});

describe("pre-auth DoS limits", () => {
  it("negative cache suppresses repeated DB lookups for an unknown key", async () => {
    const { port, lookups } = await start();
    expect(await rawStatus(port, Buffer.from(upgradeReq(port)))).toBe(401);
    expect(await rawStatus(port, Buffer.from(upgradeReq(port)))).toBe(401);
    expect(lookups()).toBe(1);
  });

  it("per-IP token bucket returns 429 before any lookup", async () => {
    const { port, lookups } = await start({ preAuth: { burst: 2, refillPerSec: 0.001, negativeTtlMs: 0 } });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push(await rawStatus(port, Buffer.from(upgradeReq(port))));
    expect(codes).toEqual([401, 401, 429, 429]);
    expect(lookups()).toBe(2);
  });

  it("limiter: global in-flight cap, map cap and sweep", () => {
    let now = 0;
    const l = new PreAuthLimiter({ maxConcurrent: 2, maxTrackedIps: 2, burst: 1, refillPerSec: 1, now: () => now });
    expect(l.tryAcquire()).toBe(true);
    expect(l.tryAcquire()).toBe(true);
    expect(l.tryAcquire()).toBe(false);
    l.release();
    expect(l.tryAcquire()).toBe(true);
    expect(l.allowIp("a")).toBe(true);
    expect(l.allowIp("b")).toBe(true);
    expect(l.allowIp("c")).toBe(false); // map full, nothing sweepable
    now = 5000;
    expect(l.allowIp("c")).toBe(true); // sweep freed refilled buckets
    expect(l.trackedIps).toBeLessThanOrEqual(2);
    l.addNegative("k");
    expect(l.isNegative("k")).toBe(true);
    now += 60_000;
    expect(l.isNegative("k")).toBe(false);
  });
});
