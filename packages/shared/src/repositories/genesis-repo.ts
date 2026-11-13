import type pg from "pg";
import { query } from "../db.js";
import { withTx, lockAccountTx } from "./node-credit-repo.js";
import { getOwnerTier } from "./tier-repo.js";

/**
 * Genesis cohort (LAUNCH_PLAN §4.2, ECONOMICS.md "Genesis boost").
 *
 * Seeded disabled: an admin turns it on (PUT /genesis/settings).
 *
 * Enrolment (daily job): the first max_owners node owners by their first paid,
 * non-self-dealing relay charge (node_musd > 0, which already excludes
 * self-dealing and quarantined traffic). An owner qualifies only once its nodes
 * carried matured paid traffic from at least min_distinct_payers distinct paying
 * principals, excluding linked principals (shared team, circular flow, or the
 * requester wallet being one of the owner's node wallets) and starter-credit
 * traffic. Owners of operator-run seed nodes and admin principals never take a slot.
 *
 * Benefit A: +bonus_bps share until boost_until (tier-repo getChargeSnapshot,
 * capped at 5000, snapshotted in relay_charges.genesis_bonus_bps).
 * One slot per beneficial owner (a shared team, payout wallet, node wallet or
 * egress prefix with an existing member blocks enrolment).
 * Benefit B: a one-time credit once matured node earnings from qualifying
 * payers reach credit_threshold_node_musd (default 2x the credit) and their
 * bytes reach credit_threshold_bytes, with no open collusion flag. It is credited
 * to pending with the owner tier's hold, matures like earnings, and can be
 * clawed back by an admin while held.
 */

type TxClient = Pick<pg.PoolClient, "query">;
const ENROL_LOCK = 0x4745_4e45; // "GENE"

export interface GenesisSettings {
  enabled: boolean;
  maxOwners: number;
  bonusBps: number;
  boostDays: number;
  creditMusd: bigint;
  creditThresholdBytes: bigint;
  minDistinctPayers: number;
  /** Matured node earnings (µUSD) from qualifying payers needed for the one-time credit. */
  creditThresholdNodeMusd: bigint;
  /** Paid, non-starter spend (µUSD) each payer must have on the owner's nodes to count. */
  minPayerSpendMusd: bigint;
  updatedBy: string | null;
  updatedAt: Date | null;
}

interface Row {
  enabled: boolean; max_owners: number; bonus_bps: number; boost_days: number; credit_musd: string;
  credit_threshold_bytes: string; min_distinct_payers: number; credit_threshold_node_musd: string | null;
  min_payer_spend_musd: string | null; updated_by: string | null; updated_at: Date | null;
}

export const DEFAULT_GENESIS_SETTINGS: GenesisSettings = {
  enabled: false, maxOwners: 200, bonusBps: 500, boostDays: 90, creditMusd: 5_000_000n,
  creditThresholdBytes: 5_000_000_000n, minDistinctPayers: 3,
  creditThresholdNodeMusd: 10_000_000n, minPayerSpendMusd: 1_000_000n, updatedBy: null, updatedAt: null,
};

export async function getSettings(client?: TxClient): Promise<GenesisSettings> {
  const sql = `SELECT enabled, max_owners, bonus_bps, boost_days, credit_musd::text AS credit_musd,
    credit_threshold_bytes::text AS credit_threshold_bytes, min_distinct_payers,
    credit_threshold_node_musd::text AS credit_threshold_node_musd, min_payer_spend_musd::text AS min_payer_spend_musd,
    updated_by, updated_at FROM genesis_settings WHERE id = 1`;
  const r = client ? await client.query<Row>(sql) : await query<Row>(sql);
  const x = r.rows[0];
  if (!x) return { ...DEFAULT_GENESIS_SETTINGS };
  return {
    enabled: x.enabled, maxOwners: x.max_owners, bonusBps: x.bonus_bps, boostDays: x.boost_days,
    creditMusd: BigInt(x.credit_musd), creditThresholdBytes: BigInt(x.credit_threshold_bytes),
    minDistinctPayers: x.min_distinct_payers ?? DEFAULT_GENESIS_SETTINGS.minDistinctPayers,
    creditThresholdNodeMusd: x.credit_threshold_node_musd == null ? DEFAULT_GENESIS_SETTINGS.creditThresholdNodeMusd : BigInt(x.credit_threshold_node_musd),
    minPayerSpendMusd: x.min_payer_spend_musd == null ? DEFAULT_GENESIS_SETTINGS.minPayerSpendMusd : BigInt(x.min_payer_spend_musd),
    updatedBy: x.updated_by, updatedAt: x.updated_at,
  };
}

