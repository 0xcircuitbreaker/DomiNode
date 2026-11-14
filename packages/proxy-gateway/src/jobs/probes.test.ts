import { describe, it, expect, vi } from "vitest";
import { Duplex } from "node:stream";
import { judgeProbeResponse, parseProbeUrl, parseProbeUrls, runOnce, exchange, TamperStrikes, ConnectProbeQueue, ProbeHealth, selfCheckTarget, type ProbeNode } from "./probes.js";

const NONCE = "n".repeat(24);
const ok = (ip: string, nonce = NONCE, status = "200 OK") => {
  const body = JSON.stringify({ ip, nonce });
  return `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
};
const target = { host: "api.example.com", port: 80, path: "/v1/probe/echo", tls: false };

describe("canary probe judging", () => {
  it("passes when nonce and egress IP match", () => {
    expect(judgeProbeResponse(ok("203.0.113.5"), NONCE, "203.0.113.5")).toEqual({ kind: "ok", egressIp: "203.0.113.5" });
    expect(judgeProbeResponse(ok("203.0.113.5"), NONCE, "::ffff:203.0.113.5")).toEqual({ kind: "ok", egressIp: "203.0.113.5" });
  });
  it("flags a nonce mismatch, a same-family IP mismatch and malformed replies as tamper", () => {
    expect(judgeProbeResponse(ok("203.0.113.5", "x".repeat(24)), NONCE, "203.0.113.5").kind).toBe("tamper");
    expect(judgeProbeResponse(ok("198.51.100.1"), NONCE, "203.0.113.5").kind).toBe("tamper");
    expect(judgeProbeResponse("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\n<html>", NONCE, "203.0.113.5").kind).toBe("tamper");
    expect(judgeProbeResponse(ok("203.0.113.5", NONCE, "302 Found"), NONCE, "203.0.113.5").kind).toBe("tamper");
  });
  it("treats truncated or unprovably-complete responses as inconclusive", () => {
    const full = ok("198.51.100.1");
    expect(judgeProbeResponse("", NONCE, "203.0.113.5").kind).toBe("inconclusive");
    expect(judgeProbeResponse("garbage", NONCE, "203.0.113.5").kind).toBe("inconclusive");
    expect(judgeProbeResponse(full.slice(0, full.length - 5), NONCE, "203.0.113.5").kind).toBe("inconclusive");
    expect(judgeProbeResponse("HTTP/1.1 200 OK\r\n\r\n<html>", NONCE, "203.0.113.5").kind).toBe("inconclusive");
    const body = JSON.stringify({ ip: "203.0.113.5", nonce: NONCE });
    const chunked = `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`;
    expect(judgeProbeResponse(chunked, NONCE, "203.0.113.5")).toEqual({ kind: "ok", egressIp: "203.0.113.5" });
    const cut = `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n`;
    expect(judgeProbeResponse(cut, NONCE, "198.51.100.9").kind).toBe("inconclusive");
    const badChunked = `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`;
    expect(judgeProbeResponse(badChunked, NONCE, "198.51.100.9").kind).toBe("tamper");
  });
  it("treats endpoint errors and cross-family egress as inconclusive", () => {
    expect(judgeProbeResponse(ok("203.0.113.5", NONCE, "503 Service Unavailable"), NONCE, "203.0.113.5").kind).toBe("inconclusive");
    expect(judgeProbeResponse(ok("2001:db8::1"), NONCE, "203.0.113.5").kind).toBe("inconclusive");
  });
});

describe("PROBE_URL parsing", () => {
  it("parses http(s) targets and rejects unsafe forms", () => {
    expect(parseProbeUrl(undefined)).toBeNull();
    expect(parseProbeUrl("https://api.example.com/v1/probe/echo")).toEqual({ host: "api.example.com", port: 443, path: "/v1/probe/echo", tls: true });
    expect(() => parseProbeUrl("ftp://x/")).toThrow();
    expect(() => parseProbeUrl("https://u:p@x/")).toThrow();
    expect(() => parseProbeUrl("https://x/?a=1")).toThrow();
  });
});

function node(id: string, ip: string): ProbeNode {
  return { nodeId: id, ip, openStream: vi.fn().mockResolvedValue(new Duplex({ read() {}, write(_c, _e, cb) { cb(); } })) };
}

describe("probe job", () => {
  it("quarantines a tampering node only, after two separate runs", async () => {
    const quarantine = vi.fn().mockResolvedValue(null);
    const good = node("good", "203.0.113.5");
    const bad = node("bad", "203.0.113.6");
    const ex = vi.fn(async (_s: Duplex, _t: unknown, nonce: string) => ok("203.0.113.5", nonce));
    const strikes = new TamperStrikes();
    const deps = { target, listNodes: () => [good, bad], quarantine, exchange: ex as typeof exchange, nonce: () => NONCE, strikes };
    const r1 = await runOnce(deps);
    expect(r1).toMatchObject({ tampered: 1 });
    expect(quarantine).not.toHaveBeenCalled();
    const r = await runOnce(deps);
    expect(good.openStream).toHaveBeenCalledWith("api.example.com", 80);
    expect(quarantine).toHaveBeenCalledTimes(1);
    expect(quarantine).toHaveBeenCalledWith("bad", "egress ip mismatch");
    expect(r).toMatchObject({ probed: 2, ok: 1, tampered: 1 });
  });
  it("an ok verdict between tamper verdicts resets the strike count", async () => {
    const quarantine = vi.fn();
    const n = node("n", "203.0.113.6");
    const strikes = new TamperStrikes();
    let ip = "203.0.113.5";
    const ex = vi.fn(async (_s: Duplex, _t: unknown, nonce: string) => ok(ip, nonce));
    const deps = { target, listNodes: () => [n], quarantine, exchange: ex as typeof exchange, nonce: () => NONCE, strikes };
    await runOnce(deps);
    ip = "203.0.113.6";
    await runOnce(deps);
    ip = "203.0.113.5";
    await runOnce(deps);
    expect(quarantine).not.toHaveBeenCalled();
    expect(strikes.hit("n", 999)).toBe(2);
  });
  it("never quarantines on dial errors or timeouts", async () => {
    const quarantine = vi.fn();
    const n = node("n", "203.0.113.5");
    const r = await runOnce({ target, listNodes: () => [n], quarantine, exchange: vi.fn().mockRejectedValue(new Error("probe timeout")) as typeof exchange });
    expect(r.errors).toBe(1);
    expect(quarantine).not.toHaveBeenCalled();
  });
  it("egress verification: passes the echoed egress IP to onEgress (ok + other-family), never on tamper", async () => {
    const onEgress = vi.fn();
    const n = node("n", "203.0.113.5");
    let ip = "203.0.113.5";
    const ex = vi.fn(async (_s: Duplex, _t: unknown, nonce: string) => ok(ip, nonce));
    const deps = { target, listNodes: () => [n], quarantine: vi.fn(), exchange: ex as typeof exchange, nonce: () => NONCE, strikes: new TamperStrikes(), onEgress };
    await runOnce(deps);
    expect(onEgress).toHaveBeenLastCalledWith("n", "203.0.113.5");
    ip = "2a09:bac1::5"; // dual-stack node egressing over IPv6 (e.g. through WARP)
    await runOnce(deps);
    expect(onEgress).toHaveBeenLastCalledWith("n", "2a09:bac1::5");
    ip = "203.0.113.9"; // same-family mismatch = tamper: never classified
    await runOnce(deps);
    expect(onEgress).toHaveBeenCalledTimes(2);
  });
  it("onEgress failures do not break the run", async () => {
    const n = node("n", "203.0.113.5");
    const ex = vi.fn(async (_s: Duplex, _t: unknown, nonce: string) => ok("203.0.113.5", nonce));
    const r = await runOnce({ target, listNodes: () => [n], quarantine: vi.fn(), exchange: ex as typeof exchange, nonce: () => NONCE, onEgress: vi.fn().mockRejectedValue(new Error("db")) });
    expect(r.ok).toBe(1);
  });
  it("probes unverified (fresh) nodes first within the sample bound", async () => {
    const nodes = Array.from({ length: 10 }, (_, i) => ({ ...node(`n${i}`, "203.0.113.5"), unverified: i >= 8 }));
    const ex = vi.fn(async (_s: Duplex, _t: unknown, nonce: string) => ok("203.0.113.5", nonce));
    await runOnce({ target, listNodes: () => nodes, quarantine: vi.fn(), exchange: ex as typeof exchange, sampleSize: 2 });
    expect(nodes[8]!.openStream).toHaveBeenCalled();
    expect(nodes[9]!.openStream).toHaveBeenCalled();
    for (let i = 0; i < 8; i++) expect(nodes[i]!.openStream).not.toHaveBeenCalled();
  });
  it("respects the sample size", async () => {
    const nodes = Array.from({ length: 10 }, (_, i) => node(`n${i}`, "203.0.113.5"));
    const ex = vi.fn(async (_s: Duplex, _t: unknown, nonce: string) => ok("203.0.113.5", nonce));
    const r = await runOnce({ target, listNodes: () => nodes, quarantine: vi.fn(), exchange: ex as typeof exchange, sampleSize: 3 });
    expect(r.probed).toBe(3);
  });
});

describe("probe exchange", () => {
  it("sends a GET with the nonce and caps the response size", async () => {
    let written = "";
    const s = new Duplex({
      read() {},
      write(c, _e, cb) { written += c.toString(); this.push(Buffer.alloc(20_000, 0x61)); cb(); },
    });
    await expect(exchange(s, target, NONCE, 1000)).rejects.toThrow(/too large/);
    expect(written).toContain(`GET /v1/probe/echo?nonce=${NONCE} HTTP/1.1\r\nHost: api.example.com\r\n`);
  });
  it("returns the raw response", async () => {
    const s = new Duplex({ read() {}, write(_c, _e, cb) { this.push(ok("1.2.3.4")); this.push(null); cb(); } });
    expect((await exchange(s, target, NONCE, 1000)).toString()).toContain('"ip":"1.2.3.4"');
  });
});

describe("probe target rotation and connect queue", () => {
  it("parses a comma-separated PROBE_URL and picks targets at random per probe", async () => {
    const ts = parseProbeUrls("https://a.example.net/e, https://b.example.org/x");
    expect(ts.map((t) => t.host)).toEqual(["a.example.net", "b.example.org"]);
    expect(parseProbeUrls("")).toEqual([]);
    expect(() => parseProbeUrls("ftp://x")).toThrow();
    const seen = new Set<string>();
    const nodes = Array.from({ length: 40 }, (_, i) => ({ nodeId: `n${i}`, ip: "203.0.113.5", openStream: vi.fn(async (h: string) => { seen.add(h); return new Duplex({ read() {}, write(_c, _e, cb) { cb(); } }); }) }));
    const ex = vi.fn(async (_s: Duplex, _t: unknown, nonce: string) => ok("203.0.113.5", nonce));
    await runOnce({ targets: ts, listNodes: () => nodes, quarantine: vi.fn(), exchange: ex as typeof exchange, nonce: () => NONCE, sampleSize: 40, strikes: new TamperStrikes() });
    expect(seen).toEqual(new Set(["a.example.net", "b.example.org"]));
  });

  it("connect queue: probes each connect once, dedupes, rate-limits reconnects and caps concurrency", async () => {
    let t = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: (() => void)[] = [];
    const onEgress = vi.fn();
    const ex = vi.fn(async (_s: Duplex, _t: unknown, nonce: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => releases.push(r));
      inFlight--;
      return ok("203.0.113.5", nonce);
    });
    const q = new ConnectProbeQueue(
      { target, listNodes: () => [], quarantine: vi.fn(), exchange: ex as typeof exchange, nonce: () => NONCE, onEgress, strikes: new TamperStrikes() },
      { concurrency: 2, delayMs: 0, jitterMs: 0, minIntervalMs: 60_000, now: () => t },
    );
    const mk = (id: string) => ({ nodeId: id, ip: "203.0.113.5", openStream: vi.fn(async () => new Duplex({ read() {}, write(_c, _e, cb) { cb(); } })) });
    expect(q.enqueue(mk("a"))).toBe(true);
    expect(q.enqueue(mk("a"))).toBe(false); // dedupe while queued / rate limit
    expect(q.enqueue(mk("b"))).toBe(true);
    expect(q.enqueue(mk("c"))).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(maxInFlight).toBe(2);
    while (releases.length) { releases.shift()!(); await new Promise((r) => setTimeout(r, 5)); }
    expect(onEgress).toHaveBeenCalledTimes(3);
    t = 30_000;
    expect(q.enqueue(mk("a"))).toBe(false); // reconnect within the min interval
    t = 61_000;
    expect(q.enqueue(mk("a"))).toBe(true);
    q.stop();
  });
});

describe("pending nodes: retries, full coverage, self-check", () => {
  const stream = () => new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
  const pendingNode = (id: string, state: { pending: boolean }): ProbeNode => ({
    nodeId: id, ip: "203.0.113.5", unverified: true, isPending: () => state.pending, openStream: vi.fn(async () => stream()),
  });

  it("connect queue re-probes a pending node after a 502 until it is classified", async () => {
    const state = { pending: true };
    let calls = 0;
    const ex = vi.fn(async (_s: Duplex, _t: unknown, nonce: string) => (++calls === 1 ? "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n" : ok("203.0.113.5", nonce)));
    const onEgress = vi.fn(() => { state.pending = false; });
    const q = new ConnectProbeQueue(
      { target, listNodes: () => [], quarantine: vi.fn(), exchange: ex as typeof exchange, nonce: () => NONCE, onEgress, strikes: new TamperStrikes() },
      { delayMs: 0, jitterMs: 0, retryDelaysMs: [5] },
    );
    expect(q.enqueue(pendingNode("p", state))).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(ex).toHaveBeenCalledTimes(2);
    expect(onEgress).toHaveBeenCalledTimes(1);
    expect(state.pending).toBe(false);
    q.stop();
  });

  it("the min interval does not block a node that is still pending", async () => {
    let t = 0;
    const st = { pending: true };
    const n = pendingNode("x", st);
    const q = new ConnectProbeQueue(
      { target, listNodes: () => [], quarantine: vi.fn(), exchange: vi.fn(async () => "HTTP/1.1 502 X\r\n\r\n") as never, strikes: new TamperStrikes() },
      { delayMs: 0, jitterMs: 0, minIntervalMs: 60_000, retryDelaysMs: [1_000_000], now: () => t },
    );
    expect(q.enqueue(n)).toBe(true);
    t = 10;
    await new Promise((r) => setTimeout(r, 10));
    expect(q.enqueue(n)).toBe(true); // pending: not rate-limited
    st.pending = false;
    await new Promise((r) => setTimeout(r, 10));
    expect(q.enqueue(n)).toBe(false); // verified: rate-limited again
    q.stop();
  });

  it("a full queue never drops a pending node: it backs off (overflow metric) and is probed once the queue drains", async () => {
    const releases: Array<() => void> = [];
    const ex = vi.fn(async (_s: Duplex, _t: unknown, nonce: string) => { await new Promise<void>((r) => releases.push(r)); return ok("203.0.113.5", nonce); });
    const states = new Map<string, { pending: boolean }>();
    const onEgress = vi.fn(async (id: string) => { states.get(id)!.pending = false; });
    const q = new ConnectProbeQueue(
      { target, listNodes: () => [], quarantine: vi.fn(), exchange: ex as typeof exchange, nonce: () => NONCE, onEgress, strikes: new TamperStrikes() },
      { concurrency: 1, maxQueued: 1, delayMs: 0, jitterMs: 0, retryDelaysMs: [4] },
    );
    const mk = (id: string) => { const st = { pending: true }; states.set(id, st); return pendingNode(id, st); };
    expect(q.enqueue(mk("a"))).toBe(true); // in flight
    expect(q.enqueue(mk("b"))).toBe(true); // queued
    expect(q.enqueue(mk("c"))).toBe(true); // overflow, backing off
    expect(q.stats()).toMatchObject({ active: 1, queued: 1, overflow: 1, dropped: 0 });
    expect(q.enqueue(pendingNode("c", states.get("c")!))).toBe(true); // reconnect while backing off: not dropped, not doubled
    expect(q.stats()).toMatchObject({ overflow: 1, dropped: 0 });
    const verified = { nodeId: "v", ip: "203.0.113.5", isPending: () => false, openStream: vi.fn(async () => stream()) };
    expect(q.enqueue(verified)).toBe(false);
    expect(q.stats().dropped).toBe(1);
    for (let i = 0; i < 20 && onEgress.mock.calls.length < 3; i++) {
      releases.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(onEgress.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b", "c"]);
    expect(q.stats().overflow).toBe(0);
    q.stop();
  });

  it("probes pending nodes before re-verifying classified ones", async () => {
    const order: string[] = [];
    const ex = vi.fn(async (_s: Duplex, _t: unknown, nonce: string) => ok("203.0.113.5", nonce));
    const q = new ConnectProbeQueue(
      { target, listNodes: () => [], quarantine: vi.fn(), exchange: ex as typeof exchange, nonce: () => NONCE, onEgress: async (id) => { order.push(id); }, strikes: new TamperStrikes() },
      { concurrency: 1, delayMs: 1, jitterMs: 0 },
    );
    q.enqueue({ nodeId: "verified", ip: "203.0.113.5", isPending: () => false, openStream: vi.fn(async () => stream()) });
    q.enqueue(pendingNode("pending", { pending: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(order[0]).toBe("pending");
    q.stop();
  });

  it("connect probe start time is randomized within delay..delay+jitter", async () => {
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      for (let i = 0; i < 12; i++) {
        const q = new ConnectProbeQueue(
          { target, listNodes: () => [], quarantine: vi.fn(), exchange: vi.fn(async () => "HTTP/1.1 502 X\r\n\r\n") as never, strikes: new TamperStrikes() },
          { delayMs: 1_000, jitterMs: 10_000, retryDelaysMs: [1_000_000] },
        );
        const n = { nodeId: `j${i}`, ip: "203.0.113.5", openStream: vi.fn(async () => { starts.push(Date.now() - t0); return stream(); }) };
        const t0 = Date.now();
        q.enqueue(n);
        await vi.advanceTimersByTimeAsync(11_001);
        q.stop();
      }
      expect(starts).toHaveLength(12);
      for (const s of starts) expect(s >= 1_000 && s <= 11_000).toBe(true);
      expect(new Set(starts).size).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("periodic run probes every pending node beyond the sample size", async () => {
    const ex = vi.fn(async (_s: Duplex, _t: unknown, nonce: string) => ok("203.0.113.5", nonce));
    const nodes = Array.from({ length: 30 }, (_, i) => pendingNode(`p${i}`, { pending: true }));
    const r = await runOnce({ target, listNodes: () => nodes, quarantine: vi.fn(), exchange: ex as typeof exchange, nonce: () => NONCE, sampleSize: 5, strikes: new TamperStrikes() });
    expect(r.probed).toBe(30);
  });

  it("no probe (and so no tamper strike) while the echo self-check fails", async () => {
    const quarantine = vi.fn();
    const ex = vi.fn(async () => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    const deps = { target, listNodes: () => [pendingNode("a", { pending: true })], quarantine, exchange: ex as typeof exchange, isHealthy: () => false, strikes: new TamperStrikes() };
    await runOnce(deps);
    await runOnce(deps);
    expect(ex).not.toHaveBeenCalled();
    expect(quarantine).not.toHaveBeenCalled();
  });

  it("self-check: 200 echoing the nonce passes; 404, TLS errors and wrong nonce fail", async () => {
    const dial = async () => stream();
    const echo = vi.fn(async (_s: Duplex, _t: unknown, nonce: string) => ok("198.51.100.1", nonce));
    expect((await selfCheckTarget(target, 1000, dial, echo as typeof exchange)).ok).toBe(true);
    const r404 = await selfCheckTarget(target, 1000, dial, (async () => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n") as never);
    expect(r404).toEqual({ ok: false, reason: "status 404" });
    const rTls = await selfCheckTarget(target, 1000, dial, (async () => { throw new Error("self-signed certificate"); }) as never);
    expect(rTls.ok).toBe(false);
    expect((await selfCheckTarget(target, 1000, dial, (async () => ok("1.1.1.1", "other")) as never)).ok).toBe(false);
  });

  it("ProbeHealth keeps only passing targets in its live list", async () => {
    const t2 = { ...target, host: "b.example.com" };
    const h = new ProbeHealth([target, t2], async (t) => ({ ok: t.host === "b.example.com", reason: "x" }));
    expect(h.healthy).toBe(false);
    const failed = await h.refresh();
    expect(h.healthy).toBe(true);
    expect(h.live).toEqual([t2]);
    expect(failed).toHaveLength(1);
  });
});
