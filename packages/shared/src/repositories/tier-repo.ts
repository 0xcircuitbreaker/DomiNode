import { query } from "../db.js";
import { withTx } from "./node-credit-repo.js";
import { EXIT_CLASSES, tierWeightBpsFor, type ExitClass, type NodeIpClass } from "../exit-classes.js";

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
  /** Discount this tier gets when it BUYS relay bandwidth (platform-funded), 0..5000. */
  buyerDiscountBps: number;
}

export interface OwnerTierStats {
  tenureDays: number;
  uptimeBps: number;
  /**
   * Class-weighted active exit IPs (floor of sum(weight_bps)/10000): an IP
   * counts for its exit class's tier weight, e.g. 4 masked IPs at 0.25 = 1.
   */
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
  hold_days: number; max_nodes: number; daily_withdraw_limit_musd: string; buyer_discount_bps?: number;
}

const TIER_COLS = `id, name, rank, node_share_bps, min_tenure_days, min_uptime_bps, min_active_ips,
  min_reputation, no_clawback_days, hold_days, max_nodes, daily_withdraw_limit_musd, buyer_discount_bps`;

export function mapTier(r: TierRow): NodeTier {
  return {
    id: r.id, name: r.name, rank: r.rank, nodeShareBps: r.node_share_bps, minTenureDays: r.min_tenure_days,
    minUptimeBps: r.min_uptime_bps, minActiveIps: r.min_active_ips, minReputation: r.min_reputation,
    noClawbackDays: r.no_clawback_days, holdDays: r.hold_days, maxNodes: r.max_nodes,
    dailyWithdrawLimitMusd: BigInt(r.daily_withdraw_limit_musd),
    buyerDiscountBps: r.buyer_discount_bps ?? 0,
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
  /** Owner tier share + genesis bonus, capped at the 5000 bps ceiling. */
  nodeShareBps: number;
  holdDays: number;
  /** Part of nodeShareBps that is the genesis bonus (0 when not in the cohort). */
  genesisBonusBps?: number;
  /** Requester (buyer) tier discount snapshot; absent/0 = list price. */
  buyerTierId?: number | null;
  buyerDiscountBps?: number;
  minPlatformMarginBps?: number;
  /** Tier-credit weight of the serving node's exit class at session start (bps). */
  tierWeightBps?: number;
}

export const MAX_NODE_SHARE_BPS = 5000;

/** Genesis bonus that fits under the ceiling (pure). */
export function genesisBonusFor(tierShareBps: number, bonusBps: number): number {
  const room = Math.max(0, MAX_NODE_SHARE_BPS - Math.min(tierShareBps, MAX_NODE_SHARE_BPS));
  return Math.max(0, Math.min(bonusBps, room));
}

/** Current per-class tier weights (bps); missing rows use defaults. */
export async function getTierWeights(): Promise<Record<ExitClass, number>> {
  const r = await query<{ ip_class: string; tier_weight_bps: number }>(
    `SELECT ip_class, tier_weight_bps FROM network_pricing WHERE ip_class <> 'any'`,
  );
  const raw: Partial<Record<ExitClass, number>> = {};
  for (const x of r.rows) {
    if ((EXIT_CLASSES as readonly string[]).includes(x.ip_class)) raw[x.ip_class as ExitClass] = Number(x.tier_weight_bps);
  }
  const out = {} as Record<ExitClass, number>;
  for (const c of EXIT_CLASSES) out[c] = tierWeightBpsFor(c, raw);
  return out;
}

/**
 * Owner share snapshot for a session. With `ipClass` (the serving node's
 * verified class) the class tier weight is snapshotted too, like node share.
 */
export async function getChargeSnapshot(ownerUserId: string, ipClass?: NodeIpClass | null): Promise<ChargeSnapshot> {
  const tier = await getOwnerTier(ownerUserId);
  const c = await query<{ id: number }>(
    `SELECT id FROM revenue_split_config WHERE effective_from <= now() ORDER BY effective_from DESC, id DESC LIMIT 1`,
  );
  if (!c.rows[0]) throw new Error("Split config lookup failed"); // fail closed
  const base = Math.min(tier.nodeShareBps, MAX_NODE_SHARE_BPS);
  // Genesis boost (LAUNCH_PLAN §4.2): active cohort member with an unexpired boost.
  const g = await query<{ bonus_bps: number }>(
    `SELECT s.bonus_bps FROM genesis_settings s JOIN genesis_members m ON m.owner_user_id = $1
     WHERE s.id = 1 AND s.enabled AND m.boost_until > now()`,
    [ownerUserId],
  );
  const bonus = g.rows[0] ? genesisBonusFor(base, Number(g.rows[0].bonus_bps)) : 0;
  const snap: ChargeSnapshot = { splitConfigId: c.rows[0].id, tierId: tier.id, nodeShareBps: base + bonus, holdDays: tier.holdDays, genesisBonusBps: bonus };
  if (ipClass !== undefined) snap.tierWeightBps = tierWeightBpsFor(ipClass, await getTierWeights());
  return snap;
}

export interface BuyerDiscountSnapshot {
  buyerTierId: number | null;
  buyerDiscountBps: number;
  minPlatformMarginBps: number;
}

/**
 * Requester discount by owner tier. Only principals that own a (non-revoked)
 * node have a tier; everyone else pays list price. Fails closed to no discount
 * is NOT done here: callers treat a lookup error like any pricing error.
 */
export async function getBuyerDiscount(requesterUserId: string): Promise<BuyerDiscountSnapshot> {
  const r = await query<{ tier_id: number | null; buyer_discount_bps: number | null; enabled: boolean | null; min_platform_margin_bps: number | null }>(
    `SELECT t.id AS tier_id, t.buyer_discount_bps, s.enabled, s.min_platform_margin_bps
     FROM (SELECT 1) one
     LEFT JOIN buyer_discount_settings s ON s.id = 1
     LEFT JOIN LATERAL (
       SELECT nt.id, nt.buyer_discount_bps FROM node_tiers nt
       WHERE EXISTS (SELECT 1 FROM nodes n WHERE n.owner_user_id = $1 AND n.status <> 'revoked')
         AND nt.id = COALESCE((SELECT node_tier_id FROM users WHERE id = $1),
                              (SELECT id FROM node_tiers ORDER BY rank LIMIT 1))
     ) t ON true`,
    [requesterUserId],
  );
  const row = r.rows[0];
  const margin = row?.min_platform_margin_bps ?? 2500;
  if (!row || row.tier_id == null || row.enabled === false) {
    return { buyerTierId: row?.tier_id ?? null, buyerDiscountBps: 0, minPlatformMarginBps: margin };
  }
  return { buyerTierId: row.tier_id, buyerDiscountBps: Math.max(0, Math.min(5000, row.buyer_discount_bps ?? 0)), minPlatformMarginBps: margin };
}

/**
 * Gather tier inputs for one owner. Only matured, undisputed paid traffic
 * from other principals counts. Uptime comes from the caller (health job).
 */
export async function getOwnerTierStats(userId: string, uptimeBps: number): Promise<OwnerTierStats> {
  const r = await query<{ tenure_days: string; active_ips_weight_bps: string; reputation: string | null; last_clawback_days: string | null }>(
    `SELECT
       (SELECT COUNT(DISTINCT created_at::date) FROM relay_charges
         WHERE node_owner_user_id = $1 AND matured AND NOT disputed AND node_musd > 0 AND starter_musd = 0
           AND requester_user_id IS DISTINCT FROM $1) AS tenure_days,
       -- Class-weighted active IPs: per IP the lowest snapshotted weight
       -- (pre-feature rows: the node's current class weight, else the lowest).
       (SELECT COALESCE(SUM(w), 0) FROM (
          SELECT MIN(COALESCE(rc.tier_weight_bps,
                   (SELECT np.tier_weight_bps FROM network_pricing np WHERE np.ip_class = n.ip_class),
                   (SELECT MIN(np.tier_weight_bps) FROM network_pricing np WHERE np.ip_class <> 'any'),
                   0)) AS w
          FROM relay_charges rc JOIN nodes n ON n.id = rc.node_id
          WHERE rc.node_owner_user_id = $1 AND rc.created_at >= now() - interval '7 days'
            AND rc.gross_musd > 0 AND rc.starter_musd = 0 AND NOT rc.disputed AND n.observed_ip IS NOT NULL
            AND rc.requester_user_id IS DISTINCT FROM $1
          GROUP BY n.observed_ip HAVING COUNT(DISTINCT rc.requester_user_id) >= 3) ips) AS active_ips_weight_bps,
       (SELECT AVG(GREATEST(0, reputation - report_penalty))::int FROM nodes WHERE owner_user_id = $1 AND status = 'active') AS reputation,
       (SELECT EXTRACT(DAY FROM now() - MAX(created_at))::int FROM node_credit_transactions
         WHERE user_id = $1 AND type = 'clawback') AS last_clawback_days`,
    [userId],
  );
  const row = r.rows[0];
  return {
    tenureDays: Number(row?.tenure_days ?? 0),
    uptimeBps,
    activeIps: activeIpsFromWeightBps(row?.active_ips_weight_bps),
    reputation: row?.reputation == null ? 0 : Number(row.reputation),
    daysSinceLastClawback: row?.last_clawback_days == null ? null : Number(row.last_clawback_days),
  };
}

/** floor(sum of per-IP weights / 10000), BigInt-safe; garbage -> 0. */
export function activeIpsFromWeightBps(v: string | number | null | undefined): number {
  const t = v === null || v === undefined ? "0" : String(v);
  if (!/^\d{1,18}$/.test(t)) return 0;
  return Number(BigInt(t) / 10_000n);
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
 * 30-day uptime in basis points, measured by the gateway from tunnel
 * liveness (ECONOMICS.md rule 3): for each of the last 30 days, the longest
 * time any of the owner's nodes had its tunnel open (node_daily_stats
 * .online_seconds, capped at a day), summed and divided by 30 days.
 */
export async function getOwnerUptimeBps(userId: string): Promise<number> {
  const r = await query<{ seconds: string | null }>(
    `SELECT SUM(d.best) AS seconds FROM (
       SELECT s.day, MAX(LEAST(s.online_seconds, 86400)) AS best
       FROM node_daily_stats s JOIN nodes n ON n.id = s.node_id
       WHERE n.owner_user_id = $1 AND s.day > current_date - 30
       GROUP BY s.day) d`,
    [userId],
  );
  const secs = Math.min(30 * 86_400, Math.max(0, Number(r.rows[0]?.seconds ?? 0) || 0));
  return Math.round((secs * 10_000) / (30 * 86_400));
}
