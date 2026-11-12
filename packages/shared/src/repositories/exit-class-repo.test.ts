import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockConnect = vi.fn();

vi.mock("../db.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: () => ({ connect: () => mockConnect() }),
}));

import { recordVerifiedClass, registerNode, markOnline } from "./node-repo.js";
import { getPricing, listPricing } from "./policy-repo.js";
import { activeIpsFromWeightBps, getChargeSnapshot, getOwnerTierStats, getTierWeights } from "./tier-repo.js";

const U = "11111111-1111-1111-1111-111111111111";
const N = "22222222-2222-2222-2222-222222222222";
const W = "0x" + "b".repeat(40);
const SIG = "0x" + "c".repeat(130);

const sqls = () => mockClientQuery.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  mockQuery.mockReset();
  mockClientQuery.mockReset();
  mockConnect.mockReset();
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: vi.fn() });
});

describe("recordVerifiedClass", () => {
  it("downgrade below the declared class sets the verified class and opens an egress_mismatch flag in one tx", async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT owner_user_id")) return { rows: [{ owner_user_id: U, ip_class: "residential", declared_class: "residential" }] };
      return { rows: [], rowCount: 1 };
    });
    const r = await recordVerifiedClass(N, "masked");
    expect(r).toEqual({ updated: true, previousClass: "residential", declaredClass: "residential", flagged: true });
    const s = sqls();
    expect(s[0]).toBe("BEGIN");
    expect(s[1]).toContain("FOR UPDATE");
    expect(s[2]).toContain("UPDATE nodes SET ip_class = $2");
    expect(mockClientQuery.mock.calls[2][1]).toEqual([N, "masked", null]);
    expect(s[3]).toContain("'egress_mismatch'");
    expect(s[3]).toContain("ON CONFLICT");
    expect(s[4]).toBe("COMMIT");
  });

  it("no flag when nothing was declared or the verified class is not lower", async () => {
    for (const [declared, verified] of [[null, "masked"], ["dc", "residential"], ["masked", "masked"], ["residential", "unknown"]] as const) {
      mockClientQuery.mockReset();
      mockClientQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT owner_user_id")) return { rows: [{ owner_user_id: U, ip_class: "residential", declared_class: declared }] };
        return { rows: [] };
      });
      const r = await recordVerifiedClass(N, verified);
      expect(r.flagged).toBe(false);
      expect(sqls().some((x) => x.includes("collusion_flags"))).toBe(false);
    }
  });

  it("persists the probe verdict and flags a drop below the connect-time class even with no declared class", async () => {
    mockClientQuery.mockReset();
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT owner_user_id")) return { rows: [{ owner_user_id: U, ip_class: "residential", declared_class: null }] };
      return { rows: [], rowCount: 1 };
    });
    const r = await recordVerifiedClass(N, "masked", { probeClass: "masked", connectClass: "residential" });
    expect(r.flagged).toBe(true);
    const upd = mockClientQuery.mock.calls.find((c) => String(c[0]).includes("probe_class = COALESCE"))!;
    expect(upd[1]).toEqual([N, "masked", "masked"]);
    expect(sqls().some((x) => x.includes("'egress_mismatch'"))).toBe(true);
  });

  it("missing/revoked node rolls back; invalid input throws", async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });
    expect((await recordVerifiedClass(N, "dc")).updated).toBe(false);
    expect(sqls()).toContain("ROLLBACK");
    await expect(recordVerifiedClass(N, "vpn" as never)).rejects.toThrow("Invalid ip class");
    await expect(recordVerifiedClass("x", "dc")).rejects.toThrow();
  });
});

describe("registerNode declaredClass", () => {
  it("stores a valid declared class and rejects anything else", async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users")) return { rows: [{ status: "active", tier_name: "probation", max_nodes: 10 }] };
      if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
      if (sql.includes("INSERT INTO nodes")) return { rows: [{ id: N, declared_class: "residential" }] };
      return { rows: [] };
    });
    const r = await registerNode({ ownerUserId: U, ownerWallet: W, attestationVersion: 1, attestationSig: SIG, declaredClass: "residential" });
    expect(r.ok).toBe(true);
    const ins = mockClientQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO nodes"))!;
    expect(String(ins[0])).toContain("declared_class");
    expect((ins[1] as unknown[])[8]).toBe("residential");
    await expect(registerNode({ ownerUserId: U, ownerWallet: W, attestationVersion: 1, attestationSig: SIG, declaredClass: "unknown" as never }))
      .rejects.toThrow("Invalid declared class");
  });
});

describe("markOnline", () => {
  it("accepts masked and stamps class_verified_at", async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });
    expect(await markOnline(N, "104.28.1.1", "US", 13335, "masked")).toBe(true);
    expect(String(mockQuery.mock.calls[0][0])).toContain("class_verified_at");
    expect(mockQuery.mock.calls[0][1]).toEqual([N, "104.28.1.1", "US", 13335, "masked"]);
  });
});

