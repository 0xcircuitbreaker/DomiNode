import type pg from "pg";
import { query } from "../db.js";
import { withTx, lockAccountTx } from "./node-credit-repo.js";
import { getOwnerTier } from "./tier-repo.js";

/**
 * Genesis cohort (LAUNCH_PLAN §4.2, ECONOMICS.md "Genesis boost").
 *
 * Enrolment (daily job): the first max_owners node owners by their first paid,
 * non-self-dealing relay charge (node_musd > 0, which already excludes
 * self-dealing and quarantined traffic). Owners of operator-run seed nodes and
 * admin principals never take a slot.
 *
 * Benefit A: +bonus_bps share until boost_until (tier-repo getChargeSnapshot,
 * capped at 5000, snapshotted in relay_charges.genesis_bonus_bps).
 * Benefit B: a one-time credit once the owner's matured, undisputed,
 * other-principal paid traffic reaches credit_threshold_bytes. It is credited
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
  updatedBy: string | null;
  updatedAt: Date | null;
}

interface Row {
  enabled: boolean; max_owners: number; bonus_bps: number; boost_days: number; credit_musd: string;
  credit_threshold_bytes: string; updated_by: string | null; updated_at: Date | null;
}

export const DEFAULT_GENESIS_SETTINGS: GenesisSettings = {
  enabled: true, maxOwners: 200, bonusBps: 500, boostDays: 90, creditMusd: 5_000_000n,
  creditThresholdBytes: 5_000_000_000n, updatedBy: null, updatedAt: null,
};

export async function getSettings(client?: TxClient): Promise<GenesisSettings> {
  const sql = `SELECT enabled, max_owners, bonus_bps, boost_days, credit_musd::text AS credit_musd,
    credit_threshold_bytes::text AS credit_threshold_bytes, updated_by, updated_at FROM genesis_settings WHERE id = 1`;
  const r = client ? await client.query<Row>(sql) : await query<Row>(sql);
  const x = r.rows[0];
  if (!x) return { ...DEFAULT_GENESIS_SETTINGS };
  return {
    enabled: x.enabled, maxOwners: x.max_owners, bonusBps: x.bonus_bps, boostDays: x.boost_days,
    creditMusd: BigInt(x.credit_musd), creditThresholdBytes: BigInt(x.credit_threshold_bytes),
    updatedBy: x.updated_by, updatedAt: x.updated_at,
  };
}

/** Enrol up to the remaining cohort slots, in first-paid-charge order. Returns how many joined. */
export async function enrolTx(c: TxClient): Promise<number> {
  await c.query("SELECT pg_advisory_xact_lock($1)", [ENROL_LOCK]);
  const s = await getSettings(c);
  if (!s.enabled) return 0;
  const n = await c.query<{ n: string; max_seq: string | null }>(`SELECT COUNT(*)::text AS n, MAX(seq)::text AS max_seq FROM genesis_members`);
  const slots = s.maxOwners - Number(n.rows[0]?.n ?? 0);
  if (slots <= 0) return 0;
  const r = await c.query<{ owner_user_id: string }>(
    `INSERT INTO genesis_members (owner_user_id, seq, enrolled_at, boost_until)
     SELECT x.owner, $3::int + ROW_NUMBER() OVER (ORDER BY x.first_at, x.owner), now(), now() + make_interval(days => $2)
     FROM (
       SELECT rc.node_owner_user_id AS owner, MIN(rc.created_at) AS first_at
       FROM relay_charges rc
       JOIN users u ON u.id = rc.node_owner_user_id AND u.status = 'active' AND NOT u.is_admin
       WHERE rc.node_musd > 0 AND NOT rc.disputed
         AND rc.requester_user_id IS DISTINCT FROM rc.node_owner_user_id
         AND NOT EXISTS (SELECT 1 FROM genesis_members g WHERE g.owner_user_id = rc.node_owner_user_id)
         AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.owner_user_id = rc.node_owner_user_id AND n.operator_run)
       GROUP BY rc.node_owner_user_id
       ORDER BY MIN(rc.created_at), rc.node_owner_user_id
       LIMIT $1
     ) x
     ON CONFLICT (owner_user_id) DO NOTHING
     RETURNING owner_user_id`,
    [slots, s.boostDays, Number(n.rows[0]?.max_seq ?? 0)],
  );
  return r.rows.length;
}

export async function enrol(): Promise<number> {
  return withTx((c) => enrolTx(c));
}

/** Members whose qualifying traffic reached the threshold and have no credit yet. */
export async function listCreditCandidates(limit = 1000): Promise<string[]> {
  const s = await getSettings();
  if (!s.enabled || s.creditMusd <= 0n) return [];
  const r = await query<{ owner_user_id: string }>(
    `SELECT m.owner_user_id FROM genesis_members m
     WHERE m.credit_status = 'pending'
       AND (SELECT COALESCE(SUM(rc.bytes_gateway), 0) FROM relay_charges rc
            WHERE rc.node_owner_user_id = m.owner_user_id AND rc.matured AND NOT rc.disputed
              AND rc.node_musd > 0 AND rc.starter_musd = 0
              AND rc.requester_user_id IS DISTINCT FROM m.owner_user_id) >= $1::bigint
     ORDER BY m.seq LIMIT $2`,
    [s.creditThresholdBytes.toString(), limit],
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
