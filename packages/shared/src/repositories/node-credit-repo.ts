import type pg from "pg";
import { getPool } from "../db.js";

/** Node earnings ledger (µUSD, bigint). DESIGN.md §5, §6.4, §15. */

export type TxClient = Pick<pg.PoolClient, "query">;

export const MUSD_PER_CENT = 10_000n;
const MAX_ACCOUNT_MUSD = 1_000_000_000_000_000n;
const MAX_WALLET_BALANCE_CENTS = 1_000_000;
export const MATURE_BATCH_LIMIT = 1000;

export interface NodeCreditAccount {
  userId: string;
  pendingMusd: bigint;
  availableMusd: bigint;
  autoConvertPct: number;
  frozen: boolean;
}

function assertPositiveMusd(v: bigint, label: string): void {
  if (typeof v !== "bigint" || v <= 0n || v > MAX_ACCOUNT_MUSD) {
    throw new Error(`${label} must be a positive bigint within valid range`);
  }
}

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

interface AccountRow {
  user_id: string;
  pending_musd: string;
  available_musd: string;
  auto_convert_pct: number;
  frozen: boolean;
}

function mapAccount(r: AccountRow): NodeCreditAccount {
  return {
    userId: r.user_id,
    pendingMusd: BigInt(r.pending_musd),
    availableMusd: BigInt(r.available_musd),
    autoConvertPct: r.auto_convert_pct,
    frozen: r.frozen,
  };
}

const ACCOUNT_COLS = "user_id, pending_musd, available_musd, auto_convert_pct, frozen";

export async function getAccount(userId: string): Promise<NodeCreditAccount | null> {
  const client = await getPool().connect();
  try {
    const r = await client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLS} FROM node_credit_accounts WHERE user_id = $1`,
      [userId],
    );
    return r.rows[0] ? mapAccount(r.rows[0]) : null;
  } finally {
    client.release();
  }
}

/** Lock (creating if absent) the caller's credit account row. */
export async function lockAccountTx(client: TxClient, userId: string): Promise<NodeCreditAccount> {
  await client.query(
    `INSERT INTO node_credit_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const r = await client.query<AccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM node_credit_accounts WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  if (!r.rows[0]) throw new Error("Node credit account not found");
  return mapAccount(r.rows[0]);
}

/** Credit pending earnings (caller-owned transaction). */
export async function earnTx(
  client: TxClient,
  userId: string,
  amountMusd: bigint,
  relayChargeId: string,
): Promise<void> {
  assertPositiveMusd(amountMusd, "earn amount");
  await client.query(
    `INSERT INTO node_credit_accounts (user_id, pending_musd) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET pending_musd = node_credit_accounts.pending_musd + EXCLUDED.pending_musd,
           updated_at = now()`,
    [userId, amountMusd.toString()],
  );
  await client.query(
    `INSERT INTO node_credit_transactions (user_id, type, amount_musd, relay_charge_id)
     VALUES ($1, 'earn', $2, $3)`,
    [userId, amountMusd.toString(), relayChargeId],
  );
}

export interface MatureResult {
  scanned: number;
  matured: number;
  skippedFrozen: number;
  movedMusd: bigint;
}

/**
 * Maturity job body: move due pending earnings to available.
 * Rows are claimed with FOR UPDATE SKIP LOCKED LIMIT 1000; frozen accounts
 * are skipped (rows stay unmatured and are retried next run).
 */
