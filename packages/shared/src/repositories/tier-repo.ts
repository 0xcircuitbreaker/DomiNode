import { query } from "../db.js";
import { withTx } from "./node-credit-repo.js";

/** Node owner tiers (DESIGN.md §15). */

export const UPTIME_GRACE_DAYS = 3;
const DAY_MS = 86_400_000;

export interface NodeTier {
  id: number;
  name: string;
  rank: number;
  nodeShareBps: number;
  minTenureDays: number;
  minUptimeBps: number;
  minActiveIps: number;
  minReputation: number;
  noClawbackDays: number;
  holdDays: number;
  maxNodes: number;
  dailyWithdrawLimitMusd: bigint;
}

export interface OwnerTierStats {
  tenureDays: number;
  uptimeBps: number;
  activeIps: number;
  reputation: number; // 0..10000
  daysSinceLastClawback: number | null; // null = never
}

export interface OwnerTierState {
  tierId: number | null;
  graceUntil: Date | null;
}

export interface TierDecision {
  tierId: number;
  direction: "promote" | "demote" | "hold";
  graceUntil: Date | null;
  demotionReason: string | null;
}

function qualityFailures(t: NodeTier, s: OwnerTierStats): string[] {
  const f: string[] = [];
  if (s.tenureDays < t.minTenureDays) f.push("tenure");
  if (s.activeIps < t.minActiveIps) f.push("active_ips");
  if (s.reputation < t.minReputation) f.push("reputation");
  if (t.noClawbackDays > 0 && s.daysSinceLastClawback !== null && s.daysSinceLastClawback < t.noClawbackDays) {
    f.push("recent_clawback");
  }
  return f;
}

const uptimeOk = (t: NodeTier, s: OwnerTierStats) => s.uptimeBps >= t.minUptimeBps;
const fullyQualifies = (t: NodeTier, s: OwnerTierStats) => qualityFailures(t, s).length === 0 && uptimeOk(t, s);

/**
 * Pure tier decision. Promote at most one step; demote immediately on a
 * quality failure; uptime misses get a 3-day grace before demotion.
 * Rank 0 (probation) is the floor.
 */
export function computeOwnerTier(
  tiersIn: NodeTier[],
  stats: OwnerTierStats,
  current: OwnerTierState,
  now: Date = new Date(),
): TierDecision {
  if (tiersIn.length === 0) throw new Error("No tiers configured");
  const tiers = [...tiersIn].sort((a, b) => a.rank - b.rank);
  let ci = tiers.findIndex((t) => t.id === current.tierId);
  if (ci < 0) ci = 0;
  const cur = tiers[ci];

  const highestQualifyingBelow = (idx: number): number => {
    for (let i = idx; i > 0; i--) if (fullyQualifies(tiers[i], stats)) return i;
    return 0;
  };

  const qf = qualityFailures(cur, stats);
  if (ci > 0 && qf.length > 0) {
    const ti = highestQualifyingBelow(ci - 1);
    return { tierId: tiers[ti].id, direction: "demote", graceUntil: null, demotionReason: qf.join(",") };
  }
  if (ci > 0 && !uptimeOk(cur, stats)) {
    if (!current.graceUntil) {
      return { tierId: cur.id, direction: "hold", graceUntil: new Date(now.getTime() + UPTIME_GRACE_DAYS * DAY_MS), demotionReason: null };
    }
    if (current.graceUntil.getTime() > now.getTime()) {
      return { tierId: cur.id, direction: "hold", graceUntil: current.graceUntil, demotionReason: null };
    }
    const ti = highestQualifyingBelow(ci - 1);
    return { tierId: tiers[ti].id, direction: "demote", graceUntil: null, demotionReason: "uptime" };
  }
  const next = tiers[ci + 1];
  if (next && fullyQualifies(next, stats)) {
    return { tierId: next.id, direction: "promote", graceUntil: null, demotionReason: null };
  }
  return { tierId: cur.id, direction: "hold", graceUntil: null, demotionReason: null };
}

interface TierRow {
  id: number; name: string; rank: number; node_share_bps: number; min_tenure_days: number;
  min_uptime_bps: number; min_active_ips: number; min_reputation: number; no_clawback_days: number;
  hold_days: number; max_nodes: number; daily_withdraw_limit_musd: string;
}

const TIER_COLS = `id, name, rank, node_share_bps, min_tenure_days, min_uptime_bps, min_active_ips,
  min_reputation, no_clawback_days, hold_days, max_nodes, daily_withdraw_limit_musd`;

export function mapTier(r: TierRow): NodeTier {
  return {
    id: r.id, name: r.name, rank: r.rank, nodeShareBps: r.node_share_bps, minTenureDays: r.min_tenure_days,
    minUptimeBps: r.min_uptime_bps, minActiveIps: r.min_active_ips, minReputation: r.min_reputation,
    noClawbackDays: r.no_clawback_days, holdDays: r.hold_days, maxNodes: r.max_nodes,
    dailyWithdrawLimitMusd: BigInt(r.daily_withdraw_limit_musd),
  };
}

export async function listTiers(): Promise<NodeTier[]> {
  const r = await query<TierRow>(`SELECT ${TIER_COLS} FROM node_tiers ORDER BY rank`);
  return r.rows.map(mapTier);
}

