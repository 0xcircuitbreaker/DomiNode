import { query } from "../db.js";

/**
 * Burn reports -> node reputation penalty (DESIGN.md §4, §15).
 *
 * Each report counts with the reporter's weight: min(1, reporter 30-day paid
 * spend ON THE REPORTED NODE / fullWeightSpendMusd), and 0 below
 * minNodeSpendMusd. Total account spend elsewhere does not count, so a cheap
 * account cannot grief arbitrary nodes. Disputed charges, reports against the
 * reporter's own (or a teammate's) nodes, and spend to an owner that also paid
 * the reporter's nodes (circular flow) are ignored. Reports decay with a
 * half-life, each reporter's contribution per node is capped, at most
 * maxLowWeightReporters partial-weight reporters count per node, and the
 * per-node penalty is capped.
 *
 * The penalty alone never quarantines a node: the gateway raises an admin
 * review flag (collusion_flags kind 'report_penalty') instead.
 */

export const REPORT_WINDOW_DAYS = 30;
export const REPORT_PAGE_LIMIT = 1000;

export interface ReportPenaltyParams {
  /** Spend on the reported node (µUSD) at which a reporter has full weight 1.0. */
  fullWeightSpendMusd: bigint;
  /** Minimum spend on the reported node (µUSD) for a report to count at all. */
  minNodeSpendMusd: bigint;
  /** Max partial-weight (< 1.0) reporters counted per node (largest weights first). */
  maxLowWeightReporters: number;
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
  fullWeightSpendMusd: 10_000_000n, // $10 on that node in 30 days
  minNodeSpendMusd: 500_000n, // $0.50 on that node
  maxLowWeightReporters: 5,
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
  /** Reporter's counted 30-day paid spend on this node, µUSD. */
  spendMusd: bigint;
}

/** Reporter weight in [0, 1]. */
export function reporterWeight(spendMusd: bigint, p: ReportPenaltyParams): number {
  if (spendMusd <= 0n || p.fullWeightSpendMusd <= 0n) return 0;
  if (spendMusd < p.minNodeSpendMusd) return 0;
  if (spendMusd >= p.fullWeightSpendMusd) return 1;
  return Number((spendMusd * 1_000_000n) / p.fullWeightSpendMusd) / 1_000_000;
}

/** Pure: per-node penalty from aggregates. Every page node appears in the result. */
export function computeReportPenalties(rows: ReportAggregate[], p: ReportPenaltyParams): Map<string, number> {
  const sums = new Map<string, number>();
  const low = new Map<string, Array<{ w: number; contrib: number }>>();
  for (const r of rows) {
    if (!sums.has(r.nodeId)) sums.set(r.nodeId, 0);
    if (!r.reporterUserId) continue;
    const d = Number.isFinite(r.decayed) ? Math.max(0, r.decayed) : 0;
    const w = reporterWeight(r.spendMusd, p);
    if (w <= 0) continue;
    const contrib = w * Math.min(d, p.maxPerReporter);
    if (w >= 1) sums.set(r.nodeId, sums.get(r.nodeId)! + contrib);
    else {
      const l = low.get(r.nodeId) ?? [];
      l.push({ w, contrib });
      low.set(r.nodeId, l);
    }
  }
  // Many cheap reporters cannot add up: only the top maxLowWeightReporters count.
  const maxLow = Math.max(0, Math.floor(p.maxLowWeightReporters));
  for (const [id, l] of low) {
    l.sort((a, b) => b.w - a.w || b.contrib - a.contrib);
    const add = l.slice(0, maxLow).reduce((acc, x) => acc + x.contrib, 0);
    sums.set(id, sums.get(id)! + add);
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
       -- Paid spend by this reporter on THIS node only. Spend to an owner who
       -- also paid the reporter's nodes (circular flow) does not count.
       SELECT a.node_id, a.reporter_user_id, COALESCE(SUM(rc.gross_musd), 0)::text AS musd
       FROM agg a JOIN page p ON p.id = a.node_id
       LEFT JOIN relay_charges rc
         ON rc.requester_user_id = a.reporter_user_id
        AND rc.node_id = a.node_id
        AND rc.created_at > now() - make_interval(days => $3)
        AND NOT rc.disputed AND rc.gross_musd > 0
        AND rc.node_owner_user_id IS DISTINCT FROM a.reporter_user_id
       WHERE NOT EXISTS (
         SELECT 1 FROM relay_charges back
         WHERE back.requester_user_id = p.owner_user_id
           AND back.node_owner_user_id = a.reporter_user_id
           AND back.created_at > now() - make_interval(days => $3)
           AND NOT back.disputed AND back.gross_musd > 0)
       GROUP BY a.node_id, a.reporter_user_id
     )
     SELECT p.id AS node_id, a.reporter_user_id, a.decayed, sp.musd
     FROM page p
     LEFT JOIN agg a ON a.node_id = p.id
     LEFT JOIN spend sp ON sp.node_id = a.node_id AND sp.reporter_user_id = a.reporter_user_id
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

/**
 * Admin review flag for a node whose burn-report penalty alone would push it below
 * the quarantine threshold (reports never auto-quarantine). Upserts an open
 * collusion_flags row (kind 'report_penalty'); skipped when an admin dismissed the
 * same flag within the report window. share_bps carries the penalty (0..10000).
 */
export async function flagReportPenaltyReview(nodeId: string, penalty: number): Promise<boolean> {
  const p = Number.isFinite(penalty) ? Math.max(0, Math.min(10_000, Math.round(penalty))) : 0;
  const r = await query<{ id: string }>(
    `INSERT INTO collusion_flags (kind, owner_user_id, node_id, requester_user_id, share_bps, volume_musd, total_musd, window_days)
     SELECT 'report_penalty', n.owner_user_id, n.id, NULL, $2, 0, 0, $3
     FROM nodes n
     WHERE n.id = $1::uuid
       AND NOT EXISTS (
         SELECT 1 FROM collusion_flags f
         WHERE f.kind = 'report_penalty' AND f.node_id = n.id AND f.status = 'dismissed'
           AND f.resolved_at > now() - make_interval(days => $3))
     ON CONFLICT (kind, owner_user_id,
                  COALESCE(node_id, '00000000-0000-0000-0000-000000000000'::uuid),
                  COALESCE(requester_user_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'open'
     DO UPDATE SET share_bps = EXCLUDED.share_bps, last_seen_at = now()
     RETURNING id`,
    [nodeId, p, REPORT_WINDOW_DAYS],
  );
  return r.rows.length > 0;
}