export async function matureDue(limit = MATURE_BATCH_LIMIT): Promise<MatureResult> {
  const lim = Number.isInteger(limit) && limit > 0 && limit <= MATURE_BATCH_LIMIT ? limit : MATURE_BATCH_LIMIT;
  return withTx(async (client) => {
    const due = await client.query<{ id: string; node_owner_user_id: string | null; node_musd: string }>(
      `SELECT id, node_owner_user_id, node_musd FROM relay_charges
       WHERE NOT matured AND NOT disputed AND matures_at <= now()
       ORDER BY matures_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [lim],
    );
    const res: MatureResult = { scanned: due.rows.length, matured: 0, skippedFrozen: 0, movedMusd: 0n };
    // Lock every affected account up front in sorted user_id order. Concurrent
    // withdraw/convert/clawback each lock a single account, so a global order
    // here prevents lock-order deadlocks across interleaved owners.
    const owners = [...new Set(
      due.rows.filter((r) => r.node_owner_user_id && BigInt(r.node_musd) > 0n).map((r) => r.node_owner_user_id as string),
    )].sort();
    const accts = new Map<string, { frozen: boolean; pendingMusd: bigint }>();
    for (const owner of owners) {
      const a = await lockAccountTx(client, owner);
      accts.set(owner, { frozen: a.frozen, pendingMusd: a.pendingMusd });
    }
    for (const row of due.rows) {
      const amount = BigInt(row.node_musd);
      if (row.node_owner_user_id && amount > 0n) {
        const acct = accts.get(row.node_owner_user_id)!;
        if (acct.frozen) {
          res.skippedFrozen++;
          continue;
        }
        // Clawbacks may already have drained pending; never move more than exists.
        const move = amount < acct.pendingMusd ? amount : acct.pendingMusd;
        if (move > 0n) {
          await client.query(
            `UPDATE node_credit_accounts
             SET pending_musd = pending_musd - $2, available_musd = available_musd + $2, updated_at = now()
             WHERE user_id = $1`,
            [row.node_owner_user_id, move.toString()],
          );
          await client.query(
            `INSERT INTO node_credit_transactions (user_id, type, amount_musd, relay_charge_id)
             VALUES ($1, 'mature', $2, $3)`,
            [row.node_owner_user_id, move.toString(), row.id],
          );
          acct.pendingMusd -= move;
          res.movedMusd += move;
        }
      }
      await client.query(`UPDATE relay_charges SET matured = true WHERE id = $1`, [row.id]);
      res.matured++;
    }
    return res;
  });
}

export interface ClawbackResult {
  fromPendingMusd: bigint;
  fromAvailableMusd: bigint;
}

/** Admin clawback: debit pending first, then available, flooring at 0. */
export async function clawback(
  userId: string,
  amountMusd: bigint,
  adminUserId: string,
  opts: { relayChargeId?: string | null; externalRef?: string | null } = {},
): Promise<ClawbackResult> {
  assertPositiveMusd(amountMusd, "clawback amount");
  if (opts.externalRef != null && opts.externalRef.length > 128) {
    throw new Error("externalRef too long");
  }
  return withTx(async (client) => {
    const acct = await lockAccountTx(client, userId);
    const fromPending = amountMusd < acct.pendingMusd ? amountMusd : acct.pendingMusd;
    const rest = amountMusd - fromPending;
    const fromAvailable = rest < acct.availableMusd ? rest : acct.availableMusd;
    const taken = fromPending + fromAvailable;
    if (taken > 0n) {
      await client.query(
        `UPDATE node_credit_accounts
         SET pending_musd = pending_musd - $2, available_musd = available_musd - $3, updated_at = now()
         WHERE user_id = $1`,
        [userId, fromPending.toString(), fromAvailable.toString()],
      );
      await client.query(
        `INSERT INTO node_credit_transactions (user_id, type, amount_musd, relay_charge_id, external_ref, created_by)
         VALUES ($1, 'clawback', $2, $3, $4, $5)`,
        [userId, taken.toString(), opts.relayChargeId ?? null, opts.externalRef ?? null, adminUserId],
      );
    }
    if (opts.relayChargeId) {
      await client.query(`UPDATE relay_charges SET disputed = true WHERE id = $1`, [opts.relayChargeId]);
    }
    return { fromPendingMusd: fromPending, fromAvailableMusd: fromAvailable };
  });
}

/**
 * Convert available credits into the user's own requester wallet in whole
 * cents. The sub-cent remainder stays in credits. Credits are never
 * transferable to another user.
 */
export async function convertToWallet(
  userId: string,
  amountMusd?: bigint,
): Promise<{ convertedCents: number; convertedMusd: bigint }> {
  if (amountMusd !== undefined) assertPositiveMusd(amountMusd, "convert amount");
  return withTx(async (client) => {
    const acct = await lockAccountTx(client, userId);
    if (acct.frozen) throw new Error("Node credit account is frozen");
    const want = amountMusd ?? acct.availableMusd;
    if (want > acct.availableMusd) throw new Error("Insufficient available credit");
    const cents = want / MUSD_PER_CENT;
    if (cents <= 0n) throw new Error("Amount below one cent");
    const centsNum = Number(cents);
    const musd = cents * MUSD_PER_CENT;

    const w = await client.query<{ id: string; balance_cents: number }>(
      `SELECT id, balance_cents FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const wallet = w.rows[0];
    if (!wallet) throw new Error("Wallet not found");
    if (wallet.balance_cents + centsNum > MAX_WALLET_BALANCE_CENTS) {
      throw new Error("Conversion would exceed wallet balance cap");
    }
    await client.query(
      `UPDATE node_credit_accounts SET available_musd = available_musd - $2, updated_at = now() WHERE user_id = $1`,
      [userId, musd.toString()],
    );
    await client.query(
      `INSERT INTO node_credit_transactions (user_id, type, amount_musd) VALUES ($1, 'convert_to_wallet', $2)`,
      [userId, musd.toString()],
    );
    await client.query(`UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id = $2`, [centsNum, wallet.id]);
    await client.query(
      `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description, payment_provider)
       VALUES ($1, 'topup', $2, $3, 'node_credits')`,
      [wallet.id, centsNum, "Node earnings conversion"],
    );
    return { convertedCents: centsNum, convertedMusd: musd };
  });
}
