import type { reportReputationRepo } from "@dominusnode/shared";
import { Job, JOB_LOCK_KEYS, type JobLogger, type LockPool } from "./runner.js";

/**
 * Burn reports -> node reputation (DESIGN.md §4, §15). Hourly, one instance
 * (advisory lock). Pages nodes with recent reports or a non-zero penalty,
 * LIMIT 1000 per page, and persists nodes.report_penalty. Gateways pick the
 * penalties up in the reputation-flush job; tiers read them from the DB.
 */

type Repo = typeof reportReputationRepo;
type Params = reportReputationRepo.ReportPenaltyParams;

export interface ReportReputationDeps {
  listAggregates: Repo["listReportAggregates"];
  compute: Repo["computeReportPenalties"];
  apply: Repo["applyReportPenalties"];
  params: Params;
  pageLimit?: number;
  maxPages?: number;
}

export async function runOnce(deps: ReportReputationDeps): Promise<{ nodes: number; updated: number; pages: number }> {
  const limit = deps.pageLimit ?? 1000;
  const maxPages = deps.maxPages ?? 1000;
  let after: string | null = null;
  let nodes = 0;
  let updated = 0;
  let pages = 0;
  while (pages < maxPages) {
    const page = await deps.listAggregates(after, limit, deps.params.halfLifeDays);
    pages++;
    if (page.pageSize === 0 || !page.lastNodeId) break;
    const penalties = deps.compute(page.rows, deps.params);
    nodes += penalties.size;
    updated += await deps.apply(penalties);
    after = page.lastNodeId;
    if (page.pageSize < limit) break;
  }
  return { nodes, updated, pages };
}

/** Read tuning from env (validated, NaN/range-safe). */
export function paramsFromEnv(
  env: NodeJS.ProcessEnv,
  envInt: (env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number) => number,
  defaults: Params,
): Params {
  return {
    fullWeightSpendMusd: BigInt(envInt(env, "REPORT_FULL_WEIGHT_SPEND_CENTS", Number(defaults.fullWeightSpendMusd / 10_000n), 1, 100_000_000)) * 10_000n,
    minNodeSpendMusd: BigInt(envInt(env, "REPORT_MIN_NODE_SPEND_CENTS", Number(defaults.minNodeSpendMusd / 10_000n), 0, 100_000_000)) * 10_000n,
    maxLowWeightReporters: envInt(env, "REPORT_MAX_LOW_WEIGHT_REPORTERS", defaults.maxLowWeightReporters, 0, 1000),
    halfLifeDays: envInt(env, "REPORT_HALF_LIFE_DAYS", defaults.halfLifeDays, 1, 30),
    maxPerReporter: envInt(env, "REPORT_MAX_PER_REPORTER", defaults.maxPerReporter, 1, 100),
    pointsPerReport: envInt(env, "REPORT_POINTS_PER_REPORT", defaults.pointsPerReport, 1, 10_000),
    maxPenalty: envInt(env, "REPORT_MAX_PENALTY", defaults.maxPenalty, 0, 10_000),
  };
}

export function start(o: { deps: ReportReputationDeps; pool: LockPool; logger: JobLogger; intervalMs?: number }): Job {
  const job = new Job({
    name: "report-reputation", intervalMs: o.intervalMs ?? 3_600_000, lockKey: JOB_LOCK_KEYS.reportReputation, pool: o.pool,
    logger: o.logger, run: () => runOnce(o.deps), initialDelayMs: 120_000,
  });
  job.start();
  return job;
}

export async function stop(job: Job | null): Promise<void> {
  await job?.stop();
}
