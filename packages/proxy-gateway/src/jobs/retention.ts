import { Job, JOB_LOCK_KEYS, type JobLogger, type LockPool } from "./runner.js";

/** Abuse-log retention: delete relay_abuse_log rows older than policy.logRetentionDays, 1000 at a time. */

export const RETENTION_BATCH = 1000;

export interface RetentionDeps {
  /** policy.logRetentionDays (validated 1..3650 by the policy validator). */
  getRetentionDays(): number;
  purgeBatch(days: number, batch: number): Promise<number>;
  /** Scrub requester/host from abuse-log access audit rows past the same retention. */
  scrubAccessAuditBatch?(days: number, batch: number): Promise<number>;
  maxBatches?: number;
}

export async function runOnce(deps: RetentionDeps): Promise<{ days: number; deleted: number; batches: number; scrubbed?: number }> {
  const days = deps.getRetentionDays();
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("logRetentionDays out of range");
  const max = deps.maxBatches ?? 1000;
  let deleted = 0;
  let batches = 0;
  for (let i = 0; i < max; i++) {
    const n = await deps.purgeBatch(days, RETENTION_BATCH);
    batches++;
    deleted += n;
    if (n < RETENTION_BATCH) break;
  }
  if (!deps.scrubAccessAuditBatch) return { days, deleted, batches };
  let scrubbed = 0;
  for (let i = 0; i < max; i++) {
    const n = await deps.scrubAccessAuditBatch(days, RETENTION_BATCH);
    scrubbed += n;
    if (n < RETENTION_BATCH) break;
  }
  return { days, deleted, batches, scrubbed };
}

export function start(o: { deps: RetentionDeps; pool: LockPool; logger: JobLogger; intervalMs?: number }): Job {
  const job = new Job({
    name: "retention", intervalMs: o.intervalMs ?? 3_600_000, lockKey: JOB_LOCK_KEYS.retention, pool: o.pool,
    logger: o.logger, run: () => runOnce(o.deps),
  });
  job.start();
  return job;
}

export async function stop(job: Job | null): Promise<void> {
  await job?.stop();
}