describe("pricing per class", () => {
  const rows = [
    { ip_class: "any", price_per_gb_musd: "200000" },
    { ip_class: "residential", price_per_gb_musd: "500000" },
    { ip_class: "mobile", price_per_gb_musd: "500000" },
    { ip_class: "dc", price_per_gb_musd: "200000" },
    { ip_class: "masked", price_per_gb_musd: "100000" },
  ];
  it("masked has its own (cheapest) price; any = highest", async () => {
    mockQuery.mockResolvedValue({ rows });
    expect(await getPricing("masked")).toBe(100_000n);
    expect(await getPricing("dc")).toBe(200_000n);
    expect(await getPricing("residential")).toBe(500_000n);
    expect(await getPricing("any")).toBe(500_000n);
  });
  it("a missing masked row never makes traffic cheaper (falls back to highest)", async () => {
    mockQuery.mockResolvedValue({ rows: rows.filter((r) => r.ip_class !== "masked") });
    expect(await getPricing("masked")).toBe(500_000n);
  });
  it("listPricing returns tier weights", async () => {
    mockQuery.mockResolvedValue({ rows: [{ ip_class: "masked", price_per_gb_musd: "100000", tier_weight_bps: 2500, updated_at: new Date(0) }] });
    const [p] = await listPricing();
    expect(p).toMatchObject({ ipClass: "masked", pricePerGbMusd: 100_000n, tierWeightBps: 2500 });
  });
});

describe("tier weighting", () => {
  it("getTierWeights fills missing classes with defaults", async () => {
    mockQuery.mockResolvedValue({ rows: [{ ip_class: "masked", tier_weight_bps: 2000 }, { ip_class: "bogus", tier_weight_bps: 1 }] });
    expect(await getTierWeights()).toEqual({ residential: 10_000, mobile: 10_000, dc: 4_000, masked: 2_000 });
  });

  it("getChargeSnapshot snapshots the serving class's weight (masked 2500, unknown = lowest)", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM node_tiers")) return { rows: [{ id: 1, name: "probation", rank: 0, node_share_bps: 2500, min_tenure_days: 0, min_uptime_bps: 0, min_active_ips: 1, min_reputation: 0, no_clawback_days: 0, hold_days: 14, max_nodes: 10, daily_withdraw_limit_musd: "1" }] };
      if (sql.includes("FROM revenue_split_config")) return { rows: [{ id: 3 }] };
      if (sql.includes("FROM users")) return { rows: [{ node_tier_id: 1 }] };
      if (sql.includes("FROM network_pricing")) return { rows: [{ ip_class: "residential", tier_weight_bps: 10000 }, { ip_class: "dc", tier_weight_bps: 4000 }, { ip_class: "masked", tier_weight_bps: 2500 }] };
      return { rows: [] };
    });
    expect((await getChargeSnapshot(U, "masked")).tierWeightBps).toBe(2500);
    expect((await getChargeSnapshot(U, "dc")).tierWeightBps).toBe(4000);
    expect((await getChargeSnapshot(U, "residential")).tierWeightBps).toBe(10000);
    expect((await getChargeSnapshot(U, "unknown")).tierWeightBps).toBe(2500);
    // Node share is unchanged by class.
    expect((await getChargeSnapshot(U, "masked")).nodeShareBps).toBe(2500);
    expect((await getChargeSnapshot(U)).tierWeightBps).toBeUndefined();
  });

  it("owner stats use the class-weighted active IP sum", async () => {
    mockQuery.mockResolvedValue({ rows: [{ tenure_days: "40", active_ips_weight_bps: "17500", reputation: "7000", last_clawback_days: null }] });
    const s = await getOwnerTierStats(U, 9000);
    // 1 residential (10000) + 3 masked (2500 each) = 1.75 -> 1 active IP
    expect(s.activeIps).toBe(1);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("rc.tier_weight_bps");
    expect(sql).toContain("MIN(COALESCE(");
  });

  it("activeIpsFromWeightBps floors and rejects garbage", () => {
    expect(activeIpsFromWeightBps("40000")).toBe(4); // 4 residential
    expect(activeIpsFromWeightBps("30000")).toBe(3); // 3 residential = silver threshold
    expect(activeIpsFromWeightBps("27500")).toBe(2); // 11 masked = 2.75 -> 2
    expect(activeIpsFromWeightBps("12000")).toBe(1); // 3 dc = 1.2
    expect(activeIpsFromWeightBps(null)).toBe(0);
    expect(activeIpsFromWeightBps("-5")).toBe(0);
    expect(activeIpsFromWeightBps("1e9")).toBe(0);
  });
});
