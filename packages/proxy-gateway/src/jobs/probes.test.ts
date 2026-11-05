import { describe, it, expect, vi } from "vitest";
import { Duplex } from "node:stream";
import { judgeProbeResponse, parseProbeUrl, runOnce, exchange, type ProbeNode } from "./probes.js";

const NONCE = "n".repeat(24);
const ok = (ip: string, nonce = NONCE, status = "200 OK") =>
  `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ ip, nonce })}`;
const target = { host: "api.example.com", port: 80, path: "/v1/probe/echo", tls: false };

describe("canary probe judging", () => {
  it("passes when nonce and egress IP match", () => {
    expect(judgeProbeResponse(ok("203.0.113.5"), NONCE, "203.0.113.5")).toEqual({ kind: "ok" });
    expect(judgeProbeResponse(ok("203.0.113.5"), NONCE, "::ffff:203.0.113.5")).toEqual({ kind: "ok" });
  });
  it("flags a nonce mismatch, a same-family IP mismatch and malformed replies as tamper", () => {
    expect(judgeProbeResponse(ok("203.0.113.5", "x".repeat(24)), NONCE, "203.0.113.5").kind).toBe("tamper");
    expect(judgeProbeResponse(ok("198.51.100.1"), NONCE, "203.0.113.5").kind).toBe("tamper");
    expect(judgeProbeResponse("garbage", NONCE, "203.0.113.5").kind).toBe("tamper");
    expect(judgeProbeResponse("HTTP/1.1 200 OK\r\n\r\n<html>", NONCE, "203.0.113.5").kind).toBe("tamper");
    expect(judgeProbeResponse(ok("203.0.113.5", NONCE, "302 Found"), NONCE, "203.0.113.5").kind).toBe("tamper");
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
  it("quarantines a tampering node only", async () => {
    const quarantine = vi.fn().mockResolvedValue(null);
    const good = node("good", "203.0.113.5");
    const bad = node("bad", "203.0.113.6");
    const ex = vi.fn(async (_s: Duplex, _t: unknown, nonce: string) => ok("203.0.113.5", nonce));
    const r = await runOnce({ target, listNodes: () => [good, bad], quarantine, exchange: ex as typeof exchange, nonce: () => NONCE });
    expect(good.openStream).toHaveBeenCalledWith("api.example.com", 80);
    expect(quarantine).toHaveBeenCalledTimes(1);
    expect(quarantine).toHaveBeenCalledWith("bad", "egress ip mismatch");
    expect(r).toMatchObject({ probed: 2, ok: 1, tampered: 1 });
  });
  it("never quarantines on dial errors or timeouts", async () => {
    const quarantine = vi.fn();
    const n = node("n", "203.0.113.5");
    const r = await runOnce({ target, listNodes: () => [n], quarantine, exchange: vi.fn().mockRejectedValue(new Error("probe timeout")) as typeof exchange });
    expect(r.errors).toBe(1);
    expect(quarantine).not.toHaveBeenCalled();
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
    expect(await exchange(s, target, NONCE, 1000)).toContain('"ip":"1.2.3.4"');
  });
});
