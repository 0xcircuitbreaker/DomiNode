import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { markSelfDiscoveryComplete } from "./floor.js";
import * as net from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { TunnelClient, backoffDelay, scrub, type TunnelLogger } from "./tunnel-client.js";
import { dial, type Connector, type DialResult } from "./dialer.js";
import { Limits } from "./limits.js";
import { FrameDecoder, FrameType, encodeFrame, encodeControl, decodeControl, FLAG_FIN, FLAG_RST, type Frame,
  challengeMessage, authMessage, signEd25519, verifyEd25519 } from "./shared.js";
import { generateKeyPairSync, type KeyObject } from "node:crypto";

const rawPub = (k: KeyObject) => (k.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
const COORD = generateKeyPairSync("ed25519");
const COORD_PUB = rawPub(COORD.publicKey);
const NODE = generateKeyPairSync("ed25519");
const NODE_PUB = rawPub(NODE.publicKey);
const NODE_PEM = NODE.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const NODE_ID = "11111111-2222-3333-4444-555555555555";

const NODE_KEY = "dn_node_" + "ab".repeat(32);
const quiet: TunnelLogger = { info: () => undefined, warn: () => undefined };

/** Minimal in-process gateway speaking the shared frame codec. */
class FakeGateway {
  wss!: WebSocketServer;
  port = 0;
  sock: WebSocket | null = null;
  frames: Frame[] = [];
  authHeaders: (string | undefined)[] = [];
  rejectAuth = false;
  /** Sign CHALLENGE with this key (null = unsigned). */
  coordKey: KeyObject | null = COORD.privateKey;
  authSigOk: boolean | null = null;
  private nonce = "cd".repeat(32);
  initialWindow = 262144;
  private waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];

  async start(): Promise<void> {
    this.wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      verifyClient: (info, cb) => {
        const h = info.req.headers.authorization;
        this.authHeaders.push(h);
        if (this.rejectAuth || h !== `Bearer ${NODE_KEY}`) cb(false, 401);
        else cb(true);
      },
    });
    await new Promise<void>((r) => this.wss.once("listening", () => r()));
    this.port = (this.wss.address() as net.AddressInfo).port;
    this.wss.on("connection", (ws) => {
      this.sock = ws;
      const dec = new FrameDecoder();
      ws.on("message", (d: Buffer) => {
        for (const f of dec.push(d)) {
          this.frames.push(f);
          if (f.type === FrameType.HELLO) {
            const serverTime = Date.now();
            const coordSig = this.coordKey ? signEd25519(this.coordKey, challengeMessage(this.nonce, 1, serverTime, "none")) : "";
            this.send(FrameType.CHALLENGE, 0, { nonce: this.nonce, policyVersion: 1, serverTime, binding: "none", coordSig });
          }
          if (f.type === FrameType.AUTH) {
            const a = decodeControl<{ sig?: unknown }>(f.payload);
            this.authSigOk = verifyEd25519(NODE_PUB, authMessage(this.nonce, NODE_ID, null), a.sig);
            if (this.authSigOk) this.send(FrameType.AUTH_OK, 0, { heartbeatMs: 15000, initialWindow: this.initialWindow, policyHash: "x" });
            else this.send(FrameType.AUTH_FAIL, 0, { code: "BAD_SIGNATURE" });
          }
          const i = this.waiters.findIndex((w) => w.pred(f));
          if (i !== -1) this.waiters.splice(i, 1)[0].resolve(f);
        }
      });
    });
  }

  send(type: FrameType, stream: number, obj: Record<string, unknown>, flags = 0): void {
    this.sock!.send(encodeFrame(type, stream, flags, encodeControl(obj)));
  }

  sendRaw(type: FrameType, stream: number, payload: Buffer, flags = 0): void {
    this.sock!.send(encodeFrame(type, stream, flags, payload));
  }

  next(pred: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const have = this.frames.find(pred);
    if (have) {
      this.frames.splice(this.frames.indexOf(have), 1);
      return Promise.resolve(have);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for frame")), timeoutMs);
      this.waiters.push({ pred, resolve: (f) => { clearTimeout(t); this.frames.splice(this.frames.indexOf(f), 1); resolve(f); } });
    });
  }

  close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

