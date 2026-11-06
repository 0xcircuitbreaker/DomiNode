import { describe, it, expect, vi, beforeEach } from "vitest";
const mockQuery = vi.fn();
vi.mock("../db.js", () => ({ query: (...a: unknown[]) => mockQuery(...a), getPool: () => ({ connect: vi.fn() }) }));
import {
  computeReportPenalties, reporterWeight, listReportAggregates, applyReportPenalties, getReportPenalties,
  DEFAULT_REPORT_PENALTY_PARAMS as P, type ReportAggregate,
} from "./report-reputation-repo.js";

const N1 = "00000000-0000-4000-8000-000000000001";
const N2 = "00000000-0000-4000-8000-000000000002";
const row = (nodeId: string, reporter: string | null, decayed: number, spendMusd: bigint): ReportAggregate => ({ nodeId, reporterUserId: reporter, decayed, spendMusd });

beforeEach(() => mockQuery.mockReset());

describe("reporterWeight", () => {
  it("is 0 with no spend and saturates at the full-weight spend", () => {
    expect(reporterWeight(0n, P)).toBe(0);
    expect(reporterWeight(-5n, P)).toBe(0);
    expect(reporterWeight(P.fullWeightSpendMusd / 2n, P)).toBeCloseTo(0.5);
    expect(reporterWeight(P.fullWeightSpendMusd * 100n, P)).toBe(1);
  });
});

describe("computeReportPenalties", () => {
  it("zero-spend reporters contribute nothing", () => {
    const m = computeReportPenalties([row(N1, "a", 5, 0n), row(N1, "b", 5, 0n)], P);
    expect(m.get(N1)).toBe(0);
  });

  it("weights by spend and caps each reporter's contribution", () => {
    const full = P.fullWeightSpendMusd;
    // 50 decayed reports from one full-weight reporter count as maxPerReporter.
    expect(computeReportPenalties([row(N1, "a", 50, full)], P).get(N1)).toBe(P.maxPerReporter * P.pointsPerReport);
    // Half-weight reporter, 2 reports.
    expect(computeReportPenalties([row(N1, "a", 2, full / 2n)], P).get(N1)).toBe(100);
  });

  it("caps the per-node penalty", () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(N1, `r${i}`, 3, P.fullWeightSpendMusd));
    expect(computeReportPenalties(rows, P).get(N1)).toBe(P.maxPenalty);
  });

  it("decay reduces impact; nodes without counted reports reset to 0", () => {
    const m = computeReportPenalties([row(N1, "a", 0.25, P.fullWeightSpendMusd), row(N2, null, 0, 0n)], P);
    expect(m.get(N1)).toBe(25);
    expect(m.get(N2)).toBe(0);
  });

  it("ignores non-finite decay values", () => {
    expect(computeReportPenalties([row(N1, "a", Number.NaN, P.fullWeightSpendMusd)], P).get(N1)).toBe(0);
  });
});

describe("SQL", () => {
  it("listReportAggregates excludes self/team reports, uses a 30-day window, caps the page", async () => {
    mockQuery.mockResolvedValue({ rows: [
      { node_id: N1, reporter_user_id: "a", decayed: 1.5, musd: "123" },
      { node_id: N2, reporter_user_id: null, decayed: null, musd: null },
    ] });
    const r = await listReportAggregates(null, 5000, 7);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/reporter_user_id <> p\.owner_user_id/);
    expect(sql).toMatch(/team_members a JOIN team_members b/);
    expect(sql).toMatch(/node_owner_user_id IS DISTINCT FROM a\.reporter_user_id/);
    // Spend counted on the reported node only, not total account spend.
    expect(sql).toMatch(/rc\.node_id = a\.node_id/);
    // Circular flow: owner paid the reporter's nodes -> reporter spend excluded.
    expect(sql).toMatch(/back\.requester_user_id = p\.owner_user_id[\s\S]*back\.node_owner_user_id = a\.reporter_user_id/);
    expect(sql).toMatch(/sp\.node_id = a\.node_id AND sp\.reporter_user_id = a\.reporter_user_id/);
    expect(sql).toMatch(/NOT rc\.disputed/);
    expect(sql).not.toMatch(/SELECT \*/);
    expect(params).toEqual([null, 1000, 30, 7]);
    expect(r.pageSize).toBe(2);
    expect(r.lastNodeId).toBe(N2);
    expect(r.rows[0]).toEqual({ nodeId: N1, reporterUserId: "a", decayed: 1.5, spendMusd: 123n });
    expect(r.rows[1].spendMusd).toBe(0n);
  });

  it("applyReportPenalties clamps and only writes changes", async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    expect(await applyReportPenalties(new Map([[N1, 99999], [N2, -3]]))).toBe(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/IS DISTINCT FROM v\.p/);
    expect(params).toEqual([[N1, N2], [10000, 0]]);
    expect(await applyReportPenalties(new Map())).toBe(0);
  });

  it("getReportPenalties maps rows", async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: N1, report_penalty: 300 }] });
    const m = await getReportPenalties([N1, N2]);
    expect(m.get(N1)).toBe(300);
    expect(m.has(N2)).toBe(false);
    expect(await getReportPenalties([])).toEqual(new Map());
  });
});