/**
 * Qualifying (owner, payer) pairs: matured, undisputed, earning (node_musd > 0,
 * no starter credit, no zero_reason) traffic from a payer that is not linked to
 * the owner, that paid with real money (a per-request rail, or a payer with a
 * paid top-up), and that spent at least the min payer spend (µUSD, the given
 * parameter) on the owner's nodes. Linked = same principal, a shared team, a
 * circular flow (the owner paid the payer's nodes), or the payer's wallet
 * identity is one of the owner's node wallets. Columns: owner, requester,
 * node_musd, bytes.
 */
export const QUALIFYING_PAIRS_SQL = (minSpendParam: string): string => `
  SELECT q.node_owner_user_id AS owner, q.requester_user_id AS requester,
         SUM(q.node_musd) AS node_musd, SUM(q.bytes_gateway) AS bytes
  FROM relay_charges q
  LEFT JOIN users ru ON ru.id = q.requester_user_id
  WHERE q.matured AND NOT q.disputed AND q.node_musd > 0 AND q.starter_musd = 0 AND q.zero_reason IS NULL
    AND q.requester_user_id IS NOT NULL AND q.node_owner_user_id IS NOT NULL
    AND q.requester_user_id <> q.node_owner_user_id
    AND (q.payment_rail IN ('x402','mpp')
         OR EXISTS (SELECT 1 FROM wallet_transactions wt JOIN wallets w ON w.id = wt.wallet_id
                    WHERE w.user_id = q.requester_user_id AND wt.type = 'topup' AND wt.amount_cents > 0
                      AND wt.payment_provider IS NOT NULL AND wt.payment_provider <> 'node_credits'))
    AND NOT EXISTS (SELECT 1 FROM team_members a JOIN team_members b ON b.team_id = a.team_id
                    WHERE a.user_id = q.requester_user_id AND b.user_id = q.node_owner_user_id)
    AND NOT EXISTS (SELECT 1 FROM relay_charges back
                    WHERE back.requester_user_id = q.node_owner_user_id AND back.node_owner_user_id = q.requester_user_id
                      AND back.gross_musd > 0 AND NOT back.disputed)
    AND NOT EXISTS (SELECT 1 FROM nodes ow WHERE ow.owner_user_id = q.node_owner_user_id
                      AND ru.wallet_address IS NOT NULL AND lower(ow.owner_wallet) = lower(ru.wallet_address))
  GROUP BY q.node_owner_user_id, q.requester_user_id
  HAVING SUM(q.gross_musd) >= ${minSpendParam}::bigint`;

/** Owners with at least `payersParam` qualifying payers. */
export const QUALIFIED_OWNERS_SQL = (payersParam: string, minSpendParam: string): string => `
  SELECT p.owner FROM (${QUALIFYING_PAIRS_SQL(minSpendParam)}) p
  GROUP BY p.owner HAVING COUNT(*) >= ${payersParam}::int`;

/**
 * A row when owner $1 shares a beneficial owner with an existing genesis
 * member: a shared team, payout wallet address, node wallet, wallet identity,
 * or node egress prefix (/24 for IPv4, /48 for IPv6). One slot per beneficial owner.
 */
export const LINKED_TO_MEMBER_SQL = `
  SELECT 1 FROM genesis_members g WHERE g.owner_user_id <> $1 AND (
    EXISTS (SELECT 1 FROM team_members a JOIN team_members b ON b.team_id = a.team_id
            WHERE a.user_id = $1 AND b.user_id = g.owner_user_id)
    OR EXISTS (SELECT 1 FROM payout_wallets p1 JOIN payout_wallets p2 ON lower(p2.address) = lower(p1.address)
               WHERE p1.user_id = $1 AND p2.user_id = g.owner_user_id)
    OR EXISTS (SELECT 1 FROM nodes n1 JOIN nodes n2
                 ON lower(n2.owner_wallet) = lower(n1.owner_wallet)
                 OR (n1.ip_prefix24 IS NOT NULL AND n2.ip_prefix24 = n1.ip_prefix24)
               WHERE n1.owner_user_id = $1 AND n2.owner_user_id = g.owner_user_id)
  ) LIMIT 1`;

