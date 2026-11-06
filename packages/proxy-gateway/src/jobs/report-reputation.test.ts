import { describe, it, expect, vi } from "vitest";
import { reportReputationRepo } from "@dominusnode/shared";
const { computeReportPenalties, DEFAULT_REPORT_PENALTY_PARAMS } = reportReputationRepo;
import * as job from "./report-reputation.js";
import * as repFlush from "./reputation-flush.js";
import { envInt } from "./runner.js";
import { NodeRegistry, effectiveReputation, QUARANTINE_BELOW, type LiveNode } from "../node-tunnel/registry.js";

const P = DEFAULT_REPORT_PENALTY_PARAMS;

describe("report-reputation job", () => {
  it("pages by node id until a short page and persists penalties", async () => {
    const pages = [
      { rows: [{ nodeId: "a", reporterUserId: "r", decayed: 1, spendMusd: P.fullWeightSpendMusd }, { nodeId: "b", reporterUserId: null, decayed: 0, spendMusd: 0n }], lastNodeId: "b", pageSize: 2 },
      { rows: [{ nodeId: "c", reporterUserId: "r", decayed: 2, spendMusd: 0n }], lastNodeId: "c", pageSize: 1 },
    ];
    const listAggregates = vi.fn(async (_after: string | null, _limit: number, _hl: number) => pages.shift()!);
    const apply = vi.fn(async (m: Map<string, number>) => m.size);
    const r = await job.runOnce({ listAggregates, compute: computeReportPenalties, apply, params: P, pageLimit: 2 });
    expect(listAggregates.mock.calls.map((c) => c[0])).toEqual([null, "b"]);
    expect(apply.mock.calls[0][0]).toEqual(new Map([["a", 100], ["b", 0]]));
    expect(apply.mock.calls[1][0]).toEqual(new Map([["c", 0]])); // zero-spend reporter
    expect(r).toEqual({ nodes: 3, updated: 3, pages: 2 });
  });

  it("stops on an empty page and respects maxPages", async () => {
    const listAggregates = vi.fn(async () => ({ rows: [], lastNodeId: null, pageSize: 0 }));
    expect(await job.runOnce({ listAggregates, compute: computeReportPenalties, apply: vi.fn(), params: P })).toEqual({ nodes: 0, updated: 0, pages: 1 });
    const full = vi.fn(async () => ({ rows: [{ nodeId: "x", reporterUserId: null, decayed: 0, spendMusd: 0n }], lastNodeId: "x", pageSize: 1 }));
    const r = await job.runOnce({ listAggregates: full, compute: computeReportPenalties, apply: vi.fn(async () => 0), params: P, pageLimit: 1, maxPages: 3 });
    expect(r.pages).toBe(3);
  });

  it("paramsFromEnv validates and converts cents to µUSD", () => {
    const p = job.paramsFromEnv({ REPORT_FULL_WEIGHT_SPEND_CENTS: "500", REPORT_HALF_LIFE_DAYS: "3" }, envInt, P);
    expect(p.fullWeightSpendMusd).toBe(5_000_000n);
    expect(p.halfLifeDays).toBe(3);
    expect(() => job.paramsFromEnv({ REPORT_HALF_LIFE_DAYS: "abc" }, envInt, P)).toThrow();
    expect(() => job.paramsFromEnv({ REPORT_MAX_PENALTY: "20000" }, envInt, P)).toThrow();
  });
});

function node(id: string, reputation: number): LiveNode {
  return {
    nodeId: id, tunnel: { openStream: async () => { throw new Error("x"); }, openStreams: 0, isOpen: true, close: () => {} },
    ready: true, status: "active", ip: "8.8.8.8", prefix24: "8.8.8.0/24", asn: null, country: "US", ipClass: "residential",
    ownerUserId: "o", ownerWallet: "0x", ownerTeamId: null, health: 1, reputation, maxStreams: 8, maxGbDay: 5, ports: [443],
    bytesToday: 0, earningsTodayMusd: 0, day: 0, recentOpens: [], cooldownUntil: 0, cooldowns: new Map(), floorHashKnown: true, connectedAt: 0,
  };
}

describe("registry report penalties", () => {
  it("report penalty alone never quarantines: it raises a review flag; base reputation still quarantines", () => {
    const r = new NodeRegistry();
    r.add(node("n1", QUARANTINE_BELOW + 500));
    expect(r.shouldQuarantine("n1")).toBe(false);
    r.setReportPenalties(["n1", "gone"], new Map([["n1", 600]]));
    expect(effectiveReputation(r.get("n1")!)).toBe(QUARANTINE_BELOW - 100);
    expect(r.shouldQuarantine("n1")).toBe(false);
    expect(r.needsReportReview("n1")).toBe(true);
    r.recordFailure("n1");
    const flushed = r.drainCounters().find((f) => f.nodeId === "n1")!;
    expect(flushed.reputation).toBeGreaterThan(QUARANTINE_BELOW);
    expect(flushed.quarantine).toBe(false);
    expect(flushed.reviewFlag).toBe(true);
    expect(flushed.reportPenalty).toBe(600);
    r.setReportPenalties(["n1"], new Map());
    expect(r.needsReportReview("n1")).toBe(false);

    r.add(node("n2", QUARANTINE_BELOW - 1));
    expect(r.shouldQuarantine("n2")).toBe(true);
    expect(r.needsReportReview("n2")).toBe(false);
  });

  it("reputation flush flags penalty-driven drops for review instead of quarantining", async () => {
    const quarantine = vi.fn();
    const flagReview = vi.fn().mockResolvedValue(true);
    const etld = new Map();
    const c = { bytes: 0, streams: 0, failures: 0, burns: 0, disputes: 0, etld };
    const res = await repFlush.runOnce({
      drain: () => [{ nodeId: "n1", day: 1, reputation: 1500, quarantine: false, reviewFlag: true, reportPenalty: 600, counters: c }],
      flushHealth: vi.fn().mockResolvedValue(1), quarantine, flagReview,
    });
    expect(quarantine).not.toHaveBeenCalled();
    expect(flagReview).toHaveBeenCalledWith("n1", 600);
    expect(res.reviewFlagged).toBe(1);
  });

  it("reputation flush refreshes penalties first and survives a refresh failure", async () => {
    const order: string[] = [];
    await repFlush.runOnce({
      refreshPenalties: async () => { order.push("refresh"); throw new Error("db down"); },
      drain: () => { order.push("drain"); return []; },
      flushHealth: vi.fn(), quarantine: vi.fn(),
    });
    expect(order).toEqual(["refresh", "drain"]);
  });
});
