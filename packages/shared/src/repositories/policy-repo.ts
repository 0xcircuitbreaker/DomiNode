import { query, getPool } from "../db.js";
import type { PricingClass } from "../exit-classes.js";
import {
  validatePolicy,
  policySha256,
  DEFAULT_POLICY,
  type NetworkPolicy,
} from "../policy.js";

export interface ActivePolicy {
  version: number;
  sha256: string;
  body: NetworkPolicy;
  createdAt: Date | null;
}

interface PolicyRow {
  version: number;
  body: unknown;
  body_sha256: string;
  created_at: Date;
}

/** Advisory lock key serialising policy publishes (empty-table safe). */
const POLICY_PUBLISH_LOCK = 0x504f4c4943;

function rowToPolicy(row: PolicyRow): ActivePolicy {
  // Re-validate on read: a hand-edited row must never smuggle floor keys in.
  const body = validatePolicy(row.body);
  return { version: row.version, sha256: row.body_sha256, body, createdAt: row.created_at };
}

/** Latest published policy, or the compiled default (version 0) if none. */
export async function getActivePolicy(): Promise<ActivePolicy> {
  const r = await query<PolicyRow>(
    `SELECT version, body, body_sha256, created_at FROM network_policy ORDER BY version DESC LIMIT 1`,
  );
  const row = r.rows[0];
  if (!row) {
    return { version: 0, sha256: policySha256(DEFAULT_POLICY), body: structuredClone(DEFAULT_POLICY), createdAt: null };
  }
  return rowToPolicy(row);
}

export interface PublishResult {
  version: number;
  sha256: string;
  body: NetworkPolicy;
  previousVersion: number;
  /** True when attestation.minVersion was raised (caller drains older nodes). */
  attestationRaised: boolean;
}

/**
 * Validate and insert a new policy version. Validation against the current
 * version (grow-only sanctions, non-decreasing attestation) and the insert run
 * in one transaction under an advisory lock + FOR UPDATE on the latest row.
 */
/** Publish on the caller's transaction client (lock + FOR UPDATE + validate + insert). */
export async function publishPolicyTx(
  client: { query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }> },
  input: unknown,
  createdBy: string | null,
): Promise<PublishResult> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [POLICY_PUBLISH_LOCK]);
  const cur = await client.query<PolicyRow>(
    `SELECT version, body, body_sha256, created_at FROM network_policy ORDER BY version DESC LIMIT 1 FOR UPDATE`,
  );
  const currentRow = cur.rows[0];
  const current = currentRow ? validatePolicy(currentRow.body) : DEFAULT_POLICY;
  const body = validatePolicy(input, { current });
  const sha256 = policySha256(body);
  const ins = await client.query<{ version: number }>(
    `INSERT INTO network_policy (body, body_sha256, created_by) VALUES ($1::jsonb, $2, $3) RETURNING version`,
    [JSON.stringify(body), sha256, createdBy],
  );
  const insRow = ins.rows[0];
  if (!insRow) throw new Error("policy insert returned no row");
  return {
    version: insRow.version,
    sha256,
    body,
    previousVersion: currentRow?.version ?? 0,
    attestationRaised: body.attestation.minVersion > current.attestation.minVersion,
  };
}

export async function publishPolicy(input: unknown, createdBy: string | null): Promise<PublishResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const r = await publishPolicyTx(client, input, createdBy);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── Pricing ─────────────────────────────────────────────────────────

export type { PricingClass };

/**
 * Price per GB (1e9 bytes) in µUSD for ip_class.
 *
 * A class with its own row gets that price. A class with no row, and 'any'
 * (used for an unknown node class), gets the HIGHEST configured price: a
 * missing row must never make traffic cheaper. No rows at all fails closed.
 */
export async function getPricing(ipClass: PricingClass = "any"): Promise<bigint> {
  const r = await query<{ ip_class: string; price_per_gb_musd: string }>(
    `SELECT ip_class, price_per_gb_musd FROM network_pricing`,
  );
  if (r.rows.length === 0) throw new Error("network pricing not configured");
  if (ipClass !== "any") {
    const row = r.rows.find((x) => x.ip_class === ipClass);
    if (row) return BigInt(row.price_per_gb_musd);
  }
  let max = 0n;
  for (const x of r.rows) {
    const v = BigInt(x.price_per_gb_musd);
    if (v > max) max = v;
  }
  if (max <= 0n) throw new Error("network pricing not configured");
  return max;
}

