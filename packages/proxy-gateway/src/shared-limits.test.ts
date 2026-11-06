import { describe, it, expect, vi, beforeEach } from "vitest";
import { installSharedLimits, makeInstanceId } from "./shared-limits.js";
import { _resetPolicyEnforcer, reserveRequesterSpend, reserveRequesterShared, releaseRequesterSpend, recordRequesterSpend, getRequesterInflightSpend, enforcePolicy } from "./policy-enforcer.js";
import { DEFAULT_POLICY } from "@dominusnode/shared";

function fakeRepo(reserve: () => Promise<"ok" | "rate" | "spend">) {
  return {
    reserveRequester: vi.fn(reserve),
    settleRequester: vi.fn(async () => undefined),
    claimNodeSlot: vi.fn(async () => true),
    releaseNodeSlot: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    releaseInstance: vi.fn(async () => undefined),
  };
}
const log = { warn: vi.fn() };
const U = "u1";

describe("shared limits", () => {
  beforeEach(() => {
    _resetPolicyEnforcer();
    enforcePolicy(DEFAULT_POLICY, { userId: "seed", host: "example.com", port: 443, plaintext: false, allowHttp: false });
  });

  it("instance ids are short and safe", () => {
    expect(makeInstanceId()).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
  });

  it("passes the policy cap and req/s to the store with this instance id", async () => {
    const repo = fakeRepo(async () => "ok");
    const s = installSharedLimits(log, repo as never, "gw-a");
    expect(reserveRequesterSpend(U, 100n)).toBe(true);
    await reserveRequesterShared(U, 100n);
    expect(repo.reserveRequester).toHaveBeenCalledWith({
      userId: U, musd: 100n, instanceId: "gw-a",
      dailyCapMusd: BigInt(DEFAULT_POLICY.requesterLimits.dailySpendMusd), reqPerSec: DEFAULT_POLICY.requesterLimits.reqPerSec,
    });
    await s.claimIpSlot({ nodeId: "n", ip: "1.1.1.1", prefix24: "1.1.1", asn: 1, enforceAsn: true, limits: { per32: 1, per24: 1, perAsn: 1 } });
    expect(repo.claimNodeSlot).toHaveBeenCalledWith(expect.objectContaining({ instanceId: "gw-a" }));
    await s.stop();
    expect(repo.releaseInstance).toHaveBeenCalledWith("gw-a");
  });

  it("refusal from another instance's usage releases the local hold and throws", async () => {
    installSharedLimits(log, fakeRepo(async () => "spend") as never, "gw-a");
    reserveRequesterSpend(U, 100n);
    await expect(reserveRequesterShared(U, 100n)).rejects.toThrow(/spend cap/);
    expect(getRequesterInflightSpend(U)).toBe(0n);
    installSharedLimits(log, fakeRepo(async () => "rate") as never, "gw-a");
    reserveRequesterSpend(U, 100n);
    await expect(reserveRequesterShared(U, 100n)).rejects.toThrow(/per second/);
  });

  it("fails closed on store errors", async () => {
    installSharedLimits(log, fakeRepo(async () => { throw new Error("db down"); }) as never, "gw-a");
    reserveRequesterSpend(U, 100n);
    await expect(reserveRequesterShared(U, 100n)).rejects.toThrow(/Unable/);
    expect(getRequesterInflightSpend(U)).toBe(0n);
  });

  it("mirrors release and settled spend to the store", async () => {
    const repo = fakeRepo(async () => "ok");
    installSharedLimits(log, repo as never, "gw-a");
    releaseRequesterSpend(U, 40n);
    recordRequesterSpend(U, 25n);
    reserveRequesterSpend(U, 7n, false);
    expect(repo.settleRequester).toHaveBeenCalledWith(U, "gw-a", 40n, 0n);
    expect(repo.settleRequester).toHaveBeenCalledWith(U, "gw-a", 0n, 25n);
    expect(repo.reserveRequester).toHaveBeenCalledWith(expect.objectContaining({ musd: 7n, dailyCapMusd: null, reqPerSec: null }));
  });

  it("is a no-op without a store", async () => {
    await expect(reserveRequesterShared(U, 5n)).resolves.toBeUndefined();
  });
});