/** Connect to a local port while reporting a public remote address (passes the floor re-check). */
function fakePublic(port: number, halfOpen = false): net.Socket {
  const s = net.connect({ host: "127.0.0.1", port, allowHalfOpen: halfOpen });
  Object.defineProperty(s, "remoteAddress", { get: () => "93.184.216.34" });
  return s;
}

const ctl = (f: Frame) => decodeControl<Record<string, unknown>>(f.payload);
const onStream = (type: FrameType, id: number) => (f: Frame) => f.type === type && f.streamId === id;

markSelfDiscoveryComplete();

describe("TunnelClient", () => {
  let gw: FakeGateway;
  let echo: net.Server;
  let echoPort: number;
  let client: TunnelClient | null = null;
  const dialCalls: string[] = [];

  beforeEach(async () => {
    gw = new FakeGateway();
    await gw.start();
    echo = net.createServer((s) => { s.on("error", () => undefined); s.pipe(s); });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    echoPort = (echo.address() as net.AddressInfo).port;
    dialCalls.length = 0;
  });
  afterEach(async () => {
    client?.stop();
    client = null;
    await gw.close();
    await new Promise<void>((r) => echo.close(() => r()));
  });

  function makeClient(extra: Partial<ConstructorParameters<typeof TunnelClient>[0]> = {}): TunnelClient {
    // Real floor-checked dialer; "public" names resolve to a fixed public address and
    // the connector lands on the local echo server while reporting that address.
    const connector: Connector = (ip) => {
      dialCalls.push(ip);
      const s = net.connect({ host: "127.0.0.1", port: echoPort });
      Object.defineProperty(s, "remoteAddress", { get: () => ip });
      return s;
    };
    client = new TunnelClient({
      url: `ws://127.0.0.1:${gw.port}/v1/tunnel`,
      nodeKey: NODE_KEY,
      nodeId: NODE_ID,
      nodePrivateKeyPem: NODE_PEM,
      coordPins: [COORD_PUB],
      agentVersion: "test",
      localPorts: [80, 443],
      caps: { maxStreams: 8, maxMbps: 100, gbPerDay: 5 },
      limits: new Limits({ maxStreams: 8, reqPerSec: 1000, gbPerDay: 5 }),
      logger: quiet,
      backoffMinMs: 10,
      backoffMaxMs: 50,
      dial: (host, port, allowed) => dial(host, port, {
        allowedPorts: () => allowed, resolver: async () => ["93.184.216.34"], connector,
      }),
      ...extra,
    });
    return client;
  }

  async function ready(c: TunnelClient): Promise<void> {
    const p = new Promise<void>((r) => c.once("ready", () => r()));
    c.start();
    await p;
  }

  it("handshakes with Bearer dn_node_ key and HELLO caps", async () => {
    const c = makeClient();
    await ready(c);
    expect(gw.authHeaders[0]).toBe(`Bearer ${NODE_KEY}`);
    const hello = await gw.next((f) => f.type === FrameType.HELLO);
    const h = ctl(hello) as { nodeId: string; caps: { ports: number[] }; floorHash: string };
    expect(h.nodeId).toBe(NODE_ID);
    expect(gw.authSigOk).toBe(true);
    expect(h.caps.ports).toEqual([80, 443]);
    expect(h.floorHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an unsigned or wrongly-signed CHALLENGE and never sends AUTH", async () => {
    for (const key of [null, generateKeyPairSync("ed25519").privateKey]) {
      gw.coordKey = key;
      gw.frames.length = 0;
      const c = makeClient({ backoffMinMs: 5000, backoffMaxMs: 5000 });
      const fail = new Promise<string>((r) => c.once("authFail", (code: string) => r(code)));
      c.start();
      expect(await fail).toBe("COORD_SIGNATURE");
      expect(gw.frames.some((f) => f.type === FrameType.AUTH)).toBe(false);
      c.stop();
    }
  });

  it("refuses to authenticate with no coordinator pins", async () => {
    const c = makeClient({ coordPins: [], backoffMinMs: 5000, backoffMaxMs: 5000 });
    const fail = new Promise<string>((r) => c.once("authFail", (code: string) => r(code)));
    c.start();
    expect(await fail).toBe("COORD_SIGNATURE");
  });

  it("relays a stream end to end with WINDOW/CLOSE accounting", async () => {
    const c = makeClient();
    await ready(c);
    gw.send(FrameType.OPEN, 1, { host: "example.com", port: 443 });
    await gw.next(onStream(FrameType.OPEN_OK, 1));
    expect(dialCalls).toEqual(["93.184.216.34"]);
    gw.sendRaw(FrameType.DATA, 1, Buffer.from("ping-data"));
    const back = await gw.next(onStream(FrameType.DATA, 1));
    expect(back.payload.toString()).toBe("ping-data");
    gw.send(FrameType.CLOSE, 1, { bytesIn: 9, bytesOut: 9, reason: "done" }, FLAG_FIN);
    const close = await gw.next(onStream(FrameType.CLOSE, 1));
    expect(ctl(close)).toMatchObject({ bytesIn: 9, bytesOut: 9 });
    expect(c.activeStreamCount).toBe(0);
  });

  it("never sends more DATA than the peer-granted window", async () => {
    const W = 65536;
    gw.initialWindow = W;
    const c = makeClient();
    await ready(c);
    gw.send(FrameType.OPEN, 1, { host: "example.com", port: 443 });
    await gw.next(onStream(FrameType.OPEN_OK, 1));
    const total = 300_000;
    let toNodeSent = 0;
    let toNodeCredit = W; // what the node granted us
    let received = 0;
    let granted = W; // what we granted the node
    const pump = () => {
      while (toNodeSent < total && toNodeCredit > 0) {
        const n = Math.min(toNodeCredit, 40_000, total - toNodeSent);
        gw.sendRaw(FrameType.DATA, 1, Buffer.alloc(n, 7));
        toNodeSent += n;
        toNodeCredit -= n;
      }
    };
    pump();
    while (received < total) {
      const f = await gw.next((x) => x.streamId === 1 && (x.type === FrameType.DATA || x.type === FrameType.WINDOW));
      if (f.type === FrameType.WINDOW) {
        toNodeCredit += f.payload.readUInt32BE(0);
        pump();
        continue;
      }
      received += f.payload.length;
      expect(received).toBeLessThanOrEqual(granted);
      if (received === granted) {
        await new Promise((r) => setTimeout(r, 30));
        expect(gw.frames.filter(onStream(FrameType.DATA, 1))).toHaveLength(0);
        const credit = Buffer.alloc(4);
        credit.writeUInt32BE(W, 0);
        granted += W;
        gw.sendRaw(FrameType.WINDOW, 1, credit);
      }
    }
    expect(received).toBe(total);
    expect(c.activeStreamCount).toBe(1);
  });

  it("hostile POLICY_UPDATE cannot open port 25 or private targets", async () => {
    const c = makeClient();
    await ready(c);
    gw.send(FrameType.POLICY_UPDATE, 0, { policyVersion: 99, ports: [25, 22, 80, 443, 8080, 3389], categoriesVersion: 1 });
    await new Promise<void>((r) => c.once("policy", () => r()));
    expect(c.allowedPorts).toEqual([80, 443]);

    gw.send(FrameType.OPEN, 1, { host: "example.com", port: 25 });
    expect(ctl(await gw.next(onStream(FrameType.OPEN_ERR, 1)))).toEqual({ code: "PORT_BLOCKED" });
    const targets = ["127.0.0.1", "169.254.169.254", "::ffff:127.0.0.1", "localhost", "10.1.2.3"];
    let id = 3;
    for (const host of targets) {
      gw.send(FrameType.OPEN, id, { host, port: 443 });
      expect(ctl(await gw.next(onStream(FrameType.OPEN_ERR, id)))).toEqual({ code: "FLOOR_BLOCKED" });
      id += 2;
    }
    expect(dialCalls).toEqual([]);
  });

  it("POLICY_UPDATE narrows by intersection and can re-widen only within the floor", async () => {
    const c = makeClient({ localPorts: [80, 443] });
    await ready(c);
    gw.send(FrameType.POLICY_UPDATE, 0, { policyVersion: 2, ports: [443] });
    await new Promise<void>((r) => c.once("policy", () => r()));
    gw.send(FrameType.OPEN, 1, { host: "example.com", port: 80 });
    expect(ctl(await gw.next(onStream(FrameType.OPEN_ERR, 1)))).toEqual({ code: "PORT_BLOCKED" });
    gw.send(FrameType.POLICY_UPDATE, 0, { policyVersion: 3, ports: "all" });
    gw.send(FrameType.POLICY_UPDATE, 0, { policyVersion: 4, ports: [80, 443, 25] });
    await new Promise<void>((r) => c.once("policy", () => r()));
    expect(c.allowedPorts).toEqual([80, 443]);
  });

  it("answers PING with PONG and refuses even stream ids", async () => {
    const c = makeClient();
    await ready(c);
    gw.send(FrameType.PING, 0, { seq: 7, ts: 1 });
    expect(ctl(await gw.next((f) => f.type === FrameType.PONG))).toEqual({ seq: 7, ts: 1 });
    const closed = new Promise<number>((r) => c.once("disconnected", r));
    gw.send(FrameType.OPEN, 2, { host: "example.com", port: 443 });
    expect(await closed).toBe(1002);
  });

  it("DRAIN refuses new OPENs and closes the tunnel", async () => {
    const c = makeClient();
    await ready(c);
    gw.send(FrameType.OPEN, 1, { host: "example.com", port: 443 });
    await gw.next(onStream(FrameType.OPEN_OK, 1));
    gw.send(FrameType.DRAIN, 0, {});
    await new Promise<void>((r) => c.once("drain", () => r()));
    gw.send(FrameType.OPEN, 3, { host: "example.com", port: 443 });
    expect(ctl(await gw.next(onStream(FrameType.OPEN_ERR, 3)))).toEqual({ code: "CAP_EXCEEDED" });
    const closed = new Promise<number>((r) => c.once("disconnected", r));
    gw.send(FrameType.CLOSE, 1, { bytesIn: 0, bytesOut: 0, reason: "x" }, FLAG_FIN);
    expect(await closed).toBe(1000);
  });

  it("enforces stream cap with CAP_EXCEEDED", async () => {
    const c = makeClient({ limits: new Limits({ maxStreams: 1, reqPerSec: 1000, gbPerDay: 5 }) });
    await ready(c);
    gw.send(FrameType.OPEN, 1, { host: "example.com", port: 443 });
    await gw.next(onStream(FrameType.OPEN_OK, 1));
    gw.send(FrameType.OPEN, 3, { host: "example.com", port: 443 });
    expect(ctl(await gw.next(onStream(FrameType.OPEN_ERR, 3)))).toEqual({ code: "CAP_EXCEEDED" });
  });

  it("closes on protocol garbage and reconnects with backoff", async () => {
    const c = makeClient();
    await ready(c);
    const reconnecting = new Promise<number>((r) => c.once("reconnecting", r));
    gw.sock!.send(Buffer.from([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]));
    const delay = await reconnecting;
    expect(delay).toBeGreaterThanOrEqual(10);
    expect(delay).toBeLessThanOrEqual(50);
    await new Promise<void>((r) => c.once("ready", () => r()));
    expect(gw.authHeaders.length).toBe(2);
  });

  it("rejected upgrade schedules a retry", async () => {
    gw.rejectAuth = true;
    const c = makeClient();
    const rejected = new Promise<number>((r) => c.once("rejected", r));
    const reconnecting = new Promise<number>((r) => c.once("reconnecting", r));
    c.start();
    expect(await rejected).toBe(401);
    await reconnecting;
  });

  it("rejects malformed node keys", () => {
    expect(() => makeClient({ nodeKey: "dn_live_abc" })).toThrow();
  });

  it("does not collide with or answer for dials left over from a previous connection", async () => {
    let releaseStale!: (r: DialResult) => void;
    let calls = 0;
    const limits = new Limits({ maxStreams: 8, reqPerSec: 1000, gbPerDay: 5 });
    const c = makeClient({
      limits,
      dial: (host, port, allowed) => {
        calls++;
        if (calls === 1) return new Promise<DialResult>((r) => { releaseStale = r; });
        return dial(host, port, { allowedPorts: () => allowed, resolver: async () => ["93.184.216.34"],
          connector: () => fakePublic(echoPort) });
      },
    });
    await ready(c);
    gw.send(FrameType.OPEN, 1, { host: "example.com", port: 443 });
    await new Promise((r) => setTimeout(r, 30));
    // Tunnel drops while stream 1 is still dialing; the new tunnel restarts at id 1.
    const reconnected = new Promise<void>((r) => c.once("ready", () => r()));
    gw.sock!.terminate();
    await reconnected;
    gw.frames.length = 0;
    const closes: number[] = [];
    gw.sock!.on("close", (code: number) => closes.push(code));
    gw.send(FrameType.OPEN, 1, { host: "example.com", port: 443 });
    await gw.next(onStream(FrameType.OPEN_OK, 1));
    // The stale dial finishing must not send anything for id 1 nor delete the new entry.
    const stale = net.connect({ host: "127.0.0.1", port: echoPort });
    releaseStale({ ok: true, socket: stale, ip: "93.184.216.34" });
    await new Promise((r) => setTimeout(r, 50));
    expect(closes).toEqual([]);
    expect(gw.frames.filter((f) => f.streamId === 1 && f.type === FrameType.OPEN_OK)).toHaveLength(0);
    expect(c.activeStreamCount).toBe(1);
    expect(limits.activeStreams).toBe(1);
  });

  it("drops a dial the gateway reset while pending: no OPEN_OK, slot released", async () => {
    let finish!: (r: DialResult) => void;
    const limits = new Limits({ maxStreams: 8, reqPerSec: 1000, gbPerDay: 5 });
    const c = makeClient({ limits, dial: () => new Promise<DialResult>((r) => { finish = r; }) });
    await ready(c);
    gw.send(FrameType.OPEN, 1, { host: "example.com", port: 443 });
    await new Promise((r) => setTimeout(r, 30));
    gw.send(FrameType.CLOSE, 1, { bytesIn: 0, bytesOut: 0, reason: "open_timeout" }, FLAG_RST);
    await new Promise((r) => setTimeout(r, 30));
    const sock = net.connect({ host: "127.0.0.1", port: echoPort });
    sock.on("error", () => undefined);
    finish({ ok: true, socket: sock, ip: "93.184.216.34" });
    await new Promise((r) => setTimeout(r, 50));
    expect(gw.frames.some((f) => f.streamId === 1 && f.type === FrameType.OPEN_OK)).toBe(false);
    expect(c.activeStreamCount).toBe(0);
    expect(limits.activeStreams).toBe(0);
    expect(sock.destroyed).toBe(true);
  });

  it("treats target EOF as a half-close: upload after the node FIN still reaches the target", async () => {
    const received: Buffer[] = [];
    const gotUpload = new Promise<void>((resolve) => {
      const srv = net.createServer({ allowHalfOpen: true }, (s) => {
        s.on("error", () => undefined);
        s.end("bye"); // server half-closes first
        s.on("data", (d: Buffer) => { received.push(d); if (Buffer.concat(received).toString() === "late") resolve(); });
      });
      srv.listen(0, "127.0.0.1", () => {
        const port = (srv.address() as net.AddressInfo).port;
        afterTarget.push(() => srv.close());
        targetPort = port;
        resolveListening();
      });
    });
    let targetPort = 0;
    let resolveListening!: () => void;
    const listening = new Promise<void>((r) => { resolveListening = r; });
    const afterTarget: Array<() => void> = [];
    await listening;
    const c = makeClient({
      dial: (host, port, allowed) => dial(host, port, { allowedPorts: () => allowed, resolver: async () => ["93.184.216.34"],
        connector: () => fakePublic(targetPort, true) }),
    });
    await ready(c);
    gw.send(FrameType.OPEN, 1, { host: "example.com", port: 443 });
    await gw.next(onStream(FrameType.OPEN_OK, 1));
    const fin = await gw.next(onStream(FrameType.CLOSE, 1));
    expect(fin.flags & FLAG_FIN).toBeTruthy();
    expect(c.activeStreamCount).toBe(1);
    gw.sendRaw(FrameType.DATA, 1, Buffer.from("late"));
    await gotUpload;
    for (const f of afterTarget) f();
  });

});

describe("helpers", () => {
  it("backoff stays in [min,max] and grows", () => {
    for (let a = 0; a < 40; a++) {
      for (const r of [0, 0.5, 0.999]) {
        const d = backoffDelay(a, 1000, 60_000, () => r);
        expect(d).toBeGreaterThanOrEqual(1000);
        expect(d).toBeLessThanOrEqual(60_000);
      }
    }
    expect(backoffDelay(10, 1000, 60_000, () => 1)).toBe(60_000);
  });

  it("scrubs credentials", () => {
    expect(scrub(`bad ${NODE_KEY} and dn_live_xyz`)).toBe("bad [REDACTED] and [REDACTED]");
  });
});