/** Owner's effective tier (probation when unset). */
export async function getOwnerTier(userId: string): Promise<NodeTier> {
  const r = await query<TierRow>(
    `SELECT ${TIER_COLS} FROM node_tiers
     WHERE id = COALESCE((SELECT node_tier_id FROM users WHERE id = $1),
                         (SELECT id FROM node_tiers ORDER BY rank LIMIT 1))`,
    [userId],
  );
  if (!r.rows[0]) throw new Error("Tier lookup failed"); // fail closed
  return mapTier(r.rows[0]);
}

/** Snapshot taken at session start and passed to settleRelayCharge. */
export interface ChargeSnapshot {
  splitConfigId: number;
  tierId: number;
  nodeShareBps: number;
  holdDays: number;
}

export async function getChargeSnapshot(ownerUserId: string): Promise<ChargeSnapshot> {
  const tier = await getOwnerTier(ownerUserId);
  const c = await query<{ id: number }>(
    `SELECT id FROM revenue_split_config WHERE effective_from <= now() ORDER BY effective_from DESC, id DESC LIMIT 1`,
  );
  if (!c.rows[0]) throw new Error("Split config lookup failed"); // fail closed
  return { splitConfigId: c.rows[0].id, tierId: tier.id, nodeShareBps: Math.min(tier.nodeShareBps, 5000), holdDays: tier.holdDays };
}

/**
 * Gather tier inputs for one owner. Only matured, undisputed paid traffic
 * from other principals counts. Uptime comes from the caller (health job).
 */
export async function getOwnerTierStats(userId: string, uptimeBps: number): Promise<OwnerTierStats> {
  const r = await query<{ tenure_days: string; active_ips: string; reputation: string | null; last_clawback_days: string | null }>(
    `SELECT
       (SELECT COUNT(DISTINCT created_at::date) FROM relay_charges
         WHERE node_owner_user_id = $1 AND matured AND NOT disputed AND node_musd > 0
           AND requester_user_id IS DISTINCT FROM $1) AS tenure_days,
       (SELECT COUNT(*) FROM (
          SELECT n.observed_ip FROM relay_charges rc JOIN nodes n ON n.id = rc.node_id
          WHERE rc.node_owner_user_id = $1 AND rc.created_at >= now() - interval '7 days'
            AND rc.gross_musd > 0 AND NOT rc.disputed AND n.observed_ip IS NOT NULL
            AND rc.requester_user_id IS DISTINCT FROM $1
          GROUP BY n.observed_ip HAVING COUNT(DISTINCT rc.requester_user_id) >= 3) ips) AS active_ips,
       (SELECT AVG(reputation)::int FROM nodes WHERE owner_user_id = $1 AND status = 'active') AS reputation,
       (SELECT EXTRACT(DAY FROM now() - MAX(created_at))::int FROM node_credit_transactions
         WHERE user_id = $1 AND type = 'clawback') AS last_clawback_days`,
    [userId],
  );
  const row = r.rows[0];
  return {
    tenureDays: Number(row?.tenure_days ?? 0),
    uptimeBps,
    activeIps: Number(row?.active_ips ?? 0),
    reputation: row?.reputation == null ? 0 : Number(row.reputation),
    daysSinceLastClawback: row?.last_clawback_days == null ? null : Number(row.last_clawback_days),
  };
}

/** Recalculate and persist one owner's tier (daily job). */
export async function applyOwnerTier(userId: string, stats: OwnerTierStats, now: Date = new Date()): Promise<TierDecision> {
  const tiers = await listTiers();
  return withTx(async (client) => {
    const u = await client.query<{ node_tier_id: number | null; node_tier_grace_until: Date | null }>(
      `SELECT node_tier_id, node_tier_grace_until FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!u.rows[0]) throw new Error("User not found");
    const d = computeOwnerTier(tiers, stats, { tierId: u.rows[0].node_tier_id, graceUntil: u.rows[0].node_tier_grace_until }, now);
    const changed = d.tierId !== u.rows[0].node_tier_id;
    await client.query(
      `UPDATE users SET node_tier_id = $2, node_tier_grace_until = $3,
         node_tier_demotion_reason = $4,
         node_tier_changed_at = CASE WHEN $5::boolean THEN now() ELSE node_tier_changed_at END
       WHERE id = $1`,
      [userId, d.tierId, d.graceUntil, d.demotionReason, changed],
    );
    return d;
  });
}

/** Node owners for the daily tier job, keyset-paginated by user id (≤1000 per page). */
export async function listTierOwners(afterUserId: string | null, limit = 1000): Promise<string[]> {
  const lim = Number.isInteger(limit) && limit > 0 && limit <= 1000 ? limit : 1000;
  const r = await query<{ owner_user_id: string }>(
    `SELECT DISTINCT owner_user_id FROM nodes
     WHERE status <> 'revoked' AND ($1::uuid IS NULL OR owner_user_id > $1::uuid)
     ORDER BY owner_user_id LIMIT $2`,
    [afterUserId, lim],
  );
  return r.rows.map((x) => x.owner_user_id);
}

/**
 * 30-day uptime approximation in basis points: share of the last 30 days on
 * which at least one of the owner's nodes carried a stream (node_daily_stats).
 */
export async function getOwnerUptimeBps(userId: string): Promise<number> {
  const r = await query<{ days: string }>(
    `SELECT COUNT(DISTINCT s.day) AS days FROM node_daily_stats s JOIN nodes n ON n.id = s.node_id
     WHERE n.owner_user_id = $1 AND s.day > current_date - 30 AND s.streams > 0`,
    [userId],
  );
  const days = Math.min(30, Math.max(0, Number(r.rows[0]?.days ?? 0)));
  return Math.round((days * 10_000) / 30);
}
