import { describe, it, expect, vi } from "vitest";
vi.mock("../db.js", () => ({ query: vi.fn(), getPool: () => ({ connect: vi.fn() }) }));
import { computeOwnerTier, type NodeTier, type OwnerTierStats } from "./tier-repo.js";

const T = (id: number, rank: number, ten: number, up: number, ips: number, rep: number, nc = 0): NodeTier => ({
  id, name: `t${id}`, rank, nodeShareBps: 2500 + rank * 500, minTenureDays: ten, minUptimeBps: up, minActiveIps: ips,
  minReputation: rep, noClawbackDays: nc, holdDays: 7, maxNodes: 10, dailyWithdrawLimitMusd: 1n,
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
