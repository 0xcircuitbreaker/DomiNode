import { describe, it, expect } from "vitest";
import {
  NodeRegistry, ipPrefix, dayOf, type LiveNode, REP_BYTES_PER_POINT, REP_DISTINCT_REQUESTER_BONUS,
  REP_DISPUTE_PENALTY, REP_BURN_PENALTY, MAX_REPORTS_PER_REQUESTER_NODE_DAY, QUARANTINE_BELOW,
} from "./registry.js";

function node(id: string, reputation = 3000): LiveNode {
  const ip = "8.8.8.8";
  return {
    nodeId: id, tunnel: { openStreams: 0, isOpen: true, openStream: () => Promise.reject(new Error("x")), close() {} },
    ready: true, status: "active", ip, prefix24: ipPrefix(ip), asn: 1, country: "US", ipClass: "residential",
    ownerUserId: "o", ownerWallet: "0x", ownerTeamId: null, health: 1, reputation, maxStreams: 10, maxGbDay: 5,
    ports: [80, 443], bytesToday: 0, earningsTodayMusd: 0, day: dayOf(Date.now()), recentOpens: [], cooldownUntil: 0,
    cooldowns: new Map(), floorHashKnown: true, connectedAt: Date.now(),
  };
}

describe("NodeRegistry reputation & burn counters", () => {
  it("raises reputation with paid bytes and distinct requesters only", () => {
    const r = new NodeRegistry();
    r.add(node("a"));
    r.recordPaidBytes("a", "u1", REP_BYTES_PER_POINT * 2, "example.com");
    expect(r.get("a")!.reputation).toBe(3000 + 2 + REP_DISTINCT_REQUESTER_BONUS);
    r.recordPaidBytes("a", "u1", REP_BYTES_PER_POINT / 2);
    r.recordPaidBytes("a", "u1", REP_BYTES_PER_POINT / 2);
    expect(r.get("a")!.reputation).toBe(3000 + 3 + REP_DISTINCT_REQUESTER_BONUS);
    r.recordPaidBytes("a", "u1", -5);
    r.recordPaidBytes("missing", "u1", 10);
    const [f] = r.drainCounters();
    expect(f.counters.bytes).toBe(REP_BYTES_PER_POINT * 3);
    expect(f.counters.etld.get("example.com")).toEqual({ ok: 1, burn: 0 });
    expect(r.drainCounters()).toEqual([]);
  });

  it("penalizes disputes and burns, sets cooldown, clamps at 0, flags quarantine", () => {
    const now = 1_000_000_000;
    const r = new NodeRegistry(100, () => now);
    r.add(node("a", 1100));
    r.recordDispute("a");
    expect(r.get("a")!.reputation).toBe(1100 - REP_DISPUTE_PENALTY);
    expect(r.shouldQuarantine("a")).toBe(true);
    r.recordBurn("a", "Example.com", 0.5);
    expect(r.get("a")!.reputation).toBe(900 - REP_BURN_PENALTY / 2);
    expect(r.get("a")!.cooldowns.get("example.com")).toBeGreaterThan(now);
    for (let i = 0; i < 100; i++) r.recordDispute("a");
    expect(r.get("a")!.reputation).toBe(0);
    const [f] = r.drainCounters();
    expect(f).toMatchObject({ quarantine: true, reputation: 0 });
    expect(f.counters.burns).toBe(1);
    expect(QUARANTINE_BELOW).toBe(1000);
  });

  it("caps reports per requester per node per day and resets next day", () => {
    let now = 1_000_000_000;
    const r = new NodeRegistry(100, () => now);
    r.add(node("a"));
    for (let i = 0; i < MAX_REPORTS_PER_REQUESTER_NODE_DAY; i++) expect(r.recordReport("a", "u1", "x.com", 1)).toBe(true);
    expect(r.recordReport("a", "u1", "x.com", 1)).toBe(false);
    expect(r.recordReport("a", "u2", "x.com", 1)).toBe(true);
    expect(r.recordReport("nope", "u1", "x.com", 1)).toBe(false);
    now += 86_400_000;
    expect(r.recordReport("a", "u1", "x.com", 1)).toBe(true);
  });
});