export async function listPricing(): Promise<Array<{ ipClass: PricingClass; pricePerGbMusd: bigint; tierWeightBps: number; updatedAt: Date }>> {
  const r = await query<{ ip_class: PricingClass; price_per_gb_musd: string; tier_weight_bps: number; updated_at: Date }>(
    `SELECT ip_class, price_per_gb_musd, tier_weight_bps, updated_at FROM network_pricing ORDER BY ip_class`,
  );
  return r.rows.map((x) => ({
    ipClass: x.ip_class, pricePerGbMusd: BigInt(x.price_per_gb_musd), tierWeightBps: Number(x.tier_weight_bps), updatedAt: x.updated_at,
  }));
}


// ─── Split config ────────────────────────────────────────────────────

export interface SplitConfig {
  id: number;
  nodeShareBps: number;
  maturationHours: number;
  effectiveFrom: Date;
}

/** Current split = max(effective_from) <= now(). Fails closed. */
export async function getSplit(): Promise<SplitConfig> {
  const r = await query<{ id: number; node_share_bps: number; maturation_hours: number; effective_from: Date }>(
    `SELECT id, node_share_bps, maturation_hours, effective_from FROM revenue_split_config
     WHERE effective_from <= now() ORDER BY effective_from DESC, id DESC LIMIT 1`,
  );
  const row = r.rows[0];
  if (!row) throw new Error("revenue split not configured");
  return { id: row.id, nodeShareBps: row.node_share_bps, maturationHours: row.maturation_hours, effectiveFrom: row.effective_from };
}

// ─── Tiers ───────────────────────────────────────────────────────────

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

interface TierRow {
  id: number; name: string; rank: number; node_share_bps: number; min_tenure_days: number;
  min_uptime_bps: number; min_active_ips: number; min_reputation: number; no_clawback_days: number;
  hold_days: number; max_nodes: number; daily_withdraw_limit_musd: string; buyer_discount_bps?: number;
}

const TIER_COLS = `id, name, rank, node_share_bps, min_tenure_days, min_uptime_bps, min_active_ips,
  min_reputation, no_clawback_days, hold_days, max_nodes, daily_withdraw_limit_musd, buyer_discount_bps`;

function rowToTier(r: TierRow): NodeTier {
  return {
    id: r.id, name: r.name, rank: r.rank, nodeShareBps: r.node_share_bps,
    minTenureDays: r.min_tenure_days, minUptimeBps: r.min_uptime_bps, minActiveIps: r.min_active_ips,
    minReputation: r.min_reputation, noClawbackDays: r.no_clawback_days, holdDays: r.hold_days,
    maxNodes: r.max_nodes, dailyWithdrawLimitMusd: BigInt(r.daily_withdraw_limit_musd),
    buyerDiscountBps: r.buyer_discount_bps ?? 0,
  };
}

export async function listTiers(): Promise<NodeTier[]> {
  const r = await query<TierRow>(`SELECT ${TIER_COLS} FROM node_tiers ORDER BY rank ASC`);
  return r.rows.map(rowToTier);
}

export async function getTier(id: number): Promise<NodeTier | null> {
  const r = await query<TierRow>(`SELECT ${TIER_COLS} FROM node_tiers WHERE id = $1`, [id]);
  return r.rows[0] ? rowToTier(r.rows[0]) : null;
}

/** Owner's tier; users with no tier yet get the lowest-rank tier. Fails closed. */
export async function getOwnerTier(userId: string): Promise<NodeTier> {
  // Fail closed: unknown or non-active users get no tier.
  const u = await query<{ node_tier_id: number | null }>(
    `SELECT node_tier_id FROM users WHERE id = $1 AND status = 'active'`,
    [userId],
  );
  if (!u.rows[0]) throw new Error("user not found or not active");
  const tierId = u.rows[0].node_tier_id;
  const r = tierId === null
    ? await query<TierRow>(`SELECT ${TIER_COLS} FROM node_tiers ORDER BY rank ASC LIMIT 1`, [])
    : await query<TierRow>(`SELECT ${TIER_COLS} FROM node_tiers WHERE id = $1`, [tierId]);
  if (!r.rows[0]) throw new Error("node tiers not configured");
  return rowToTier(r.rows[0]);
}
