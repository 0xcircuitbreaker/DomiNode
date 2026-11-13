import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import {
  DEFAULT_POLICY, FrameDecoder, FrameType, encodeFrame, encodeControl, decodeControl, hashNodeKey,
  type ActivePolicy, type TunnelAuthNode, type Frame,
  authMessage, challengeMessage, signEd25519, verifyEd25519, ed25519PublicKeyHex,
} from "@dominusnode/shared";
import { generateKeyPairSync, type KeyObject } from "node:crypto";

const NODE_KEYS = new Map<string, KeyObject>();
import { NodeTunnelServer, resolveTunnelPort, type GeoInfo } from "./server.js";
import { NodeRegistry } from "./registry.js";

const KEY_A = "dn_node_" + "aa".repeat(32);
const KEY_B = "dn_node_" + "bb".repeat(32);
const NODES: Record<string, TunnelAuthNode> = {
  [hashNodeKey(KEY_A)]: authNode("11111111-1111-4111-8111-111111111111"),
  [hashNodeKey(KEY_B)]: authNode("22222222-2222-4222-8222-222222222222"),
};
function authNode(id: string): TunnelAuthNode {
  const kp = generateKeyPairSync("ed25519");
  NODE_KEYS.set(id, kp.privateKey);
  return { id, owner_user_id: "u-" + id, owner_wallet: "0xw", owner_team_id: null, node_pubkey: ed25519PublicKeyHex(kp.publicKey), status: "active",
    attestation_version: 1, max_streams: 8, max_gb_day: 5, reputation: 3000 };
}

let server: NodeTunnelServer | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets.length = 0;
  await server?.close();
  server = null;
});

async function start(opts: { policy?: Partial<ActivePolicy["body"]>; geo?: GeoInfo | null; heartbeatMs?: number; deadline?: number; activate?: (id: string) => Promise<boolean>; coordSign?: (m: Buffer) => string; claimIpSlot?: (s: { nodeId: string }) => Promise<boolean>; releaseIpSlot?: (nodeId: string) => Promise<void>; recordVerifiedClass?: (id: string, c: string) => Promise<unknown>; defer?: boolean | (() => boolean); onReady?: (id: string) => void; markOnlineClass?: (c: unknown) => void; prefixHist?: () => Promise<string[]> } = {}) {
  const policy: ActivePolicy = { version: 3, sha256: "f".repeat(64), body: { ...DEFAULT_POLICY, ...opts.policy }, createdAt: null };
  const online: string[] = [];
  const offline: string[] = [];
  const registry = new NodeRegistry();
  server = new NodeTunnelServer(registry, {
    getNodeForTunnelAuth: async (h) => NODES[h] ?? null,
    ownerPrefixProbeClasses: opts.prefixHist as never,
    markOnline: async (id, ip, _cc, _asn, cls) => { online.push(`${id}@${ip}`); opts.markOnlineClass?.(cls); return true; },
    ...(opts.onReady ? { onNodeReady: (l: { nodeId: string }) => opts.onReady!(l.nodeId) } : {}),
    markOffline: async (id) => { offline.push(id); return true; },
    ...(opts.activate ? { activatePending: opts.activate } : {}),
    getPolicy: () => policy,
    ...(opts.coordSign ? { coordSign: opts.coordSign } : {}),
    ...(opts.claimIpSlot ? { claimIpSlot: opts.claimIpSlot } : {}),
    ...(opts.releaseIpSlot ? { releaseIpSlot: opts.releaseIpSlot } : {}),
    ...(opts.recordVerifiedClass ? { recordVerifiedClass: opts.recordVerifiedClass } : {}),
    geoLookup: () => (opts.geo === undefined ? { country: "US", asn: 64500 } : opts.geo),
  }, { port: 0, host: "127.0.0.1", heartbeatMs: opts.heartbeatMs, handshakeDeadlineMs: opts.deadline, deferClassUntilProbe: opts.defer });
  const port = await server.listen();
  return { port, registry, online, offline };
}

