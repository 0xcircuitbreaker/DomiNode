import type { tierRepo } from "@dominusnode/shared";
import { Job, JOB_LOCK_KEYS, type JobLogger, type LockPool } from "./runner.js";

/** Daily tier recalculation per beneficial owner (DESIGN.md §15). */

type OwnerTierStats = Awaited<ReturnType<typeof tierRepo.getOwnerTierStats>>;
type TierDecision = Awaited<ReturnType<typeof tierRepo.applyOwnerTier>>;

export interface TierDeps {
  listOwners(afterUserId: string | null, limit: number): Promise<string[]>;
  getUptimeBps(userId: string): Promise<number>;
  getStats(userId: string, uptimeBps: number): Promise<OwnerTierStats>;
  apply(userId: string, stats: OwnerTierStats): Promise<TierDecision>;
  maxOwners?: number;
}

export async function runOnce(deps: TierDeps): Promise<{ owners: number; failed: number }> {
  const max = deps.maxOwners ?? 100_000;
  let after: string | null = null;
  let owners = 0;
  let failed = 0;
  while (owners + failed < max) {
    const page = await deps.listOwners(after, 1000);
    if (page.length === 0) break;
    for (const u of page) {
      try {
        const uptime = await deps.getUptimeBps(u);
        await deps.apply(u, await deps.getStats(u, uptime));
        owners++;
      } catch {
        failed++; // one bad owner never blocks the rest
      }
    }
    after = page[page.length - 1]!;
    if (page.length < 1000) break;
  }
  return { owners, failed };
}

export function start(o: { deps: TierDeps; pool: LockPool; logger: JobLogger; intervalMs?: number }): Job {
  const job = new Job({
    name: "tiers", intervalMs: o.intervalMs ?? 86_400_000, lockKey: JOB_LOCK_KEYS.tiers, pool: o.pool,
    logger: o.logger, run: () => runOnce(o.deps), initialDelayMs: 60_000,
  });
  job.start();
  return job;
}

export async function stop(job: Job | null): Promise<void> {
  await job?.stop();
}
