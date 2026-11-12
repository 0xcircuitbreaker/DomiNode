import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();

vi.mock("../db.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: () => ({
    connect: () => Promise.resolve({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: () => mockClientRelease(),
    }),
  }),
}));

import { getActivePolicy, publishPolicy, getPricing, getSplit, listTiers, getOwnerTier } from "./policy-repo.js";
import { DEFAULT_POLICY, policySha256, PolicyValidationError } from "../policy.js";

describe("policy-repo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    mockClientQuery.mockReset();
  });

  it("getActivePolicy returns default v0 when empty", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const p = await getActivePolicy();
    expect(p.version).toBe(0);
    expect(p.sha256).toBe(policySha256(DEFAULT_POLICY));
    expect(mockQuery.mock.calls[0][0]).not.toMatch(/\*/);
  });

  it("getActivePolicy returns latest row", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ version: 4, body: { plaintext: "deny" }, body_sha256: "a".repeat(64), created_at: new Date() }] });
    const p = await getActivePolicy();
    expect(p.version).toBe(4);
    expect(p.body.plaintext).toBe("deny");
  });

  it("publishPolicy inserts in a transaction with lock", async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR UPDATE")) return { rows: [{ version: 1, body: {}, body_sha256: "x".repeat(64), created_at: new Date() }] };
      if (sql.startsWith("INSERT")) return { rows: [{ version: 2 }] };
      return { rows: [] };
    });
    const r = await publishPolicy({ attestation: { minVersion: 2, text: "t" } }, "u1");
    expect(r.version).toBe(2);
    expect(r.previousVersion).toBe(1);
    expect(r.attestationRaised).toBe(true);
    const sqls = mockClientQuery.mock.calls.map((c) => c[0] as string);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(sqls).toContain("COMMIT");
    const ins = mockClientQuery.mock.calls.find((c) => (c[0] as string).startsWith("INSERT"))!;
    expect(ins[0]).toMatch(/RETURNING version$/);
    expect(ins[1][1]).toBe(r.sha256);
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it("publishPolicy rolls back on sanctions shrink vs current", async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR UPDATE")) return { rows: [{ version: 1, body: { sanctionedCountries: ["CU","IR","KP","RU","SY","BY"] }, body_sha256: "x".repeat(64), created_at: new Date() }] };
      return { rows: [] };
    });
    await expect(publishPolicy({}, null)).rejects.toBeInstanceOf(PolicyValidationError);
    const sqls = mockClientQuery.mock.calls.map((c) => c[0] as string);
    expect(sqls).toContain("ROLLBACK");
    expect(sqls.some((s) => s.startsWith("INSERT"))).toBe(false);
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it("publishPolicy rejects floor keys", async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });
    await expect(publishPolicy({ hardDenyPorts: [] }, null)).rejects.toThrow(/floor/);
  });

  it("getPricing prefers class, missing class gets the highest price, fails closed", async () => {
    const rows = [
      { ip_class: "any", price_per_gb_musd: "200000" },
      { ip_class: "dc", price_per_gb_musd: "200000" },
      { ip_class: "residential", price_per_gb_musd: "500000" },
    ];
    mockQuery.mockResolvedValueOnce({ rows });
    expect(await getPricing("residential")).toBe(500000n);
    mockQuery.mockResolvedValueOnce({ rows });
    expect(await getPricing("dc")).toBe(200000n);
    // mobile row missing: never the cheapest 'any' fallback
    mockQuery.mockResolvedValueOnce({ rows });
    expect(await getPricing("mobile")).toBe(500000n);
    // 'any' (unknown node class) is the highest configured price
    mockQuery.mockResolvedValueOnce({ rows });
    expect(await getPricing("any")).toBe(500000n);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getPricing("dc")).rejects.toThrow();
  });

  it("getSplit returns current and fails closed", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 3, node_share_bps: 2500, maturation_hours: 168, effective_from: new Date(0) }] });
    expect((await getSplit()).id).toBe(3);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getSplit()).rejects.toThrow();
  });

  it("tier readers map rows", async () => {
    const row = { id: 1, name: "probation", rank: 0, node_share_bps: 2500, min_tenure_days: 0, min_uptime_bps: 0, min_active_ips: 1, min_reputation: 3000, no_clawback_days: 0, hold_days: 14, max_nodes: 10, daily_withdraw_limit_musd: "50000000" };
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    const t = await listTiers();
    expect(t[0].dailyWithdrawLimitMusd).toBe(50000000n);
    mockQuery.mockResolvedValueOnce({ rows: [{ node_tier_id: null }] }).mockResolvedValueOnce({ rows: [row] });
    expect((await getOwnerTier("u")).nodeShareBps).toBe(2500);
    expect(mockQuery.mock.calls.at(-2)![0]).toMatch(/status = 'active'/);
    expect(mockQuery.mock.calls.at(-1)![0]).toMatch(/ORDER BY rank ASC LIMIT 1/);
    mockQuery.mockResolvedValueOnce({ rows: [{ node_tier_id: 1 }] }).mockResolvedValueOnce({ rows: [] });
    await expect(getOwnerTier("u")).rejects.toThrow(/not configured/);
  });

  it("getOwnerTier fails closed for missing or suspended users", async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getOwnerTier("ghost")).rejects.toThrow(/not active/);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("getOwnerTier uses assigned tier when set", async () => {
    mockQuery.mockReset();
    const row = { id: 2, name: "gold", rank: 2, node_share_bps: 5000, min_tenure_days: 0, min_uptime_bps: 0, min_active_ips: 1, min_reputation: 3000, no_clawback_days: 0, hold_days: 7, max_nodes: 10, daily_withdraw_limit_musd: "1" };
    mockQuery.mockResolvedValueOnce({ rows: [{ node_tier_id: 2 }] }).mockResolvedValueOnce({ rows: [row] });
    expect((await getOwnerTier("u")).nodeShareBps).toBe(5000);
    expect(mockQuery.mock.calls[1][1]).toEqual([2]);
  });
});
