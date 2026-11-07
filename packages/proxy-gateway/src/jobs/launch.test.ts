import { describe, it, expect, vi } from "vitest";
import { runGenesis, runStarterExpiry, LAUNCH_LOCK_KEYS } from "./launch.js";
import { JOB_LOCK_KEYS } from "./runner.js";

describe("launch jobs", () => {
  it("lock keys are distinct from the existing jobs", () => {
    const all = [...Object.values(JOB_LOCK_KEYS), ...Object.values(LAUNCH_LOCK_KEYS)];
    expect(new Set(all).size).toBe(all.length);
  });

  it("genesis: enrols, grants the one-time credit to qualifying members, matures held credits", async () => {
    const deps = {
      enrol: vi.fn().mockResolvedValue(2),
      listCreditCandidates: vi.fn().mockResolvedValue(["a", "b", "c"]),
      grantCredit: vi.fn().mockImplementation(async (o: string) => o !== "b"),
      matureCredits: vi.fn().mockResolvedValue(1),
    };
    expect(await runGenesis(deps)).toEqual({ enrolled: 2, granted: 2, matured: 1 });
    expect(deps.grantCredit).toHaveBeenCalledTimes(3);
  });

  it("starter-expiry loops full batches only", async () => {
    const expireDue = vi.fn()
      .mockResolvedValueOnce({ expired: 1000, removedCents: 5n })
      .mockResolvedValueOnce({ expired: 3, removedCents: 1n });
    expect(await runStarterExpiry({ expireDue })).toEqual({ expired: 1003, removedCents: 6n });
    expect(expireDue).toHaveBeenCalledTimes(2);
  });
});
