import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, type NetworkPolicy } from "@dominusnode/shared";
import { NodeRegistry, ipPrefix, dayOf, type LiveNode, type NodeTunnelHandle } from "./registry.js";
import { NodeSelector, NodeSelectionError, etld1, type SelectOpts } from "./selector.js";

function tunnel(open = 0): NodeTunnelHandle & { openStreams: number; isOpen: boolean } {
  return { openStreams: open, isOpen: true, openStream: () => Promise.reject(new Error("x")), close() { this.isOpen = false; } };
}

let seq = 0;
function node(over: Partial<LiveNode> = {}): LiveNode {
  const id = over.nodeId ?? `n${++seq}`;
  const ip = over.ip ?? `8.8.${seq % 250}.${(seq * 7) % 250}`;
  return {
    nodeId: id, tunnel: tunnel(), ready: true, status: "active", ip, prefix24: ipPrefix(ip), asn: 1, country: "US",
    ipClass: "residential", ownerUserId: `owner-${id}`, ownerWallet: `0x${id}`, ownerTeamId: null, health: 1,
    reputation: 5000, maxStreams: 10, maxGbDay: 5, ports: [80, 443], bytesToday: 0, earningsTodayMusd: 0,
    day: dayOf(Date.now()), recentOpens: [], cooldownUntil: 0, cooldowns: new Map(), floorHashKnown: true,
    connectedAt: Date.now(), ...over,
  };
}

const base: SelectOpts = { requesterUserId: "req", clientIp: "1.2.3.4", targetHost: "www.example.com", port: 443 };

function make(nodes: LiveNode[], policy: NetworkPolicy = DEFAULT_POLICY, random = () => 0) {
  const reg = new NodeRegistry();
  for (const n of nodes) reg.add(n);
  return { reg, sel: new NodeSelector(reg, { getPolicy: () => policy, random }) };
}

