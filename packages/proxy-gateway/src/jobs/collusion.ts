import type { collusionRepo } from "@dominusnode/shared";
import { Job, JOB_LOCK_KEYS, type JobLogger, type LockPool } from "./runner.js";

/**
 * Collusion detector (DESIGN.md §13 commit 33). Daily, one instance (advisory
 * lock). Pages nodes (LIMIT 1000) for requester concentration and owner pairs
 * for circular flows, records admin-visible flags and, only when
 * collusion_settings.auto_freeze is on, freezes the owner's node credits
 * above the freeze threshold.
 */

type Repo = typeof collusionRepo;

export interface CollusionDeps {
  getSettings: Repo["getSettings"];
  listNodes: Repo["listNodeConcentration"];
  listCircular: Repo["listCircularPairs"];
  evaluateNode: Repo["evaluateNode"];
  evaluateCircular: Repo["evaluateCircular"];
  record: Repo["recordFinding"];
  pageLimit?: number;
  maxPages?: number;
  logger?: JobLogger;
}

export interface CollusionRunResult { nodes: number; pairs: number; flagged: number; frozen: number; failed: number }

export async function runOnce(deps: CollusionDeps): Promise<CollusionRunResult> {
  const s = await deps.getSettings();
  const limit = deps.pageLimit ?? 1000;
  const maxPages = deps.maxPages ?? 1000;
  const out: CollusionRunResult = { nodes: 0, pairs: 0, flagged: 0, frozen: 0, failed: 0 };
  const record = async (f: Parameters<Repo["recordFinding"]>[0]) => {
    try {
      const r = await deps.record(f, s.windowDays);
      if (r.flagged) out.flagged++;
      if (r.frozen) {
        out.frozen++;
        deps.logger?.warn("collusion auto-freeze", { ownerUserId: f.ownerUserId, kind: f.kind, shareBps: f.shareBps });
      }
    } catch {
      out.failed++; // one bad row never blocks the rest
    }
  };

  let after: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const page = await deps.listNodes(after, limit, s.windowDays, s.clusterSize);
    if (page.length === 0) break;
    out.nodes += page.length;
    for (const n of page) {
      const f = deps.evaluateNode(n, s);
      if (f) await record(f);
    }
    after = page[page.length - 1]!.nodeId;
    if (page.length < limit) break;
  }

  let cursor: { a: string; b: string } | null = null;
  for (let i = 0; i < maxPages; i++) {
    const page = await deps.listCircular(cursor, limit, s.windowDays, s.circularMinMusd);
    if (page.length === 0) break;
    out.pairs += page.length;
    for (const p of page) for (const f of deps.evaluateCircular(p, s)) await record(f);
    const last = page[page.length - 1]!;
    cursor = { a: last.a, b: last.b };
    if (page.length < limit) break;
  }
  return out;
}

export function start(o: { deps: CollusionDeps; pool: LockPool; logger: JobLogger; intervalMs?: number }): Job {
  const job = new Job({
    name: "collusion", intervalMs: o.intervalMs ?? 86_400_000, lockKey: JOB_LOCK_KEYS.collusion, pool: o.pool,
    logger: o.logger, run: () => runOnce({ ...o.deps, logger: o.deps.logger ?? o.logger }), initialDelayMs: 300_000,
  });
  job.start();
  return job;
}

export async function stop(job: Job | null): Promise<void> {
  await job?.stop();
}