/**
 * Enrol up to the remaining cohort slots, in first-paid-charge order, one
 * beneficial owner per slot. Returns how many joined.
 */
export async function enrolTx(c: TxClient): Promise<number> {
  await c.query("SELECT pg_advisory_xact_lock($1)", [ENROL_LOCK]);
  const s = await getSettings(c);
  if (!s.enabled) return 0;
  const n = await c.query<{ n: string; max_seq: string | null }>(`SELECT COUNT(*)::text AS n, MAX(seq)::text AS max_seq FROM genesis_members`);
  let slots = s.maxOwners - Number(n.rows[0]?.n ?? 0);
  if (slots <= 0) return 0;
  let seq = Number(n.rows[0]?.max_seq ?? 0);
  const cand = await c.query<{ owner: string }>(
    `SELECT rc.node_owner_user_id AS owner
     FROM relay_charges rc
     JOIN users u ON u.id = rc.node_owner_user_id AND u.status = 'active' AND NOT u.is_admin
     WHERE rc.node_musd > 0 AND NOT rc.disputed
       AND rc.requester_user_id IS DISTINCT FROM rc.node_owner_user_id
       AND NOT EXISTS (SELECT 1 FROM genesis_members g WHERE g.owner_user_id = rc.node_owner_user_id)
       AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.owner_user_id = rc.node_owner_user_id AND n.operator_run)
       AND rc.node_owner_user_id IN (${QUALIFIED_OWNERS_SQL("$2", "$3")})
     GROUP BY rc.node_owner_user_id
     ORDER BY MIN(rc.created_at), rc.node_owner_user_id
     LIMIT $1`,
    [Math.min(1000, slots * 10), s.minDistinctPayers, s.minPayerSpendMusd.toString()],
  );
  let joined = 0;
  for (const { owner } of cand.rows) {
    if (slots <= 0) break;
    const linked = await c.query(LINKED_TO_MEMBER_SQL, [owner]);
    if (linked.rows.length > 0) continue;
    const r = await c.query(
      `INSERT INTO genesis_members (owner_user_id, seq, enrolled_at, boost_until)
       VALUES ($1, $2, now(), now() + make_interval(days => $3)) ON CONFLICT (owner_user_id) DO NOTHING RETURNING owner_user_id`,
      [owner, seq + 1, s.boostDays]);
    if (r.rows.length > 0) { seq++; slots--; joined++; }
  }
  return joined;
}

export async function enrol(): Promise<number> {
  return withTx((c) => enrolTx(c));
}

/**
 * Members whose qualifying traffic reached both thresholds and have no credit
 * yet: matured node earnings from qualifying payers (spend, not bytes, so cheap
 * masked/dc traffic cannot farm it) and the byte floor.
 */
export async function listCreditCandidates(limit = 1000): Promise<string[]> {
  const s = await getSettings();
  if (!s.enabled || s.creditMusd <= 0n) return [];
  const r = await query<{ owner_user_id: string }>(
    `SELECT m.owner_user_id FROM genesis_members m
     JOIN (SELECT p.owner, SUM(p.node_musd) AS node_musd, SUM(p.bytes) AS bytes
           FROM (${QUALIFYING_PAIRS_SQL("$4")}) p GROUP BY p.owner) t ON t.owner = m.owner_user_id
     WHERE m.credit_status = 'pending' AND t.bytes >= $1::bigint AND t.node_musd >= $2::bigint
     ORDER BY m.seq LIMIT $3`,
    [s.creditThresholdBytes.toString(), s.creditThresholdNodeMusd.toString(), limit, s.minPayerSpendMusd.toString()],
  );
  return r.rows.map((x) => x.owner_user_id);
}

