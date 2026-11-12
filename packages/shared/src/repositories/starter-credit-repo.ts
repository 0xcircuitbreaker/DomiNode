import { isIP } from "node:net";
import type pg from "pg";
import { query } from "../db.js";
import { withTx } from "./node-credit-repo.js";
import { getBaseTxCount } from "../starter-funding.js";

/**
 * Starter credits (LAUNCH_PLAN §5.2, ECONOMICS.md "Starter credits").
 *
 * - One grant per agent principal (UNIQUE user_id), on its first verified wallet identity.
 * - Credited to the requester wallet as whole cents; the grant row tracks what is left.
 * - Abuse caps, all inside one transaction under an advisory lock: global daily
 *   budget, per-/24 (IPv4) or /48 (IPv6) cap and per-funding-source cap over a window.
 * - Spend is attributed at settle time (consumeTx) and stamped on the relay charge
 *   (relay_charges.starter_musd) so tier inputs can exclude it.
 * - Unused remainder is removed from the wallet when the grant expires.
 */

type TxClient = Pick<pg.PoolClient, "query">;

export const MUSD_PER_CENT = 10_000n;
const GRANT_LOCK = 0x5354_4152; // "STAR"

export interface StarterSettings {
  enabled: boolean;
  amountMusd: bigint;
  dailyBudgetMusd: bigint;
  perPrefixCap: number;
  perFundingSourceCap: number;
  capWindowDays: number;
  expiryDays: number;
  seedNodesOnly: boolean;
  seedOnlyDays: number;
  /** Require ≥1 prior Base transaction or a paid top-up of ≥ minTopupCents. */
  requireFunding: boolean;
  minTopupCents: number;
  updatedBy: string | null;
  updatedAt: Date | null;
}

interface SettingsRow {
  enabled: boolean; amount_musd: string; daily_budget_musd: string; per_prefix_cap: number; per_funding_source_cap: number;
  cap_window_days: number; expiry_days: number; seed_nodes_only: boolean; seed_only_days: number; require_funding?: boolean; min_topup_cents?: number;
  updated_by: string | null; updated_at: Date | null;
}

export const SETTINGS_COLS = `enabled, amount_musd::text AS amount_musd, daily_budget_musd::text AS daily_budget_musd,
  per_prefix_cap, per_funding_source_cap, cap_window_days, expiry_days, seed_nodes_only, seed_only_days, require_funding, min_topup_cents, updated_by, updated_at`;

export const DEFAULT_STARTER_SETTINGS: StarterSettings = {
  enabled: false, amountMusd: 500_000n, dailyBudgetMusd: 50_000_000n, perPrefixCap: 1, perFundingSourceCap: 1,
  capWindowDays: 30, expiryDays: 30, seedNodesOnly: true, seedOnlyDays: 30, requireFunding: true, minTopupCents: 100, updatedBy: null, updatedAt: null,
};

function mapSettings(r: SettingsRow | undefined): StarterSettings {
  if (!r) return { ...DEFAULT_STARTER_SETTINGS };
  return {
    enabled: r.enabled, amountMusd: BigInt(r.amount_musd), dailyBudgetMusd: BigInt(r.daily_budget_musd),
    perPrefixCap: r.per_prefix_cap, perFundingSourceCap: r.per_funding_source_cap, capWindowDays: r.cap_window_days,
    expiryDays: r.expiry_days, seedNodesOnly: r.seed_nodes_only, seedOnlyDays: r.seed_only_days,
    requireFunding: r.require_funding ?? true, minTopupCents: r.min_topup_cents ?? 100,
    updatedBy: r.updated_by, updatedAt: r.updated_at,
  };
}

export async function getSettings(client?: TxClient): Promise<StarterSettings> {
  const sql = `SELECT ${SETTINGS_COLS} FROM starter_credit_settings WHERE id = 1`;
  const r = client ? await client.query<SettingsRow>(sql) : await query<SettingsRow>(sql);
  return mapSettings(r.rows[0]);
}