describe("etld1", () => {
  it("reduces hosts", () => {
    expect(etld1("a.b.example.com")).toBe("example.com");
    expect(etld1("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(etld1("1.2.3.4")).toBe("1.2.3.4");
  });
});

describe("NodeSelector", () => {
  it("never routes a target to the node's own egress address (hairpin)", () => {
    const { sel } = make([node({ nodeId: "self", ip: "203.0.113.7" }), node({ nodeId: "other", ip: "198.51.100.9" })]);
    for (let i = 0; i < 5; i++) {
      expect(sel.select({ ...base, targetHost: "203.0.113.7" }).nodeId).toBe("other");
      expect(sel.select({ ...base, targetHost: "router.example", targetAddresses: ["::ffff:203.0.113.7"] }).nodeId).toBe("other");
    }
    const { sel: only } = make([node({ nodeId: "self", ip: "203.0.113.7" })]);
    expect(() => only.select({ ...base, targetHost: "203.0.113.7" })).toThrow(NodeSelectionError);
  });
  it("excludeIpClasses skips nodes of paused exit classes (kill switch)", () => {
    const { sel } = make([node({ nodeId: "dc", ipClass: "dc" }), node({ nodeId: "res", ipClass: "residential" })]);
    for (let i = 0; i < 5; i++) expect(sel.select({ ...base, excludeIpClasses: ["dc"] }).nodeId).toBe("res");
    expect(() => sel.select({ ...base, excludeIpClasses: ["dc", "residential"] })).toThrow(NodeSelectionError);
  });
  it("seedOnly restricts selection to operator-run nodes", () => {
    const { sel } = make([node({ nodeId: "community" }), node({ nodeId: "seed", operatorRun: true })]);
    for (let i = 0; i < 5; i++) expect(sel.select({ ...base, seedOnly: true }).nodeId).toBe("seed");
    const { sel: none } = make([node({ nodeId: "community" })]);
    expect(() => none.select({ ...base, seedOnly: true })).toThrow(NodeSelectionError);
  });

  it("403 for a sanctioned requested country", () => {
    const { sel } = make([node()]);
    const e = (() => { try { sel.select({ ...base, country: "ir" }); } catch (x) { return x; } })();
    expect(e).toBeInstanceOf(NodeSelectionError);
    expect((e as NodeSelectionError).status).toBe(403);
  });

  it("honours an owner-lowered req/s cap from the DB row", () => {
    const now = Date.now();
    const { sel } = make([node({ maxReqPerSec: 2, recentOpens: [now, now] })]);
    expect(() => sel.select({ ...base })).toThrow(NodeSelectionError);
    const { sel: ok } = make([node({ maxReqPerSec: 3, recentOpens: [now, now] })]);
    expect(ok.select({ ...base })).toBeTruthy();
  });

  it("503 NO_NODES_AVAILABLE when nothing matches", () => {
    const { sel } = make([node({ country: "DE" })]);
    try {
      sel.select({ ...base, country: "US" });
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ status: 503, code: "NO_NODES_AVAILABLE" });
    }
  });

  it("filters self-dealing by owner, wallet, team and /24", () => {
    const cases: Array<[Partial<LiveNode>, Partial<SelectOpts>]> = [
      [{ ownerUserId: "req" }, {}],
      [{ ownerWallet: "0xABC" }, { requesterWallet: "0xabc" }],
      [{ ownerTeamId: "t1" }, { requesterTeamId: "t1" }],
      [{ ip: "1.2.3.99", prefix24: ipPrefix("1.2.3.99") }, {}],
    ];
    for (const [n, o] of cases) {
      const { sel } = make([node(n)]);
      expect(() => sel.select({ ...base, ...o })).toThrow(NodeSelectionError);
    }
  });

  it("filters status, readiness, sanctions, class, caps, ports, cooldowns and excludes", () => {
    const now = Date.now();
    const bad: Partial<LiveNode>[] = [
      { status: "quarantined" }, { ready: false }, { country: "CU" }, { ipClass: "dc" },
      { tunnel: tunnel(10) }, { bytesToday: 6e9 }, { ports: [80] }, { cooldownUntil: now + 60_000 },
      { cooldowns: new Map([["example.com", now + 60_000]]) }, { nodeId: "excluded" },
    ];
    for (const b of bad) {
      const { sel } = make([node(b)]);
      expect(() => sel.select({ ...base, ipClass: "residential", excludeNodeIds: ["excluded"] })).toThrow(NodeSelectionError);
    }
    const { sel } = make([node()]);
    expect(sel.select({ ...base, ipClass: "residential" })).toBeDefined();
  });

  it("policy port list gates selection", () => {
    const { sel } = make([node()], { ...DEFAULT_POLICY, ports: [443] });
    expect(() => sel.select({ ...base, port: 80 })).toThrow(NodeSelectionError);
  });

  it("scores reputation, health and load; picks weighted from top K", () => {
    const good = node({ reputation: 9000 });
    const weak = node({ reputation: 1000 });
    const { sel } = make([weak, good]);
    expect(sel.score(good, 0)).toBeGreaterThan(sel.score(weak, 0));
    expect(sel.select(base).nodeId).toBe(good.nodeId); // random()=0 -> highest weight
    const busy = node({ tunnel: tunnel(3) });
    expect(sel.score(busy, 0)).toBeCloseTo(sel.score(node(), 0) / 4);
    expect(sel.score(node({ earningsTodayMusd: 400 }), 100)).toBeCloseTo(sel.score(node(), 100) / 2);
  });

  it("sticky sessions reuse the node until it becomes ineligible", () => {
    const a = node({ reputation: 9000 });
    const b = node({ reputation: 8000 });
    let r = 0.99;
    const { sel } = make([a, b], DEFAULT_POLICY, () => r);
    const first = sel.select({ ...base, sticky: "s1" });
    r = 0;
    expect(sel.select({ ...base, sticky: "s1" }).nodeId).toBe(first.nodeId);
    first.status = "cooldown";
    expect(sel.select({ ...base, sticky: "s1" }).nodeId).not.toBe(first.nodeId);
  });

  it("sticky LRU is capped and expires", () => {
    let t = 1_000_000;
    const reg = new NodeRegistry();
    reg.add(node());
    const sel = new NodeSelector(reg, { getPolicy: () => DEFAULT_POLICY, stickyCap: 2, stickyTtlMs: 100, now: () => t });
    for (const k of ["a", "b", "c"]) sel.select({ ...base, sticky: k });
    expect(sel.stickySize).toBe(2);
    t += 200;
    sel.sweepSticky();
    expect(sel.stickySize).toBe(0);
  });
});

