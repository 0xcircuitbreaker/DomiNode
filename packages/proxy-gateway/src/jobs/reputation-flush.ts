import type { HealthUpdate } from "@dominusnode/shared";
import type { CounterFlush } from "../node-tunnel/registry.js";
import { Job, type JobLogger } from "./runner.js";

/**
 * Flush in-memory reputation/burn counters to node_daily_stats / nodes (every 60 s).
 * Counters live in THIS instance's registry, so this job runs on every gateway
 * instance (no advisory lock): locking would drop other instances' deltas.
 */

export const FLUSH_CHUNK = 1000;

export interface ReputationFlushDeps {
  drain(): CounterFlush[];
  flushHealth(batch: HealthUpdate[]): Promise<number>;
  quarantine(nodeId: string): Promise<unknown>;
}

export function toHealthUpdates(items: CounterFlush[]): HealthUpdate[] {
  return items.map((f) => ({
    nodeId: f.nodeId,
    bytes: f.counters.bytes,
    streams: f.counters.streams,
    failures: f.counters.failures,
    burns: f.counters.burns,
    reputation: f.reputation,
  }));
}

export async function runOnce(deps: ReputationFlushDeps): Promise<{ nodes: number; flushed: number; quarantined: number }> {
  const items = deps.drain();
  const updates = toHealthUpdates(items);
  let flushed = 0;
  for (let i = 0; i < updates.length; i += FLUSH_CHUNK) {
    flushed += await deps.flushHealth(updates.slice(i, i + FLUSH_CHUNK));
  }
  let quarantined = 0;
  for (const f of items) {
    if (!f.quarantine) continue;
    try {
      await deps.quarantine(f.nodeId);
      quarantined++;
    } catch {
      /* retried on the next flush while reputation stays low */
    }
  }
  return { nodes: items.length, flushed, quarantined };
}

export function start(o: { deps: ReputationFlushDeps; logger: JobLogger; intervalMs?: number }): Job {
  const job = new Job({ name: "reputation-flush", intervalMs: o.intervalMs ?? 60_000, lockKey: null, logger: o.logger, run: () => runOnce(o.deps), initialDelayMs: 60_000 });
  job.start();
  return job;
}

export async function stop(job: Job | null): Promise<void> {
  await job?.stop();
}