/** authSig: "auto" signs AUTH with the node's key; "bad" signs with a stranger's; "none" sends nothing. */
function connect(port: number, key = KEY_A, path = "/v1/tunnel", authSig: "auto" | "bad" | "none" = "auto") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  sockets.push(ws);
  const frames: Frame[] = [];
  const dec = new FrameDecoder();
  const nodeId = NODES[hashNodeKey(key)]?.id;
  ws.on("message", (d: Buffer) => {
    for (const f of dec.push(d)) {
      frames.push(f);
      if (f.type === FrameType.CHALLENGE && authSig !== "none" && nodeId) {
        const ch = decodeControl<{ nonce: string }>(f.payload);
        const k = authSig === "auto" ? NODE_KEYS.get(nodeId)! : generateKeyPairSync("ed25519").privateKey;
        ws.send(encodeFrame(FrameType.AUTH, 0, 0, encodeControl({ sig: signEd25519(k, authMessage(ch.nonce, nodeId, null)) })));
      }
    }
  });
  ws.on("error", () => undefined);
  const closed = new Promise<number>((r) => ws.on("close", (c) => r(c)));
  const status = new Promise<number>((r) => ws.on("unexpected-response", (_q, res) => r(res.statusCode ?? 0)));
  const opened = new Promise<void>((r) => ws.on("open", () => r()));
  const send = (t: FrameType, id: number, obj: unknown) => ws.send(encodeFrame(t, id, 0, encodeControl(obj)));
  const waitFor = async (t: FrameType, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const f = frames.find((x) => x.type === t);
      if (f) return f;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for ${t}`);
  };
  return { ws, frames, closed, status, opened, send, waitFor };
}

const hello = (id = NODES[hashNodeKey(KEY_A)].id) => ({ nodeId: id, agentVersion: "t", caps: { maxStreams: 4, ports: [80, 443] }, floorHash: "x" });

describe("resolveTunnelPort", () => {
  it("defaults and validates", () => {
    expect(resolveTunnelPort(undefined)).toBe(9443);
    expect(resolveTunnelPort("9000")).toBe(9000);
    for (const bad of ["abc", "0", "70000", "-1", "1e3", "NaN"]) expect(() => resolveTunnelPort(bad)).toThrow();
  });
});

describe("NodeTunnelServer verified exit class", () => {
  it("uses the gateway-verified class and flags a declared-residential node exiting via WARP", async () => {
    const n = NODES[hashNodeKey(KEY_A)]!;
    n.declared_class = "residential";
    try {
      const calls: string[] = [];
      const { port, registry } = await start({
        geo: { country: "US", asn: 13335, ipClass: "masked" },
        recordVerifiedClass: async (id, c) => { calls.push(`${id}:${c}`); },
      });
      const c = connect(port);
      await c.opened;
      c.send(FrameType.HELLO, 0, hello());
      await c.waitFor(FrameType.AUTH_OK);
      expect(registry.get(n.id)?.ipClass).toBe("masked");
      expect(calls).toEqual([`${n.id}:masked`]);
    } finally {
      delete n.declared_class;
    }
  });

  it("no flag when the verified class matches or nothing was declared", async () => {
    const calls: string[] = [];
    const { port, registry } = await start({
      geo: { country: "US", asn: 7922, ipClass: "residential" },
      recordVerifiedClass: async (id, c) => { calls.push(`${id}:${c}`); },
    });
    const c = connect(port);
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    await c.waitFor(FrameType.AUTH_OK);
    expect(registry.get(NODES[hashNodeKey(KEY_A)]!.id)?.ipClass).toBe("residential");
    expect(calls).toEqual([]);
  });
});

describe("NodeTunnelServer AUTH (commit 20)", () => {
  it("signs CHALLENGE with the coordinator key and announces binding none on plain WS", async () => {
    const coord = generateKeyPairSync("ed25519");
    const { port } = await start({ coordSign: (m) => signEd25519(coord.privateKey, m) });
    const c = connect(port);
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    const ch = decodeControl<{ nonce: string; policyVersion: number; serverTime: number; binding: string; coordSig: string }>(
      (await c.waitFor(FrameType.CHALLENGE)).payload);
    expect(ch.binding).toBe("none");
    expect(verifyEd25519(ed25519PublicKeyHex(coord.publicKey), challengeMessage(ch.nonce, ch.policyVersion, ch.serverTime, "none"), ch.coordSig)).toBe(true);
    await c.waitFor(FrameType.AUTH_OK);
  });

  it("rejects an AUTH signed by the wrong key", async () => {
    const { port, online } = await start();
    const c = connect(port, KEY_A, "/v1/tunnel", "bad");
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    expect(decodeControl((await c.waitFor(FrameType.AUTH_FAIL)).payload)).toEqual({ code: "BAD_SIGNATURE" });
    expect(online).toHaveLength(0);
  });

  it("rejects non-AUTH frames after CHALLENGE and nodes without a registered pubkey", async () => {
    const { port } = await start();
    const c = connect(port, KEY_A, "/v1/tunnel", "none");
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    await c.waitFor(FrameType.CHALLENGE);
    c.send(FrameType.PING, 0, { seq: 1 });
    expect(await c.closed).toBe(1002);

    const n = NODES[hashNodeKey(KEY_B)];
    const saved = n.node_pubkey;
    n.node_pubkey = null;
    try {
      const d = connect(port, KEY_B);
      await d.opened;
      d.send(FrameType.HELLO, 0, hello(n.id));
      expect(decodeControl((await d.waitFor(FrameType.AUTH_FAIL)).payload)).toEqual({ code: "NO_PUBKEY" });
    } finally {
      n.node_pubkey = saved;
    }
  });
});

describe("NodeTunnelServer", () => {
  it("rejects missing/unknown keys and wrong paths", async () => {
    const { port } = await start();
    expect(await connect(port, "dn_node_" + "cc".repeat(32)).status).toBe(401);
    expect(await connect(port, "nope").status).toBe(401);
    expect(await connect(port, KEY_A, "/other").status).toBe(404);
  });

  it("handshakes: CHALLENGE, AUTH_OK, POLICY_UPDATE; registers and marks online with peer IP", async () => {
    const { port, registry, online, offline } = await start();
    const c = connect(port);
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    const ch = decodeControl<{ nonce: string; policyVersion: number }>((await c.waitFor(FrameType.CHALLENGE)).payload);
    expect(ch.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(ch.policyVersion).toBe(3);
    const ok = decodeControl<Record<string, unknown>>((await c.waitFor(FrameType.AUTH_OK)).payload);
    expect(ok).toMatchObject({ initialWindow: 262144, policyHash: "f".repeat(64) });
    const pu = decodeControl<Record<string, unknown>>((await c.waitFor(FrameType.POLICY_UPDATE)).payload);
    expect(pu).toMatchObject({ policyVersion: 3, ports: [80, 443] });
    expect(online[0]).toMatch(/@127\.0\.0\.1$/);
    const live = registry.get(NODES[hashNodeKey(KEY_A)].id)!;
    expect(live.ready).toBe(true);
    expect(live.country).toBe("US");
    expect(live.maxStreams).toBe(4);
    // geo carried no verified class: never assumed residential
    expect(live.ipClass).toBe("unknown");
    c.ws.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.size).toBe(0);
    expect(offline).toHaveLength(1);
  });

  it("promotes a pending node to active after a completed handshake", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const key = "dn_node_" + "dd".repeat(32);
    NODES[hashNodeKey(key)] = { ...authNode(id), status: "pending" };
    const activated: string[] = [];
    try {
      const { port, registry } = await start({ activate: async (n) => { activated.push(n); return true; } });
      const c = connect(port, key);
      await c.opened;
      c.send(FrameType.HELLO, 0, hello(id));
      await c.waitFor(FrameType.AUTH_OK);
      expect(activated).toEqual([id]);
      expect(registry.get(id)!.status).toBe("active");
    } finally {
      delete NODES[hashNodeKey(key)];
    }
  });

  it("leaves a pending node pending (unselectable) when activation fails", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const key = "dn_node_" + "ee".repeat(32);
    NODES[hashNodeKey(key)] = { ...authNode(id), status: "pending" };
    try {
      const { port, registry } = await start({ activate: async () => { throw new Error("db down"); } });
      const c = connect(port, key);
      await c.opened;
      c.send(FrameType.HELLO, 0, hello(id));
      await c.waitFor(FrameType.AUTH_OK);
      expect(registry.get(id)!.status).toBe("pending");
    } finally {
      delete NODES[hashNodeKey(key)];
    }
  });

  it("rejects a sanctioned peer geo with AUTH_FAIL", async () => {
    const { port, registry } = await start({ geo: { country: "IR", asn: 1 } });
    const c = connect(port);
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    expect(decodeControl((await c.waitFor(FrameType.AUTH_FAIL)).payload)).toEqual({ code: "SANCTIONED" });
    await c.closed;
    expect(registry.size).toBe(0);
  });

  it("enforces the per-/32 cap", async () => {
    const { port } = await start({ policy: { nodeCapsPerPrefix: { per32: 1, per24: 8, perAsn: 500 } } });
    const a = connect(port, KEY_A);
    await a.opened;
    a.send(FrameType.HELLO, 0, hello());
    await a.waitFor(FrameType.AUTH_OK);
    const b = connect(port, KEY_B);
    await b.opened;
    b.send(FrameType.HELLO, 0, hello(NODES[hashNodeKey(KEY_B)].id));
    expect(decodeControl((await b.waitFor(FrameType.AUTH_FAIL)).payload)).toEqual({ code: "IP_CAP" });
  });

  it("enforces fleet-wide caps via the shared slot store and releases on close", async () => {
    let allow = false;
    const released: string[] = [];
    const claims: unknown[] = [];
    const { port, registry } = await start({
      claimIpSlot: async (s) => { claims.push(s); return allow; },
      releaseIpSlot: async (id) => { released.push(id); },
    });
    const a = connect(port, KEY_A);
    await a.opened;
    a.send(FrameType.HELLO, 0, hello());
    expect(decodeControl((await a.waitFor(FrameType.AUTH_FAIL)).payload)).toEqual({ code: "IP_CAP" });
    expect(registry.size).toBe(0);
    expect(claims[0]).toMatchObject({ ip: "127.0.0.1", asn: 64500, enforceAsn: true });
    allow = true;
    const b = connect(port, KEY_A);
    await b.opened;
    b.send(FrameType.HELLO, 0, hello());
    await b.waitFor(FrameType.AUTH_OK);
    b.ws.close();
    await b.closed;
    const end = Date.now() + 2000;
    while (released.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(released).toEqual([NODES[hashNodeKey(KEY_A)].id]);
  });

  it("refuses unknown-ASN public peers only when requireAsn is set", async () => {
    // Loopback peers are never public, so requireAsn must not affect them.
    const { port } = await start({ geo: { country: "US", asn: null } });
    (server as unknown as { opts: { requireAsn?: boolean } }).opts.requireAsn = true;
    const a = connect(port, KEY_A);
    await a.opened;
    a.send(FrameType.HELLO, 0, hello());
    await a.waitFor(FrameType.AUTH_OK);
  });

  it("rejects a HELLO with a mismatching nodeId", async () => {
    const { port } = await start();
    const c = connect(port);
    await c.opened;
    c.send(FrameType.HELLO, 0, hello("someone-else"));
    expect(decodeControl((await c.waitFor(FrameType.AUTH_FAIL)).payload)).toEqual({ code: "BAD_HELLO" });
  });

  it("closes on non-HELLO first frame, pre-auth cap and handshake deadline", async () => {
    const { port } = await start({ deadline: 200 });
    const a = connect(port);
    await a.opened;
    a.send(FrameType.PING, 0, { seq: 1 });
    expect(await a.closed).toBe(1002);
    const b = connect(port);
    await b.opened;
    b.ws.send(encodeFrame(FrameType.HELLO, 0, 0, Buffer.alloc(4097)).subarray(0, 4200));
    expect(await b.closed).toBe(1009);
    const c = connect(port);
    await c.opened;
    expect(await c.closed).toBe(1008);
  });

  it("closes after three missed PONGs", async () => {
    const { port } = await start({ heartbeatMs: 30 });
    const c = connect(port);
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    await c.waitFor(FrameType.AUTH_OK);
    expect(await c.closed).toBe(1001);
    expect(c.frames.filter((f) => f.type === FrameType.PING).length).toBe(3);
  });

  it("a PONG that answers no PING we sent does not count as liveness", async () => {
    const { port } = await start({ heartbeatMs: 30 });
    const c = connect(port);
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    await c.waitFor(FrameType.AUTH_OK);
    const t = setInterval(() => { try { c.send(FrameType.PONG, 0, { seq: 987654 }); } catch { /* closed */ } }, 5);
    try {
      expect(await c.closed).toBe(1001);
    } finally { clearInterval(t); }
  });

  it("closes a tunnel whose send queue exceeds maxStreams x window (node not reading)", async () => {
    const { port, registry } = await start();
    const c = connect(port);
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    await c.waitFor(FrameType.AUTH_OK);
    const live = registry.get(NODES[hashNodeKey(KEY_A)]!.id)!;
    const tunnel = live.tunnel as unknown as { ws: WebSocket; sendBufferCap: number; sendControl(t: FrameType, o: Record<string, unknown>): void; isOpen: boolean };
    expect(tunnel.sendBufferCap).toBe((8 + 1) * 256 * 1024 + 1024 * 1024);
    Object.defineProperty(tunnel.ws, "bufferedAmount", { get: () => tunnel.sendBufferCap, configurable: true });
    tunnel.sendControl(FrameType.DRAIN, {});
    expect(tunnel.isOpen).toBe(false);
    expect(await c.closed).toBe(1008);
  });

  it("pushes policy updates to ready tunnels", async () => {
    const { port } = await start();
    const c = connect(port);
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    await c.waitFor(FrameType.AUTH_OK);
    c.frames.length = 0;
    server!.pushPolicy({ version: 9, sha256: "a".repeat(64), body: { ...DEFAULT_POLICY, ports: [443] }, createdAt: null });
    expect(decodeControl((await c.waitFor(FrameType.POLICY_UPDATE)).payload)).toMatchObject({ policyVersion: 9, ports: [443] });
  });
  it("a reconnect cannot shed a persisted probe downgrade (connect class = conservative(peer, probe_class))", async () => {
    const n = NODES[hashNodeKey(KEY_A)]!;
    (n as { probe_class?: string | null }).probe_class = "masked";
    try {
      const classes: unknown[] = [];
      const { port, registry } = await start({ geo: { country: "US", asn: 7922, ipClass: "residential" }, markOnlineClass: (c) => classes.push(c) });
      const c = connect(port);
      await c.opened;
      c.send(FrameType.HELLO, 0, hello());
      await c.waitFor(FrameType.AUTH_OK);
      expect(registry.get(n.id)?.ipClass).toBe("masked");
      expect(registry.get(n.id)?.peerClass).toBe("residential");
      expect(classes).toEqual(["masked"]); // DB ip_class is not reset to residential
    } finally {
      delete (n as { probe_class?: string | null }).probe_class;
    }
  });

  it("with probes enabled a fresh connect is unknown until probed and is queued for a connect probe", async () => {
    const ready: string[] = [];
    const { port, registry } = await start({ geo: { country: "US", asn: 7922, ipClass: "residential" }, defer: true, onReady: (id) => ready.push(id) });
    const c = connect(port);
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    await c.waitFor(FrameType.AUTH_OK);
    const id = NODES[hashNodeKey(KEY_A)]!.id;
    expect(registry.get(id)?.ipClass).toBe("unknown");
    expect(registry.get(id)?.peerClass).toBe("residential");
    expect(registry.get(id)?.probePending).toBe(true);
    expect(ready).toEqual([id]);
  });

  it("a revoked sibling's masked probe verdict on the same prefix carries over to a new node", async () => {
    const classes: unknown[] = [];
    const { port, registry } = await start({ geo: { country: "US", asn: 7922, ipClass: "residential" }, prefixHist: async () => ["masked"], markOnlineClass: (c) => classes.push(c) });
    const c = connect(port);
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    await c.waitFor(FrameType.AUTH_OK);
    expect(registry.get(NODES[hashNodeKey(KEY_A)]!.id)?.ipClass).toBe("masked");
    expect(classes).toEqual(["masked"]);
  });

  it("with probes enabled a known masked peer stays masked (never unknown) until probed", async () => {
    const { port, registry } = await start({ geo: { country: "US", asn: 13335, ipClass: "masked" }, defer: true });
    const c = connect(port);
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    await c.waitFor(FrameType.AUTH_OK);
    const id = NODES[hashNodeKey(KEY_A)]!.id;
    expect(registry.get(id)?.ipClass).toBe("masked");
    expect(registry.get(id)?.probePending).toBe(true);
  });
  it("with probes enabled an owner+prefix masked verdict is kept as connectClass for the first probe", async () => {
    const { port, registry } = await start({ geo: { country: "US", asn: 7922, ipClass: "residential" }, defer: true, prefixHist: async () => ["masked"] });
    const c = connect(port);
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    await c.waitFor(FrameType.AUTH_OK);
    const live = registry.get(NODES[hashNodeKey(KEY_A)]!.id)!;
    expect(live.peerClass).toBe("residential");
    expect(live.connectClass).toBe("masked");
    expect(live.ipClass).toBe("masked");
  });

  it("a deferral callback returning false (echo self-check failing) does not hold the node pending", async () => {
    const { port, registry } = await start({ geo: { country: "US", asn: 7922, ipClass: "residential" }, defer: () => false });
    const c = connect(port);
    await c.opened;
    c.send(FrameType.HELLO, 0, hello());
    await c.waitFor(FrameType.AUTH_OK);
    const live = registry.get(NODES[hashNodeKey(KEY_A)]!.id)!;
    expect(live.probePending).toBe(false);
    expect(live.ipClass).toBe("residential");
  });
});