/** /24 for IPv4, /48 for IPv6, as CIDR text; null if not an IP. */
export function grantPrefix(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const a = ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  if (isIP(a) === 4) {
    const p = a.split(".");
    return `${p[0]}.${p[1]}.${p[2]}.0/24`;
  }
  if (isIP(a) === 6) {
    // Expand to 8 groups, keep the first 3.
    const [head, tail = ""] = a.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const groups = a.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
    return `${groups.slice(0, 3).map((g) => (g || "0").toLowerCase()).join(":")}::/48`;
  }
  return null;
}

export type GrantRefusal = "disabled" | "already_granted" | "budget_exhausted" | "prefix_cap" | "funding_source_cap" | "no_wallet" | "invalid" | "unfunded";
export type GrantResult =
  | { granted: true; grantId: string; amountMusd: bigint; expiresAt: Date }
  | { granted: false; reason: GrantRefusal };

export interface GrantInput {
  userId: string;
  /** Funding source identity: the verified wallet address (lowercased) or payer identity. */
  fundingSource: string;
  clientIp: string | null;
  /** Base nonce of the wallet, looked up before the transaction; null = unknown (fails closed). */
  onchainTxCount?: number | null;
}

/** Paid top-ups (a payment provider, not node-credit conversion, starter or referral credit). */
export const PAID_TOPUP_SQL = `SELECT 1 AS one FROM wallet_transactions wt JOIN wallets w ON w.id = wt.wallet_id
  WHERE w.user_id = $1 AND wt.type = 'topup' AND wt.amount_cents >= $2
    AND wt.payment_provider IS NOT NULL AND wt.payment_provider <> 'node_credits' LIMIT 1`;

/** Decide caps on the caller's transaction (exported for tests). */
export async function grantTx(c: TxClient, i: GrantInput, now: Date = new Date()): Promise<GrantResult> {
  const fundingSource = i.fundingSource.trim().toLowerCase();
  if (!fundingSource || fundingSource.length > 128) return { granted: false, reason: "invalid" };
  await c.query("SELECT pg_advisory_xact_lock($1)", [GRANT_LOCK]);
  const s = await getSettings(c);
  if (!s.enabled || s.amountMusd <= 0n) return { granted: false, reason: "disabled" };
  const prior = await c.query<{ one: number }>(`SELECT 1 AS one FROM starter_credit_grants WHERE user_id = $1`, [i.userId]);
  if (prior.rows.length > 0) return { granted: false, reason: "already_granted" };
  if (s.requireFunding && !((i.onchainTxCount ?? 0) >= 1)) {
    const t = await c.query<{ one: number }>(PAID_TOPUP_SQL, [i.userId, s.minTopupCents]);
    if (t.rows.length === 0) return { granted: false, reason: "unfunded" };
  }

  const prefix = grantPrefix(i.clientIp);
  const counts = await c.query<{ today_musd: string | null; prefix_n: string; funding_n: string }>(
    `SELECT
       (SELECT SUM(amount_musd) FROM starter_credit_grants WHERE created_at >= date_trunc('day', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::text AS today_musd,
       (SELECT COUNT(*) FROM starter_credit_grants WHERE $2::cidr IS NOT NULL AND ip_prefix = $2::cidr
          AND created_at > $1::timestamptz - make_interval(days => $4))::text AS prefix_n,
       (SELECT COUNT(*) FROM starter_credit_grants WHERE funding_source = $3
          AND created_at > $1::timestamptz - make_interval(days => $4))::text AS funding_n`,
    [now.toISOString(), prefix, fundingSource, s.capWindowDays],
  );
  const row = counts.rows[0];
  const today = BigInt(row?.today_musd ?? "0");
  if (today + s.amountMusd > s.dailyBudgetMusd) return { granted: false, reason: "budget_exhausted" };
  // A missing client IP can never be cap-checked: refuse rather than skip the cap.
  if (!prefix || Number(row?.prefix_n ?? 0) >= s.perPrefixCap) return { granted: false, reason: "prefix_cap" };
  if (Number(row?.funding_n ?? 0) >= s.perFundingSourceCap) return { granted: false, reason: "funding_source_cap" };

  const cents = s.amountMusd / MUSD_PER_CENT;
  const w = await c.query<{ id: string }>(
    `UPDATE wallets SET balance_cents = balance_cents + $2
     WHERE user_id = $1 AND balance_cents + $2 <= 1000000 RETURNING id`,
    [i.userId, cents.toString()],
  );
  const walletId = w.rows[0]?.id;
  if (!walletId) return { granted: false, reason: "no_wallet" };
  await c.query(
    `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description) VALUES ($1, 'topup', $2, 'Starter credit (non-withdrawable, expires)')`,
    [walletId, cents.toString()],
  );
  const g = await c.query<{ id: string; expires_at: Date }>(
    `INSERT INTO starter_credit_grants (user_id, amount_musd, remaining_musd, ip_prefix, funding_source, expires_at)
     VALUES ($1, $2, $2, $3::cidr, $4, $5::timestamptz + make_interval(days => $6))
     RETURNING id, expires_at`,
    [i.userId, s.amountMusd.toString(), prefix, fundingSource, now.toISOString(), s.expiryDays],
  );
  const grant = g.rows[0];
  await c.query(`INSERT INTO starter_credit_ledger (grant_id, type, amount_musd) VALUES ($1, 'grant', $2)`, [grant.id, s.amountMusd.toString()]);
  return { granted: true, grantId: grant.id, amountMusd: s.amountMusd, expiresAt: grant.expires_at };
}

