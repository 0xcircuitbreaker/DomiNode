/**
 * Launch-readiness background jobs (LAUNCH_PLAN §4–§9):
 *  - starter-expiry: expire starter-credit grants and remove the unused remainder
 *  - genesis: enrol genesis-cohort node owners, grant/mature the one-time credit
 *  - network-snapshot: hourly public network stats snapshot + retention
 *  - unmet-demand flush: per-instance aggregation flushed to the DB (no lock)
 * Each job is a pure runOnce(deps) plus a timer, like the other jobs.
 */
import { Job, type JobLogger, type LockPool } from "./runner.js";

/** Advisory-lock keys, distinct from JOB_LOCK_KEYS in runner.ts. */
export const LAUNCH_LOCK_KEYS = {
  starterExpiry: 0x444e_0011,
  genesis: 0x444e_0012,
  networkSnapshot: 0x444e_0013,
} as const;

// ─── genesis ────────────────────────────────────────────────────────

export interface GenesisDeps {
  enrol(): Promise<number>;
  listCreditCandidates(limit?: number): Promise<string[]>;
  grantCredit(ownerUserId: string): Promise<boolean>;
  matureCredits(limit?: number): Promise<number>;
}

export async function runGenesis(deps: GenesisDeps): Promise<{ enrolled: number; granted: number; matured: number }> {
  const enrolled = await deps.enrol();
  let granted = 0;
  for (const owner of await deps.listCreditCandidates(1000)) {
    if (await deps.grantCredit(owner)) granted++;
  }
  const matured = await deps.matureCredits(1000);
  return { enrolled, granted, matured };
}

export function startGenesis(o: { deps: GenesisDeps; pool: LockPool; logger: JobLogger; intervalMs?: number }): Job {
  const job = new Job({
    name: "genesis", intervalMs: o.intervalMs ?? 3_600_000, lockKey: LAUNCH_LOCK_KEYS.genesis, pool: o.pool,
    logger: o.logger, run: () => runGenesis(o.deps),
  });
  job.start();
  return job;
}

// ─── starter-expiry ─────────────────────────────────────────────────

export interface StarterExpiryDeps {
  expireDue(limit?: number): Promise<{ expired: number; removedCents: bigint }>;
  maxBatches?: number;
}

export async function runStarterExpiry(deps: StarterExpiryDeps): Promise<{ expired: number; removedCents: bigint }> {
  const out = { expired: 0, removedCents: 0n };
  for (let i = 0; i < (deps.maxBatches ?? 20); i++) {
    const r = await deps.expireDue(1000);
    out.expired += r.expired;
    out.removedCents += r.removedCents;
    if (r.expired < 1000) break;
  }
  return out;
}

export function startStarterExpiry(o: { deps: StarterExpiryDeps; pool: LockPool; logger: JobLogger; intervalMs?: number }): Job {
  const job = new Job({
    name: "starter-expiry", intervalMs: o.intervalMs ?? 3_600_000, lockKey: LAUNCH_LOCK_KEYS.starterExpiry, pool: o.pool,
    logger: o.logger, run: () => runStarterExpiry(o.deps),
  });
  job.start();
  return job;
}
