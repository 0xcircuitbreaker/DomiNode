import { describe, it, expect, vi } from "vitest";
vi.mock("../db.js", () => ({ query: vi.fn(), getPool: () => ({ connect: vi.fn() }) }));
import { computeOwnerTier, genesisBonusFor, getChargeSnapshot, getBuyerDiscount, type NodeTier, type OwnerTierStats } from "./tier-repo.js";
import { query } from "../db.js";

const T = (id: number, rank: number, ten: number, up: number, ips: number, rep: number, nc = 0): NodeTier => ({
  id, name: `t${id}`, rank, nodeShareBps: 2500 + rank * 500, minTenureDays: ten, minUptimeBps: up, minActiveIps: ips,
  minReputation: rep, noClawbackDays: nc, holdDays: 7, maxNodes: 10, dailyWithdrawLimitMusd: 1n, buyerDiscountBps: rank * 500,
});
const tiers = [T(1, 0, 0, 0, 1, 3000), T(2, 1, 7, 8000, 1, 5000), T(3, 2, 30, 9000, 3, 6000), T(6, 5, 180, 9700, 50, 8500, 90)];
const great: OwnerTierStats = { tenureDays: 400, uptimeBps: 9900, activeIps: 100, reputation: 9000, daysSinceLastClawback: null };
const now = new Date("2026-11-04T00:00:00Z");

describe("computeOwnerTier", () => {
  it("promotes only one step", () => {
    expect(computeOwnerTier(tiers, great, { tierId: 1, graceUntil: null }, now)).toMatchObject({ tierId: 2, direction: "promote" });
    expect(computeOwnerTier(tiers, great, { tierId: null, graceUntil: null }, now).tierId).toBe(2);
  });
  it("demotes immediately on quality failure to highest qualifying lower tier", () => {
    const d = computeOwnerTier(tiers, { ...great, activeIps: 2 }, { tierId: 6, graceUntil: null }, now);
    expect(d).toMatchObject({ tierId: 2, direction: "demote" });
    expect(d.demotionReason).toContain("active_ips");
  });
  it("partner recent clawback demotes", () => {
    const d = computeOwnerTier(tiers, { ...great, daysSinceLastClawback: 10 }, { tierId: 6, graceUntil: null }, now);
    expect(d.direction).toBe("demote");
  });
  it("uptime miss starts 3-day grace, then demotes after expiry", () => {
    const s = { ...great, uptimeBps: 8500 };
    const g = computeOwnerTier(tiers, s, { tierId: 3, graceUntil: null }, now);
    expect(g.direction).toBe("hold");
    expect(g.graceUntil!.getTime() - now.getTime()).toBe(3 * 86_400_000);
    expect(computeOwnerTier(tiers, s, { tierId: 3, graceUntil: g.graceUntil }, now).direction).toBe("hold");
    const later = new Date(now.getTime() + 4 * 86_400_000);
    expect(computeOwnerTier(tiers, s, { tierId: 3, graceUntil: g.graceUntil }, later)).toMatchObject({ tierId: 2, direction: "demote", demotionReason: "uptime" });
  });
  it("probation is the floor", () => {
    const bad = { tenureDays: 0, uptimeBps: 0, activeIps: 0, reputation: 0, daysSinceLastClawback: null };
    expect(computeOwnerTier(tiers, bad, { tierId: 1, graceUntil: null }, now)).toMatchObject({ tierId: 1, direction: "hold" });
  });
});

describe("genesis boost snapshot", () => {
  it("adds the bonus but never above the 5000 bps ceiling", () => {
    expect(genesisBonusFor(2500, 500)).toBe(500);
    expect(genesisBonusFor(4800, 500)).toBe(200);
    expect(genesisBonusFor(5000, 500)).toBe(0);
    expect(genesisBonusFor(2500, 9000)).toBe(2500);
  });

  it("getChargeSnapshot snapshots tier + genesis bonus", async () => {
    const q = vi.mocked(query);
    q.mockReset();
    q.mockImplementation((async (sql: string) => {
      if (sql.includes("FROM node_tiers")) return { rows: [{ id: 6, name: "partner", rank: 5, node_share_bps: 4800, min_tenure_days: 0, min_uptime_bps: 0, min_active_ips: 0, min_reputation: 0, no_clawback_days: 0, hold_days: 3, max_nodes: 1, daily_withdraw_limit_musd: "1", buyer_discount_bps: 2500 }] };
      if (sql.includes("FROM revenue_split_config")) return { rows: [{ id: 9 }] };
      if (sql.includes("FROM genesis_settings")) return { rows: [{ bonus_bps: 500 }] };
      return { rows: [] };
    }) as never);
    expect(await getChargeSnapshot("o1")).toEqual({ splitConfigId: 9, tierId: 6, nodeShareBps: 5000, holdDays: 3, genesisBonusBps: 200 });
  });

  it("getBuyerDiscount: node owners get their tier discount, non-owners pay list", async () => {
    const q = vi.mocked(query);
    q.mockReset();
    q.mockResolvedValueOnce({ rows: [{ tier_id: 3, buyer_discount_bps: 1000, enabled: true, min_platform_margin_bps: 2500 }] } as never);
    expect(await getBuyerDiscount("u1")).toEqual({ buyerTierId: 3, buyerDiscountBps: 1000, minPlatformMarginBps: 2500 });
    q.mockResolvedValueOnce({ rows: [{ tier_id: null, buyer_discount_bps: null, enabled: true, min_platform_margin_bps: 2500 }] } as never);
    expect(await getBuyerDiscount("u2")).toEqual({ buyerTierId: null, buyerDiscountBps: 0, minPlatformMarginBps: 2500 });
    q.mockResolvedValueOnce({ rows: [{ tier_id: 3, buyer_discount_bps: 1000, enabled: false, min_platform_margin_bps: 3000 }] } as never);
    expect(await getBuyerDiscount("u3")).toMatchObject({ buyerDiscountBps: 0, minPlatformMarginBps: 3000 });
  });
});