describe("NodeRegistry", () => {
  it("caps size, indexes by country and replaces by id", () => {
    const reg = new NodeRegistry(2);
    reg.add(node({ nodeId: "a", country: "US" }));
    reg.add(node({ nodeId: "b", country: "DE" }));
    expect(() => reg.add(node({ nodeId: "c" }))).toThrow();
    const prev = reg.add(node({ nodeId: "a", country: "FR" }));
    expect(prev?.country).toBe("US");
    expect(reg.inCountry("us")).toHaveLength(0);
    expect(reg.inCountry("FR")).toHaveLength(1);
  });

  it("only removes when the tunnel matches", () => {
    const reg = new NodeRegistry();
    const n = node({ nodeId: "a" });
    reg.add(n);
    expect(reg.remove("a", tunnel())).toBe(false);
    expect(reg.remove("a", n.tunnel)).toBe(true);
  });

  it("counts peers for sybil caps", () => {
    const reg = new NodeRegistry();
    reg.add(node({ nodeId: "a", ip: "9.9.9.1", prefix24: ipPrefix("9.9.9.1"), asn: 7 }));
    reg.add(node({ nodeId: "b", ip: "9.9.9.2", prefix24: ipPrefix("9.9.9.2"), asn: 7 }));
    expect(reg.countPeers("9.9.9.1", "9.9.9.0/24", 7)).toEqual({ per32: 1, per24: 2, perAsn: 2 });
    expect(reg.countPeers("9.9.9.1", "9.9.9.0/24", 7, "a")).toEqual({ per32: 0, per24: 1, perAsn: 1 });
  });

  it("counts unknown-ASN peers in one shared bucket (ASN cap is never skipped)", () => {
    const reg = new NodeRegistry();
    reg.add(node({ nodeId: "a", ip: "8.8.1.1", prefix24: ipPrefix("8.8.1.1"), asn: null }));
    reg.add(node({ nodeId: "b", ip: "8.8.2.1", prefix24: ipPrefix("8.8.2.1"), asn: null }));
    reg.add(node({ nodeId: "c", ip: "8.8.3.1", prefix24: ipPrefix("8.8.3.1"), asn: 9 }));
    expect(reg.countPeers("8.8.4.1", "8.8.4.0/24", null).perAsn).toBe(2);
  });

  it("a node whose egress probe is pending serves nothing, flagged or unflagged", () => {
    const { sel } = make([node({ ipClass: "unknown", probePending: true })]);
    expect(() => sel.select(base)).toThrow(NodeSelectionError);
    expect(() => sel.select({ ...base, ipClass: "residential" })).toThrow(NodeSelectionError);
  });

  it("unclassified nodes are not selected for an explicit class", () => {
    const { sel } = make([node({ ipClass: "unknown" })]);
    expect(() => sel.select({ ...base, ipClass: "residential" })).toThrow(NodeSelectionError);
    expect(sel.select(base)).toBeDefined();
  });

  it("masked nodes serve only explicit class-masked requests", () => {
    const { sel } = make([node({ nodeId: "warp", ipClass: "masked" })]);
    expect(() => sel.select(base)).toThrow(NodeSelectionError); // unflagged never lands on masked
    for (const c of ["residential", "mobile", "dc"] as const) {
      expect(() => sel.select({ ...base, ipClass: c })).toThrow(NodeSelectionError);
    }
    expect(sel.select({ ...base, ipClass: "masked" }).nodeId).toBe("warp");
    const { sel: mixed } = make([node({ nodeId: "warp", ipClass: "masked" }), node({ nodeId: "home", ipClass: "residential" })]);
    for (let i = 0; i < 5; i++) expect(mixed.select(base).nodeId).toBe("home");
    for (let i = 0; i < 5; i++) expect(mixed.select({ ...base, ipClass: "masked" }).nodeId).toBe("warp");
  });

  it("sweep drops closed tunnels, expired cooldowns and rolls the day", () => {
    let t = 10 * 86_400_000;
    const reg = new NodeRegistry(10, () => t);
    const a = node({ nodeId: "a", day: dayOf(t), bytesToday: 5 });
    const b = node({ nodeId: "b" });
    reg.add(a);
    reg.add(b);
    reg.setBurnCooldown("a", "x.com", t + 10);
    b.tunnel.close();
    t += 86_400_000;
    expect(reg.sweep()).toBe(1);
    expect(reg.get("b")).toBeUndefined();
    expect(a.cooldowns.size).toBe(0);
    expect(a.bytesToday).toBe(0);
  });

  it("ipPrefix handles v4, mapped v4 and v6", () => {
    expect(ipPrefix("1.2.3.4")).toBe("1.2.3.0/24");
    expect(ipPrefix("::ffff:1.2.3.4")).toBe("1.2.3.0/24");
    expect(ipPrefix("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
  });
});
