import { query } from "../db.js";

/**
 * Burn reports -> node reputation penalty (DESIGN.md §4, §15).
 *
 * Each report counts with the reporter's weight: min(1, reporter 30-day paid
 * spend / fullWeightSpendMusd). Spend on the reporter's own nodes, disputed
 * charges and reports against the reporter's own (or a teammate's) nodes are
 * ignored, so a reporter with no real spend has ~0 weight. Reports decay with
 * a half-life, each reporter's contribution per node is capped, and the
 * per-node penalty is capped.
 */

export const REPORT_WINDOW_DAYS = 30;
export const REPORT_PAGE_LIMIT = 1000;

export interface ReportPenaltyParams {
  /** Spend (µUSD) at which a reporter has full weight 1.0. */
  fullWeightSpendMusd: bigint;
  /** Half-life of a report's effect, in days. */
  halfLifeDays: number;
  /** Max decayed reports one reporter can contribute per node. */
  maxPerReporter: number;
  /** Reputation points per full-weight, undecayed report. */
  pointsPerReport: number;
  /** Cap on the total penalty per node (0..10000). */
  maxPenalty: number;
}

export const DEFAULT_REPORT_PENALTY_PARAMS: ReportPenaltyParams = {
  fullWeightSpendMusd: 10_000_000n, // $10 in 30 days
  halfLifeDays: 7,
  maxPerReporter: 3,
  pointsPerReport: 100,
  maxPenalty: 2000,
};

export interface ReportAggregate {
  nodeId: string;
  /** null for a page node with no counted reports (penalty resets to 0). */
  reporterUserId: string | null;
  /** Sum of decayed report counts, 0.5^(ageDays/halfLife) each. */
  decayed: number;
  /** Reporter's counted 30-day spend, µUSD. */
  spendMusd: bigint;
}

/** Reporter weight in [0, 1]. */
export function reporterWeight(spendMusd: bigint, p: ReportPenaltyParams): number {
  if (spendMusd <= 0n || p.fullWeightSpendMusd <= 0n) return 0;
  if (spendMusd >= p.fullWeightSpendMusd) return 1;
  return Number((spendMusd * 1_000_000n) / p.fullWeightSpendMusd) / 1_000_000;
}

/** Pure: per-node penalty from aggregates. Every page node appears in the result. */
export function computeReportPenalties(rows: ReportAggregate[], p: ReportPenaltyParams): Map<string, number> {
  const sums = new Map<string, number>();
  for (const r of rows) {
    if (!sums.has(r.nodeId)) sums.set(r.nodeId, 0);
    if (!r.reporterUserId) continue;
    const d = Number.isFinite(r.decayed) ? Math.max(0, r.decayed) : 0;
    const contrib = reporterWeight(r.spendMusd, p) * Math.min(d, p.maxPerReporter);
    sums.set(r.nodeId, sums.get(r.nodeId)! + contrib);
  }
  const out = new Map<string, number>();
  const cap = Math.max(0, Math.min(10_000, Math.floor(p.maxPenalty)));
  for (const [id, s] of sums) out.set(id, Math.max(0, Math.min(cap, Math.round(s * p.pointsPerReport))));
  return out;
}

/**
 * One page (by node id) of nodes that have reports in the window or a
 * non-zero penalty, with per-reporter decayed counts and reporter spend.
 */
export async function listReportAggregates(
  afterNodeId: string | null, limit: number, halfLifeDays: number,
): Promise<{ rows: ReportAggregate[]; lastNodeId: string | null; pageSize: number }> {
  const lim = Math.max(1, Math.min(REPORT_PAGE_LIMIT, Math.floor(limit)));
  const hl = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : 7;
  const r = await query<{ node_id: string; reporter_user_id: string | null; decayed: number | null; musd: string | null }>(
    `WITH page AS (
       SELECT n.id, n.owner_user_id FROM nodes n
       WHERE ($1::uuid IS NULL OR n.id > $1::uuid)
         AND (n.report_penalty > 0 OR EXISTS (
               SELECT 1 FROM node_reports r
               WHERE r.node_id = n.id AND r.created_at > now() - make_interval(days => $3)))
       ORDER BY n.id LIMIT $2
     ), agg AS (
       SELECT r.node_id, r.reporter_user_id,
              SUM(power(0.5, GREATEST(0, EXTRACT(EPOCH FROM (now() - r.created_at))) / 86400.0 / $4::float8))::float8 AS decayed
       FROM node_reports r JOIN page p ON p.id = r.node_id
       WHERE r.created_at > now() - make_interval(days => $3)
         AND r.reporter_user_id <> p.owner_user_id
         AND NOT EXISTS (
           SELECT 1 FROM team_members a JOIN team_members b ON a.team_id = b.team_id
           WHERE a.user_id = r.reporter_user_id AND b.user_id = p.owner_user_id)
       GROUP BY r.node_id, r.reporter_user_id
     ), spend AS (
       SELECT s.reporter_user_id, COALESCE(SUM(rc.gross_musd), 0)::text AS musd
       FROM (SELECT DISTINCT reporter_user_id FROM agg) s
       LEFT JOIN relay_charges rc
         ON rc.requester_user_id = s.reporter_user_id
        AND rc.created_at > now() - make_interval(days => $3)
        AND NOT rc.disputed
        AND rc.node_owner_user_id IS DISTINCT FROM s.reporter_user_id
       GROUP BY s.reporter_user_id
     )
     SELECT p.id AS node_id, a.reporter_user_id, a.decayed, sp.musd
     FROM page p
     LEFT JOIN agg a ON a.node_id = p.id
     LEFT JOIN spend sp ON sp.reporter_user_id = a.reporter_user_id
     ORDER BY p.id`,
    [afterNodeId, lim, REPORT_WINDOW_DAYS, hl],
  );
  const ids = new Set<string>();
  let last: string | null = null;
  const rows = r.rows.map((x) => {
    ids.add(x.node_id);
    last = x.node_id;
    return {
      nodeId: x.node_id,
      reporterUserId: x.reporter_user_id,
      decayed: x.decayed == null ? 0 : Number(x.decayed),
      spendMusd: x.musd == null ? 0n : BigInt(x.musd),
    };
  });
  return { rows, lastNodeId: last, pageSize: ids.size };
}

/** Persist penalties (only rows that change). Returns rows updated. */
export async function applyReportPenalties(penalties: Map<string, number>): Promise<number> {
  if (penalties.size === 0) return 0;
  const ids = [...penalties.keys()].slice(0, REPORT_PAGE_LIMIT);
  const vals = ids.map((id) => Math.max(0, Math.min(10_000, Math.round(penalties.get(id)!))));
  const r = await query(
    `UPDATE nodes n SET report_penalty = v.p
     FROM unnest($1::uuid[], $2::int[]) AS v(id, p)
     WHERE n.id = v.id AND n.report_penalty IS DISTINCT FROM v.p`,
    [ids, vals],
  );
  return r.rowCount ?? 0;
}

/** Current penalties for live nodes (gateway registry refresh). Missing = 0. */
export async function getReportPenalties(nodeIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = nodeIds.slice(0, REPORT_PAGE_LIMIT);
  if (ids.length === 0) return out;
  const r = await query<{ id: string; report_penalty: number }>(
    `SELECT id, report_penalty FROM nodes WHERE id = ANY($1::uuid[]) AND report_penalty > 0`, [ids]);
  for (const x of r.rows) out.set(x.id, Number(x.report_penalty));
  return out;
}
