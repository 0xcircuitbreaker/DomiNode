import { Job, JOB_LOCK_KEYS, type JobLogger, type LockPool } from "./runner.js";

/** Credit maturity (DESIGN.md §6.4): pending → available once the tier hold ends. */

export const MATURE_BATCH_LIMIT = 1000;

export interface MatureBatch {
  scanned: number;
  matured: number;
  skippedFrozen: number;
  movedMusd: bigint;
}

export interface MaturityDeps {
  matureDue(limit?: number): Promise<MatureBatch>;
  /** Upper bound on batches per run (each batch is its own transaction). */
  maxBatches?: number;
}

export interface MaturityResult {
  batches: number;
  matured: number;
  skippedFrozen: number;
  movedMusd: bigint;
}

export async function runOnce(deps: MaturityDeps): Promise<MaturityResult> {
  const max = deps.maxBatches ?? 50;
  const out: MaturityResult = { batches: 0, matured: 0, skippedFrozen: 0, movedMusd: 0n };
  for (let i = 0; i < max; i++) {
    const r = await deps.matureDue(MATURE_BATCH_LIMIT);
    out.batches++;
    out.matured += r.matured;
    out.skippedFrozen += r.skippedFrozen;
    out.movedMusd += r.movedMusd;
    // Stop only on a short batch. Frozen owners are excluded from selection,
    // so a full batch always means more due rows may exist; maxBatches bounds it.
    if (r.scanned < MATURE_BATCH_LIMIT) break;
  }
  return out;
}

export function start(o: { deps: MaturityDeps; pool: LockPool; logger: JobLogger; intervalMs?: number }): Job {
  const job = new Job({
    name: "maturity", intervalMs: o.intervalMs ?? 3_600_000, lockKey: JOB_LOCK_KEYS.maturity, pool: o.pool,
    logger: o.logger, run: () => runOnce(o.deps),
  });
  job.start();
  return job;
}

export async function stop(job: Job | null): Promise<void> {
  await job?.stop();
}