export async function grantStarterCredit(i: GrantInput, lookup: (addr: string) => Promise<number | null> = getBaseTxCount): Promise<GrantResult> {
  // The RPC call happens outside the transaction so the grant lock is never held across the network.
  let onchainTxCount = i.onchainTxCount ?? null;
  if (onchainTxCount === null) {
    const s = await getSettings();
    if (!s.enabled) return { granted: false, reason: "disabled" };
    if (s.requireFunding && /^0x[0-9a-f]{40}$/i.test(i.fundingSource.trim())) onchainTxCount = await lookup(i.fundingSource.trim());
  }
  return withTx((c) => grantTx(c, { ...i, onchainTxCount }));
}

export interface ActiveGrant {
  id: string;
  amountMusd: bigint;
  remainingMusd: bigint;
  status: string;
  expiresAt: Date;
  createdAt: Date;
}

interface GrantRow { id: string; amount_musd: string; remaining_musd: string; status: string; expires_at: Date; created_at: Date }
const GRANT_COLS = `id, amount_musd::text AS amount_musd, remaining_musd::text AS remaining_musd, status, expires_at, created_at`;

function mapGrant(r: GrantRow): ActiveGrant {
  return { id: r.id, amountMusd: BigInt(r.amount_musd), remainingMusd: BigInt(r.remaining_musd), status: r.status, expiresAt: r.expires_at, createdAt: r.created_at };
}

/** The user's grant (any status), or null. */
export async function getGrant(userId: string): Promise<ActiveGrant | null> {
  const r = await query<GrantRow>(`SELECT ${GRANT_COLS} FROM starter_credit_grants WHERE user_id = $1`, [userId]);
  return r.rows[0] ? mapGrant(r.rows[0]) : null;
}

/**
 * Whether this requester's sessions must stay on operator-run seed nodes:
 * seedNodesOnly is on, the grant is active with credit left, and it is
 * younger than seedOnlyDays.
 */
export async function isSeedOnlyRequester(userId: string, now: Date = new Date()): Promise<boolean> {
  const s = await getSettings();
  if (!s.seedNodesOnly || s.seedOnlyDays <= 0) return false;
  const g = await getGrant(userId);
  if (!g || g.status !== "active" || g.remainingMusd <= 0n || g.expiresAt <= now) return false;
  return now.getTime() - g.createdAt.getTime() < s.seedOnlyDays * 86_400_000;
}

/**
 * Attribute up to `chargeMusd` of a settled wallet charge to the user's active
 * grant (caller's settle transaction). Returns the µUSD drawn from starter credit.
 */
