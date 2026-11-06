import type { relayChargeRepo } from "@dominusnode/shared";
type SettleRelayChargeInput = relayChargeRepo.SettleRelayChargeInput;
import { Job, JOB_LOCK_KEYS, type JobLogger, type LockPool } from "./runner.js";

/**
 * Retry failed relay settlements (relay_settle_retries). settleRelayCharge is
 * idempotent on session_id, so a retry after a partial/unknown outcome never
 * double charges. Backoff and the dead-letter cutoff live in the repo.
 */

export interface SettleRetryDeps {
  listDue(limit?: number): Promise<Array<{ sessionId: string; attempts: number; input: SettleRelayChargeInput }>>;
  settle(i: SettleRelayChargeInput): Promise<unknown>;
  markDone(sessionId: string): Promise<void>;
  /** Returns true when the row has been dead-lettered. */
  markFailed(sessionId: string, error: string): Promise<boolean>;
  /** Called once a row is dead: close the DB session as error. */
  onDead(sessionId: string, totalBytes: number): Promise<void>;
  logger: JobLogger;
}

export async function runOnce(deps: SettleRetryDeps): Promise<{ due: number; settled: number; failed: number; dead: number }> {
  const rows = await deps.listDue(100);
  const out = { due: rows.length, settled: 0, failed: 0, dead: 0 };
  for (const row of rows) {
    try {
      await deps.settle(row.input);
      await deps.markDone(row.sessionId);
      out.settled++;
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 200) : "unknown";
      out.failed++;
      let dead = false;
      try {
        dead = await deps.markFailed(row.sessionId, msg);
      } catch { /* retried next run */ }
      if (dead) {
        out.dead++;
        deps.logger.error("relay settlement retry exhausted — manual reconciliation required", { sessionId: row.sessionId, error: msg });
        await deps.onDead(row.sessionId, Number(row.input.bytesGateway)).catch(() => undefined);
      }
    }
  }
  return out;
}

export function start(o: { deps: SettleRetryDeps; pool: LockPool; logger: JobLogger; intervalMs?: number }): Job {
  const job = new Job({
    name: "relay-settle-retry", intervalMs: o.intervalMs ?? 60_000, lockKey: JOB_LOCK_KEYS.settleRetry, pool: o.pool,
    logger: o.logger, run: () => runOnce(o.deps),
  });
  job.start();
  return job;
}

export async function stop(job: Job | null): Promise<void> {
  await job?.stop();
}
