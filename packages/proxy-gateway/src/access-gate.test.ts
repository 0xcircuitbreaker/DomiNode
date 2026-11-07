import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_POLICY, type NetworkPolicy } from "@dominusnode/shared";
import { configureAccessGate, checkRequesterAccess, checkAnonymousPayer } from "./access-gate.js";

const pol = (o: Partial<NetworkPolicy> = {}): NetworkPolicy => ({ ...DEFAULT_POLICY, ...o });

describe("access gate", () => {
  const isSeedOnly = vi.fn();
  const hasContribution = vi.fn();
  let now = 1_000_000;
  beforeEach(() => {
    isSeedOnly.mockReset().mockResolvedValue(false);
    hasContribution.mockReset().mockResolvedValue(false);
    now = 1_000_000;
    configureAccessGate({ isSeedOnly, hasContribution, now: () => now });
  });

  it("defaults: anyone can buy (requireContribution false) and x402 payers are allowed", async () => {
    expect(DEFAULT_POLICY.requireContribution).toBe(false);
    expect(DEFAULT_POLICY.allowAnonymousPayers).toBe(true);
    expect(await checkRequesterAccess(pol(), "u1")).toEqual({ allowed: true, seedOnly: false });
    expect(hasContribution).not.toHaveBeenCalled();
    expect(checkAnonymousPayer(pol()).allowed).toBe(true);
  });

  it("requireContribution refuses non-contributors with 403 CONTRIBUTION_REQUIRED and allows contributors", async () => {
    const r = await checkRequesterAccess(pol({ requireContribution: true, contributionWindowDays: 14 }), "u1");
    expect(r).toMatchObject({ allowed: false, status: 403, code: "CONTRIBUTION_REQUIRED" });
    expect(hasContribution).toHaveBeenCalledWith("u1", 14);
    hasContribution.mockResolvedValue(true);
    expect((await checkRequesterAccess(pol({ requireContribution: true }), "u2")).allowed).toBe(true);
  });

  it("caches the contribution decision briefly and fails closed on lookup errors", async () => {
    const p = pol({ requireContribution: true });
    await checkRequesterAccess(p, "u1");
    await checkRequesterAccess(p, "u1");
    expect(hasContribution).toHaveBeenCalledTimes(1);
    now += 31_000;
    await checkRequesterAccess(p, "u1");
    expect(hasContribution).toHaveBeenCalledTimes(2);
    hasContribution.mockRejectedValue(new Error("db"));
    expect(await checkRequesterAccess(p, "u9")).toMatchObject({ allowed: false, status: 503 });
  });

  it("seed-only routing for starter-credit requesters; lookup errors keep them on seed nodes", async () => {
    isSeedOnly.mockResolvedValue(true);
    expect(await checkRequesterAccess(pol(), "s1")).toEqual({ allowed: true, seedOnly: true });
    isSeedOnly.mockRejectedValue(new Error("db"));
    expect(await checkRequesterAccess(pol(), "s2")).toEqual({ allowed: true, seedOnly: true });
  });

  it("allowAnonymousPayers=false refuses x402/MPP payers with 403 ANONYMOUS_PAYERS_DISABLED", () => {
    expect(checkAnonymousPayer(pol({ allowAnonymousPayers: false }))).toMatchObject({ allowed: false, status: 403, code: "ANONYMOUS_PAYERS_DISABLED" });
  });
});