export async function consumeTx(c: TxClient, userId: string, chargeMusd: bigint, relayChargeId: string): Promise<bigint> {
  if (chargeMusd <= 0n) return 0n;
  const r = await c.query<{ id: string; remaining_musd: string }>(
    `SELECT id, remaining_musd::text AS remaining_musd FROM starter_credit_grants
     WHERE user_id = $1 AND status = 'active' AND remaining_musd > 0 AND expires_at > now() FOR UPDATE`,
    [userId],
  );
  const g = r.rows[0];
  if (!g) return 0n;
  const remaining = BigInt(g.remaining_musd);
  const used = chargeMusd < remaining ? chargeMusd : remaining;
  await c.query(
    `UPDATE starter_credit_grants SET remaining_musd = remaining_musd - $2,
       status = CASE WHEN remaining_musd - $2 = 0 THEN 'exhausted' ELSE status END,
       closed_at = CASE WHEN remaining_musd - $2 = 0 THEN now() ELSE closed_at END
     WHERE id = $1`,
    [g.id, used.toString()],
  );
  await c.query(`INSERT INTO starter_credit_ledger (grant_id, type, amount_musd, relay_charge_id) VALUES ($1, 'spend', $2, $3)`, [g.id, used.toString(), relayChargeId]);
  await c.query(`UPDATE relay_charges SET starter_musd = $2 WHERE id = $1`, [relayChargeId, used.toString()]);
  return used;
}

/**
 * Whole cents of the personal wallet that are unspent starter credit and may
 * not leave it (team/agentic funding). Locks the active grant FOR UPDATE on the
 * caller's transaction; call AFTER locking the personal wallet (same order as
 * settlement: wallet, then grant). Rounds UP so no sub-cent of starter credit
 * can be moved out.
 */
export async function lockedStarterCentsTx(c: TxClient, userId: string): Promise<number> {
  const r = await c.query<{ remaining_musd: string }>(
    `SELECT remaining_musd::text AS remaining_musd FROM starter_credit_grants
     WHERE user_id = $1 AND status = 'active' AND remaining_musd > 0 FOR UPDATE`,
    [userId],
  );
  const g = r.rows[0];
  if (!g) return 0;
  return Number((BigInt(g.remaining_musd) + MUSD_PER_CENT - 1n) / MUSD_PER_CENT);
}

/** Close a grant and remove its unused remainder from the wallet (whole cents, never below 0). */
export async function closeGrantTx(c: TxClient, grantId: string, status: "expired" | "revoked", by: string | null): Promise<{ removedCents: bigint } | null> {
  const r = await c.query<{ id: string; user_id: string; remaining_musd: string }>(
    `SELECT id, user_id, remaining_musd::text AS remaining_musd FROM starter_credit_grants WHERE id = $1 AND status = 'active' FOR UPDATE`,
    [grantId],
  );
  const g = r.rows[0];
  if (!g) return null;
  const wantCents = BigInt(g.remaining_musd) / MUSD_PER_CENT;
  let removed = 0n;
  if (wantCents > 0n) {
    const w = await c.query<{ id: string; balance_cents: number }>(`SELECT id, balance_cents FROM wallets WHERE user_id = $1 FOR UPDATE`, [g.user_id]);
    const wallet = w.rows[0];
    if (wallet) {
      const bal = BigInt(wallet.balance_cents);
      removed = wantCents < bal ? wantCents : bal;
      if (removed > 0n) {
        await c.query(`UPDATE wallets SET balance_cents = balance_cents - $2 WHERE id = $1`, [wallet.id, removed.toString()]);
        await c.query(
          `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description) VALUES ($1, 'debit', $2, $3)`,
          [wallet.id, removed.toString(), status === "expired" ? "Starter credit expired" : "Starter credit revoked"],
        );
      }
    }
  }
  await c.query(`UPDATE starter_credit_grants SET status = $2, closed_at = now() WHERE id = $1`, [grantId, status]);
  await c.query(
    `INSERT INTO starter_credit_ledger (grant_id, type, amount_musd, created_by) VALUES ($1, $2, $3, $4)`,
    [grantId, status === "expired" ? "expire" : "revoke", (removed * MUSD_PER_CENT).toString(), by],
  );
  return { removedCents: removed };
}

/** Expire due grants, one transaction each (expiry job). */
export async function expireDue(limit = 1000): Promise<{ expired: number; removedCents: bigint }> {
  const due = await query<{ id: string }>(
    `SELECT id FROM starter_credit_grants WHERE status = 'active' AND expires_at <= now() ORDER BY expires_at LIMIT $1`,
    [limit],
  );
  let expired = 0;
  let removedCents = 0n;
  for (const d of due.rows) {
    const r = await withTx((c) => closeGrantTx(c, d.id, "expired", null));
    if (r) { expired++; removedCents += r.removedCents; }
  }
  return { expired, removedCents };
}