/** Grant the one-time credit into pending (owner tier hold). Idempotent per member. */
export async function grantCredit(ownerUserId: string): Promise<boolean> {
  const tier = await getOwnerTier(ownerUserId);
  return withTx(async (c) => {
    const s = await getSettings(c);
    const m = await c.query<{ credit_status: string }>(
      `SELECT credit_status FROM genesis_members WHERE owner_user_id = $1 FOR UPDATE`, [ownerUserId]);
    if (m.rows[0]?.credit_status !== "pending" || !s.enabled || s.creditMusd <= 0n) return false;
    // Collusion precondition: no open or confirmed flag on the owner.
    const flagged = await c.query(
      `SELECT 1 FROM collusion_flags WHERE owner_user_id = $1 AND status IN ('open','confirmed') LIMIT 1`, [ownerUserId]);
    if (flagged.rows.length > 0) return false;
    await lockAccountTx(c, ownerUserId);
    await c.query(`UPDATE node_credit_accounts SET pending_musd = pending_musd + $2, updated_at = now() WHERE user_id = $1`,
      [ownerUserId, s.creditMusd.toString()]);
    await c.query(
      `INSERT INTO node_credit_transactions (user_id, type, amount_musd, external_ref) VALUES ($1, 'earn', $2, 'genesis:grant')`,
      [ownerUserId, s.creditMusd.toString()]);
    await c.query(
      `UPDATE genesis_members SET credit_status = 'held', credit_musd = $2, credit_granted_at = now(),
         credit_matures_at = now() + make_interval(days => $3) WHERE owner_user_id = $1`,
      [ownerUserId, s.creditMusd.toString(), tier.holdDays]);
    return true;
  });
}

/** Move held genesis credits whose hold ended from pending to available (skip frozen accounts). */
export async function matureCredits(limit = 1000): Promise<number> {
  const due = await query<{ owner_user_id: string }>(
    `SELECT owner_user_id FROM genesis_members WHERE credit_status = 'held' AND credit_matures_at <= now() ORDER BY credit_matures_at LIMIT $1`,
    [limit]);
  let n = 0;
  for (const d of due.rows) {
    const ok = await withTx(async (c) => {
      const m = await c.query<{ credit_musd: string }>(
        `SELECT credit_musd::text AS credit_musd FROM genesis_members WHERE owner_user_id = $1 AND credit_status = 'held' FOR UPDATE`, [d.owner_user_id]);
      if (!m.rows[0]) return false;
      const a = await lockAccountTx(c, d.owner_user_id);
      if (a.frozen) return false;
      const want = BigInt(m.rows[0].credit_musd);
      const move = want < a.pendingMusd ? want : a.pendingMusd;
      if (move > 0n) {
        await c.query(`UPDATE node_credit_accounts SET pending_musd = pending_musd - $2, available_musd = available_musd + $2, updated_at = now() WHERE user_id = $1`,
          [d.owner_user_id, move.toString()]);
        await c.query(`INSERT INTO node_credit_transactions (user_id, type, amount_musd, external_ref) VALUES ($1, 'mature', $2, 'genesis:grant')`,
          [d.owner_user_id, move.toString()]);
      }
      await c.query(`UPDATE genesis_members SET credit_status = 'matured' WHERE owner_user_id = $1`, [d.owner_user_id]);
      return true;
    });
    if (ok) n++;
  }
  return n;
}

/** Admin clawback of a still-held genesis credit (caller's admin transaction). */
export async function clawbackCreditTx(c: TxClient, ownerUserId: string, adminUserId: string): Promise<bigint | null> {
  const m = await c.query<{ credit_musd: string }>(
    `SELECT credit_musd::text AS credit_musd FROM genesis_members WHERE owner_user_id = $1 AND credit_status = 'held' FOR UPDATE`, [ownerUserId]);
  if (!m.rows[0]) return null;
  const a = await lockAccountTx(c, ownerUserId);
  const want = BigInt(m.rows[0].credit_musd);
  const take = want < a.pendingMusd ? want : a.pendingMusd;
  if (take > 0n) {
    await c.query(`UPDATE node_credit_accounts SET pending_musd = pending_musd - $2, updated_at = now() WHERE user_id = $1`, [ownerUserId, take.toString()]);
    await c.query(`INSERT INTO node_credit_transactions (user_id, type, amount_musd, external_ref, created_by) VALUES ($1, 'clawback', $2, 'genesis:grant', $3)`,
      [ownerUserId, take.toString(), adminUserId]);
  }
  await c.query(`UPDATE genesis_members SET credit_status = 'clawed_back' WHERE owner_user_id = $1`, [ownerUserId]);
  return take;
}
