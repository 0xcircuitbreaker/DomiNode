/**
 * Integration: the real node-agent TunnelClient against the in-process gateway
 * tunnel server. The node floor blocks loopback, so the client's `dial` seam
 * (its constructor option) is pointed at a local echo server.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { DEFAULT_POLICY, hashNodeKey, type ActivePolicy, type TunnelAuthNode } from "@dominusnode/shared";
import { NodeTunnelServer } from "../src/node-tunnel/server.js";
import { NodeRegistry } from "../src/node-tunnel/registry.js";
import { NodeSelector } from "../src/node-tunnel/selector.js";
import { TunnelOpenError, type StreamCloseReport } from "../src/node-tunnel/mux.js";
import { TunnelClient, type DialFn } from "../../node-agent/src/tunnel-client.js";
import { Limits } from "../../node-agent/src/limits.js";

const KEY = "dn_node_" + "ab".repeat(32);
const NODE_ID = "33333333-3333-4333-8333-333333333333";
const node: TunnelAuthNode = { id: NODE_ID, owner_user_id: "owner", owner_wallet: "0xo", owner_team_id: null, node_pubkey: null,
  status: "active", attestation_version: 1, max_streams: 8, max_gb_day: 5, reputation: 5000 };
const policy: ActivePolicy = { version: 1, sha256: "e".repeat(64), body: DEFAULT_POLICY, createdAt: null };
const quiet = { info: () => undefined, warn: () => undefined };

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});

async function setup(dialOverride?: DialFn) {
  const echo = net.createServer((s) => { s.on("error", () => undefined); s.pipe(s); });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as net.AddressInfo).port;
  cleanup.push(() => new Promise<void>((r) => echo.close(() => r())));

  const reports: StreamCloseReport[] = [];
  const registry = new NodeRegistry();
  const server = new NodeTunnelServer(registry, {
    getNodeForTunnelAuth: async (h) => (h === hashNodeKey(KEY) ? node : null),
    markOnline: async () => true,
    markOffline: async () => true,
    getPolicy: () => policy,
    geoLookup: () => ({ country: "US", asn: 64500 }),
    onStreamClose: (_id, r) => reports.push(r),
  }, { port: 0, host: "127.0.0.1" });
  const port = await server.listen();
  cleanup.push(() => server.close());

  // Test seam: the client's injected dialer lands on the echo server (the real
  // floor-checked dialer would refuse loopback).
  const dial: DialFn = dialOverride ?? (async (host, p, allowed) => {
    if (!allowed.includes(p)) return { ok: false, code: "PORT_BLOCKED" };
    if (host === "blocked.test") return { ok: false, code: "FLOOR_BLOCKED" };
    const socket = net.connect({ host: "127.0.0.1", port: echoPort });
    await new Promise<void>((res, rej) => { socket.once("connect", res); socket.once("error", rej); });
    return { ok: true, socket };
  });
  const client = new TunnelClient({
    url: `ws://127.0.0.1:${port}/v1/tunnel`, nodeKey: KEY, nodeId: NODE_ID, agentVersion: "it",
    localPorts: [80, 443], caps: { maxStreams: 8, maxMbps: 100, gbPerDay: 5 },
    limits: new Limits({ maxStreams: 8, reqPerSec: 1000, gbPerDay: 5 }), dial, logger: quiet,
  });
  cleanup.unshift(() => client.stop());
  const ready = new Promise<void>((r) => client.once("ready", () => r()));
  client.start();
  await ready;
  // Wait for the gateway side to mark the node ready.
  for (let i = 0; i < 100 && !registry.get(NODE_ID)?.ready; i++) await new Promise((r) => setTimeout(r, 10));
  return { registry, server, client, reports };
}

function readN(s: Duplex, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let got = 0;
    const onData = (c: Buffer) => {
      parts.push(c);
      got += c.length;
      if (got >= n) {
        s.off("data", onData);
        resolve(Buffer.concat(parts));
      }
    };
    s.on("data", onData);
    s.once("error", reject);
  });
}

describe("node tunnel integration", () => {
  it("selects the live node and echoes data through a stream", async () => {
    const { registry, server } = await setup();
    const sel = new NodeSelector(registry, { getPolicy: () => policy.body });
    const live = sel.select({ requesterUserId: "req", clientIp: "203.0.113.5", targetHost: "example.com", port: 443, country: "US" });
    expect(live.nodeId).toBe(NODE_ID);
    const s = await live.tunnel.openStream("example.com", 443);
    const p = readN(s, 5);
    s.write("hello");
    expect((await p).toString()).toBe("hello");
    s.destroy();
    expect(server.tunnelCount).toBe(1);
  });

  it("moves more than one window in both directions (flow control)", async () => {
    const { registry, reports } = await setup();
    const live = registry.get(NODE_ID)!;
    const s = await live.tunnel.openStream("example.com", 443);
    const size = 1_000_000;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = i % 251;
    const p = readN(s, size);
    s.write(payload);
    const echoed = await p;
    expect(echoed.equals(payload)).toBe(true);
    const ended = new Promise((r) => s.once("end", r));
    s.end();
    await ended;
    await new Promise((r) => setTimeout(r, 50));
    expect(reports[0].gatewayBytesOut).toBe(size);
    expect(reports[0].gatewayBytesIn).toBe(size);
    expect(reports[0].nodeReport).toMatchObject({ bytesIn: size, bytesOut: size });
  });

  it("maps OPEN_ERR from the node", async () => {
    const { registry } = await setup();
    const t = registry.get(NODE_ID)!.tunnel;
    const e1 = await t.openStream("blocked.test", 443).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(TunnelOpenError);
    expect((e1 as TunnelOpenError).mapping).toMatchObject({ status: 403, code: "FLOOR_BLOCKED", retryable: false });
    const e2 = await t.openStream("example.com", 8080).catch((e: unknown) => e);
    expect((e2 as TunnelOpenError).code).toBe("PORT_BLOCKED");
  });

  it("removes the node from the registry when the agent stops", async () => {
    const { registry, client } = await setup();
    client.stop();
    for (let i = 0; i < 100 && registry.size > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(registry.size).toBe(0);
  });
});
