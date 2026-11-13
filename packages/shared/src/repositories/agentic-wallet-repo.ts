import { query, getPool } from "../db.js";
import { lockedStarterCentsTx } from "./starter-credit-repo.js";

// ─── Types ───────────────────────────────────────────────────────────

export type AgenticWalletStatus = "active" | "frozen" | "deleted";
export type AgenticWalletTxType = "fund" | "spend" | "refund" | "withdraw";

export interface AgenticWallet {
  id: string;
  user_id: string;
  label: string;
  balance_cents: number;
  spending_limit_cents: number;
  daily_limit_cents: number | null;
  allowed_domains: string | null;
  status: AgenticWalletStatus;
  created_at: Date;
  /** Cents held by open relay sessions (selected only where needed). */
  reserved_cents?: number;
}

export interface AgenticWalletTransaction {
  id: string;
  wallet_id: string;
  type: AgenticWalletTxType;
  amount_cents: number;
  description: string;
  session_id: string | null;
  created_at: Date;
}

// ─── Constants ───────────────────────────────────────────────────────

const MAX_WALLETS_PER_USER = 10;
const MAX_INT = 2_147_483_647;
const MAX_BALANCE_CENTS = 1_000_000; // $10,000 — same cap as main wallet
const MAX_DESCRIPTION_LENGTH = 500;

// ─── Validation helper ──────────────────────────────────────────────

function validateAmountCents(amount: number, label: string): void {
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_INT) {
    throw new Error(`${label} must be a positive integer within valid range`);
  }
}

// ─── Create ─────────────────────────────────────────────────────────
// Atomic count check + insert in single transaction to prevent TOCTOU

export async function createWallet(
  userId: string,
  label: string,
  spendingLimitCents: number,
  dailyLimitCents?: number | null,
  allowedDomains?: string | null,
): Promise<AgenticWallet> {
  if (!Number.isInteger(spendingLimitCents) || spendingLimitCents < 0 || spendingLimitCents > MAX_INT) {
    throw new Error("Spending limit must be a non-negative integer within valid range");
  }

  if (dailyLimitCents !== undefined && dailyLimitCents !== null) {
    if (!Number.isInteger(dailyLimitCents) || dailyLimitCents <= 0 || dailyLimitCents > MAX_BALANCE_CENTS) {
      throw new Error("Daily limit must be a positive integer up to 1,000,000 cents");
    }
  }

  if (allowedDomains !== undefined && allowedDomains !== null) {
    if (typeof allowedDomains !== "string" || allowedDomains.length > 4096) {
      throw new Error("Allowed domains must be a JSON string up to 4096 characters");
    }
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Count check and INSERT on same client in same transaction
    // Lock the user's wallet rows first, then count them
    await client.query(
      `SELECT id FROM agentic_wallets WHERE user_id = $1 AND status != 'deleted' FOR UPDATE`,
      [userId],
    );
    const countResult = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM agentic_wallets WHERE user_id = $1 AND status != 'deleted'`,
      [userId],
    );
    if (parseInt(countResult.rows[0].count, 10) >= MAX_WALLETS_PER_USER) {
      throw new Error(`Maximum of ${MAX_WALLETS_PER_USER} agentic wallets per user`);
    }

    const result = await client.query<AgenticWallet>(
      `INSERT INTO agentic_wallets (user_id, label, spending_limit_cents, daily_limit_cents, allowed_domains)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, label, balance_cents, spending_limit_cents, daily_limit_cents, allowed_domains, status, created_at`,
      [userId, label, spendingLimitCents, dailyLimitCents ?? null, allowedDomains ?? null],
    );

    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Get ────────────────────────────────────────────────────────────

export async function getWallet(
  walletId: string,
  userId: string,
): Promise<AgenticWallet | null> {
  const result = await query<AgenticWallet>(
    `SELECT id, user_id, label, balance_cents, spending_limit_cents, daily_limit_cents, allowed_domains, status, created_at
     FROM agentic_wallets
     WHERE id = $1 AND user_id = $2 AND status != 'deleted'`,
    [walletId, userId],
  );
  return result.rows[0] ?? null;
}

// ─── List ───────────────────────────────────────────────────────────

export async function listWallets(userId: string): Promise<AgenticWallet[]> {
  const result = await query<AgenticWallet>(
    `SELECT id, user_id, label, balance_cents, spending_limit_cents, daily_limit_cents, allowed_domains, status, created_at
     FROM agentic_wallets
     WHERE user_id = $1 AND status != 'deleted'
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}

// ─── Fund ───────────────────────────────────────────────────────────
// Atomic: debit main wallet + credit agentic wallet in one transaction

export async function fundWallet(
  userId: string,
  walletId: string,
  amountCents: number,
): Promise<AgenticWalletTransaction> {
  validateAmountCents(amountCents, "Fund amount");

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Lock main wallet
    const mainWalletResult = await client.query<{ id: string; balance_cents: number }>(
      `SELECT id, balance_cents FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (mainWalletResult.rows.length === 0) {
      throw new Error("Main wallet not found");
    }
    const mainWallet = mainWalletResult.rows[0];
    if (mainWallet.balance_cents < amountCents) {
      throw new Error("Insufficient balance in main wallet");
    }
    // Unspent starter credit is non-transferable: it must stay on the personal
    // rail where spend is attributed to the grant and expiry can claw it back.
    const starterLocked = await lockedStarterCentsTx(client, userId);
    if (mainWallet.balance_cents - amountCents < starterLocked) {
      throw new Error("Insufficient balance: starter credit cannot be moved out of the personal wallet");
    }

    // Lock agentic wallet
    const agenticResult = await client.query<AgenticWallet>(
      `SELECT id, user_id, label, balance_cents, spending_limit_cents, daily_limit_cents, allowed_domains, status, created_at, reserved_cents
       FROM agentic_wallets
       WHERE id = $1 AND user_id = $2 AND status = 'active'
       FOR UPDATE`,
      [walletId, userId],
    );
    if (agenticResult.rows.length === 0) {
      throw new Error("Agentic wallet not found or not active");
    }

    // Cap agentic wallet balance at MAX_BALANCE_CENTS to prevent overflow
    const agenticWallet = agenticResult.rows[0];
    if (agenticWallet.balance_cents + (agenticWallet.reserved_cents ?? 0) + amountCents > MAX_BALANCE_CENTS) {
      throw new Error(`Fund would exceed agentic wallet balance cap of $${(MAX_BALANCE_CENTS / 100).toFixed(2)}`);
    }

    // Debit main wallet
    await client.query(
      `UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id = $2`,
      [amountCents, mainWallet.id],
    );

    // Record main wallet debit
    await client.query(
      `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
       VALUES ($1, 'debit', $2, $3)`,
      [mainWallet.id, amountCents, `Fund agentic wallet ${walletId.slice(0, 8)}`],
    );

    // Credit agentic wallet
    await client.query(
      `UPDATE agentic_wallets SET balance_cents = balance_cents + $1 WHERE id = $2`,
      [amountCents, walletId],
    );

    // Record agentic wallet transaction
    const txResult = await client.query<AgenticWalletTransaction>(
      `INSERT INTO agentic_wallet_transactions (wallet_id, type, amount_cents, description)
       VALUES ($1, 'fund', $2, 'Funded from main wallet')
       RETURNING id, wallet_id, type, amount_cents, description, session_id, created_at`,
      [walletId, amountCents],
    );

    await client.query("COMMIT");
    return txResult.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Spend ──────────────────────────────────────────────────────────

export async function spendFromWallet(
  walletId: string,
  userId: string,
  amountCents: number,
  description: string,
  sessionId?: string,
): Promise<AgenticWalletTransaction> {
  validateAmountCents(amountCents, "Spend amount");

  // Cap description length to prevent DB bloat
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    description = description.slice(0, MAX_DESCRIPTION_LENGTH);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    const walletResult = await client.query<AgenticWallet>(
      `SELECT id, user_id, label, balance_cents, spending_limit_cents, daily_limit_cents, allowed_domains, status, created_at
       FROM agentic_wallets
       WHERE id = $1 AND user_id = $2 AND status = 'active'
       FOR UPDATE`,
      [walletId, userId],
    );
    if (walletResult.rows.length === 0) {
      throw new Error("Agentic wallet not found or not active");
    }

    const wallet = walletResult.rows[0];

    // Do not leak spending limit value in error message
    if (wallet.spending_limit_cents > 0 && amountCents > wallet.spending_limit_cents) {
      throw new Error("Amount exceeds spending limit");
    }

    // Daily limit enforcement: check today's spend total (UTC)
    if (wallet.daily_limit_cents !== null && wallet.daily_limit_cents > 0) {
      const dailySpendResult = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_cents), 0) as total
         FROM agentic_wallet_transactions
         WHERE wallet_id = $1 AND type = 'spend'
           AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
        [walletId],
      );
      const dailySpent = parseInt(dailySpendResult.rows[0].total, 10);
      if (dailySpent + amountCents > wallet.daily_limit_cents) {
        throw new Error("Daily budget limit exceeded");
      }
    }

    if (wallet.balance_cents < amountCents) {
      throw new Error("Insufficient balance in agentic wallet");
    }

    await client.query(
      `UPDATE agentic_wallets SET balance_cents = balance_cents - $1 WHERE id = $2`,
      [amountCents, walletId],
    );

    const txResult = await client.query<AgenticWalletTransaction>(
      `INSERT INTO agentic_wallet_transactions (wallet_id, type, amount_cents, description, session_id)
       VALUES ($1, 'spend', $2, $3, $4)
       RETURNING id, wallet_id, type, amount_cents, description, session_id, created_at`,
      [walletId, amountCents, description, sessionId ?? null],
    );

    await client.query("COMMIT");
    return txResult.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Get Balance ────────────────────────────────────────────────────

export async function getBalance(
  walletId: string,
  userId: string,
): Promise<number> {
  const result = await query<{ balance_cents: number }>(
    `SELECT balance_cents FROM agentic_wallets WHERE id = $1 AND user_id = $2 AND status != 'deleted'`,
    [walletId, userId],
  );
  if (result.rows.length === 0) {
    throw new Error("Agentic wallet not found");
  }
  return result.rows[0].balance_cents;
}

// ─── Get Transactions ───────────────────────────────────────────────

export async function getTransactions(
  walletId: string,
  userId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<AgenticWalletTransaction[]> {
  limit = Math.max(1, Math.min(100, limit));
  offset = Math.max(0, offset);

  // H-2: Atomic ownership check + data fetch via JOIN (prevents TOCTOU with GDPR deletion)
  const result = await query<AgenticWalletTransaction>(
    `SELECT t.id, t.wallet_id, t.type, t.amount_cents, t.description, t.session_id, t.created_at
     FROM agentic_wallet_transactions t
     JOIN agentic_wallets w ON w.id = t.wallet_id
     WHERE t.wallet_id = $1 AND w.user_id = $2 AND w.status != 'deleted'
     ORDER BY t.created_at DESC
     LIMIT $3 OFFSET $4`,
    [walletId, userId, limit, offset],
  );
  // If no transactions returned, verify the wallet exists (could be zero transactions vs not found)
  if (result.rows.length === 0) {
    const check = await query<{ id: string }>(
      `SELECT id FROM agentic_wallets WHERE id = $1 AND user_id = $2 AND status != 'deleted'`,
      [walletId, userId],
    );
    if (check.rows.length === 0) {
      throw new Error("Agentic wallet not found");
    }
  }
  return result.rows;
}

// ─── Freeze ─────────────────────────────────────────────────────────

export async function freezeWallet(
  walletId: string,
  userId: string,
): Promise<AgenticWallet> {
  const result = await query<AgenticWallet>(
    `UPDATE agentic_wallets
     SET status = 'frozen'
     WHERE id = $1 AND user_id = $2 AND status = 'active'
     RETURNING id, user_id, label, balance_cents, spending_limit_cents, daily_limit_cents, allowed_domains, status, created_at`,
    [walletId, userId],
  );
  if (result.rows.length === 0) {
    throw new Error("Agentic wallet not found or not active");
  }
  return result.rows[0];
}

// ─── Unfreeze ───────────────────────────────────────────────────────
// Allow unfreezing a frozen wallet to resume normal operation

export async function unfreezeWallet(
  walletId: string,
  userId: string,
): Promise<AgenticWallet> {
  const result = await query<AgenticWallet>(
    `UPDATE agentic_wallets
     SET status = 'active'
     WHERE id = $1 AND user_id = $2 AND status = 'frozen'
     RETURNING id, user_id, label, balance_cents, spending_limit_cents, daily_limit_cents, allowed_domains, status, created_at`,
    [walletId, userId],
  );
  if (result.rows.length === 0) {
    throw new Error("Agentic wallet not found or not frozen");
  }
  return result.rows[0];
}

// ─── Delete (refund remaining balance to main wallet) ───────────────
// Block deletion if refund would be partial; return actual refund amount

export async function deleteWallet(
  walletId: string,
  userId: string,
): Promise<{ refundedCents: number }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Lock agentic wallet
    const walletResult = await client.query<AgenticWallet>(
      `SELECT id, user_id, label, balance_cents, spending_limit_cents, daily_limit_cents, allowed_domains, status, created_at, reserved_cents
       FROM agentic_wallets
       WHERE id = $1 AND user_id = $2 AND status = 'active'
       FOR UPDATE`,
      [walletId, userId],
    );
    if (walletResult.rows.length === 0) {
      throw new Error("Agentic wallet not found or not active (frozen wallets must be unfrozen before deletion)");
    }

    const agenticWallet = walletResult.rows[0];
    let reserved = agenticWallet.reserved_cents ?? 0;
    if (reserved > 0) {
      // Block only on reservations a live session can still settle: an active
      // session, a pending settle retry, or a reservation taken in the last
      // 10 minutes whose session row is not recorded yet. Anything else is a
      // leftover of a session that ended without settling: return it.
      const live = await client.query<{ held: string; recent: boolean }>(
        `SELECT COALESCE((SELECT SUM(r.cents) FROM agentic_session_reservations r
                           WHERE r.wallet_id = $1 AND NOT (${ORPHANED_RESERVATION_SQL})), 0)::text AS held,
                COALESCE((SELECT last_reserved_at > now() - interval '10 minutes' FROM agentic_wallets WHERE id = $1), false) AS recent`,
        [walletId],
      );
      const held = Number(live.rows[0]?.held ?? 0);
      const unrecorded = reserved - Number((await client.query<{ s: string }>(
        `SELECT COALESCE(SUM(cents), 0)::text AS s FROM agentic_session_reservations WHERE wallet_id = $1`, [walletId])).rows[0]?.s ?? 0);
      if (held > 0 || (unrecorded > 0 && live.rows[0]?.recent)) {
        throw new Error("Cannot delete: the wallet has relay sessions in progress. Try again when they end.");
      }
      await client.query(`DELETE FROM agentic_session_reservations WHERE wallet_id = $1`, [walletId]);
      await client.query(
        `UPDATE agentic_wallets SET balance_cents = balance_cents + reserved_cents, reserved_cents = 0 WHERE id = $1`, [walletId]);
      agenticWallet.balance_cents += reserved;
      reserved = 0;
    }
    const refundCents = agenticWallet.balance_cents;

    if (refundCents > 0) {
      // Lock main wallet
      const mainResult = await client.query<{ id: string; balance_cents: number }>(
        `SELECT id, balance_cents FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      if (mainResult.rows.length === 0) {
        throw new Error("Main wallet not found");
      }
      const mainWallet = mainResult.rows[0];

      // Block deletion if refund would exceed main wallet cap (prevents silent fund loss)
      if (mainWallet.balance_cents + refundCents > MAX_BALANCE_CENTS) {
        throw new Error("Cannot delete: refund would exceed main wallet balance cap. Withdraw main wallet funds first.");
      }

      // Credit main wallet (full refund — cap check above guarantees safety)
      await client.query(
        `UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id = $2`,
        [refundCents, mainWallet.id],
      );

      // Record main wallet refund
      await client.query(
        `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
         VALUES ($1, 'refund', $2, $3)`,
        [mainWallet.id, refundCents, `Refund from deleted agentic wallet ${walletId.slice(0, 8)}`],
      );

      // Record agentic wallet withdrawal
      await client.query(
        `INSERT INTO agentic_wallet_transactions (wallet_id, type, amount_cents, description)
         VALUES ($1, 'withdraw', $2, 'Balance returned on wallet deletion')`,
        [walletId, refundCents],
      );
    }

    // Mark as deleted with zero balance
    await client.query(
      `UPDATE agentic_wallets SET status = 'deleted', balance_cents = 0 WHERE id = $1`,
      [walletId],
    );

    await client.query("COMMIT");
    return { refundedCents: refundCents };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Relay session budget (rail 'agentic_wallet') ───────────────────

type TxClient = Pick<import("pg").PoolClient, "query">;

/** UTC-day spend already settled for a wallet (caller's transaction). */
async function dailySpentTx(c: TxClient, walletId: string): Promise<number> {
  const r = await c.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_cents), 0)::text AS total FROM agentic_wallet_transactions
     WHERE wallet_id = $1 AND type = 'spend' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [walletId],
  );
  return parseInt(r.rows[0]?.total ?? "0", 10);
}

/**
 * Reserve up to wantCents for a relay session from an agentic wallet, under the
 * wallet row lock. The reservation is capped by the balance, by the per-session
 * spending limit (spending_limit_cents, 0 = none) and by what is left of the
 * daily budget after settled spend AND in-flight reservations, so parallel
 * sessions cannot overshoot it. Returns the reserved cents (0 = refused).
 */
export async function reserveSessionBudget(walletId: string, userId: string, wantCents: number): Promise<number> {
  if (!Number.isInteger(wantCents) || wantCents <= 0) return 0;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const w = await client.query<{ balance_cents: number; spending_limit_cents: number; daily_limit_cents: number | null; reserved_cents: number }>(
      `SELECT balance_cents, spending_limit_cents, daily_limit_cents, reserved_cents FROM agentic_wallets
       WHERE id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
      [walletId, userId],
    );
    const row = w.rows[0];
    if (!row) { await client.query("ROLLBACK"); return 0; }
    let take = Math.min(wantCents, row.balance_cents);
    if (row.spending_limit_cents > 0) take = Math.min(take, row.spending_limit_cents);
    if (row.daily_limit_cents !== null && row.daily_limit_cents > 0) {
      const room = row.daily_limit_cents - (await dailySpentTx(client, walletId)) - row.reserved_cents;
      take = Math.min(take, room);
    }
    if (take <= 0) { await client.query("ROLLBACK"); return 0; }
    await client.query(
      `UPDATE agentic_wallets SET balance_cents = balance_cents - $2, reserved_cents = reserved_cents + $2, last_reserved_at = now() WHERE id = $1`,
      [walletId, take],
    );
    await client.query("COMMIT");
    return take;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Undo a reservation for a session that never started. */
export async function releaseSessionBudget(walletId: string, cents: number): Promise<void> {
  if (!Number.isInteger(cents) || cents <= 0) return;
  await query(
    `UPDATE agentic_wallets SET balance_cents = balance_cents + $2, reserved_cents = GREATEST(reserved_cents - $2, 0) WHERE id = $1`,
    [walletId, cents],
  );
}

/**
 * Record which session holds a reservation, so a session that ends without
 * settling (gateway crash, dead settle retry) can have it returned.
 */
export async function recordSessionReservation(walletId: string, sessionId: string, cents: number): Promise<void> {
  if (!Number.isInteger(cents) || cents <= 0) return;
  await query(
    `INSERT INTO agentic_session_reservations (session_id, wallet_id, cents) VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, walletId, cents],
  );
}

/** Reservation rows whose session is no longer active and has no pending settle retry. */
const ORPHANED_RESERVATION_SQL = `
  NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = r.session_id AND s.status = 'active')
  AND NOT EXISTS (SELECT 1 FROM relay_settle_retries q WHERE q.session_id = r.session_id AND q.status = 'pending')`;

/**
 * Return the reservations of sessions that ended without settling (status
 * 'error' after a crash or a dead settle retry). Settlement deletes the row in
 * the same transaction that ends the session, so a row left behind on a
 * non-active session with no pending retry will never be settled.
 * walletId limits the sweep to one wallet. Returns the cents released.
 */
export async function releaseOrphanedSessionReservations(walletId?: string): Promise<number> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query<{ session_id: string; wallet_id: string; cents: number }>(
      `DELETE FROM agentic_session_reservations r
       WHERE r.session_id IN (
         SELECT r.session_id FROM agentic_session_reservations r
         WHERE ${ORPHANED_RESERVATION_SQL} ${walletId ? "AND r.wallet_id = $1" : ""}
         ORDER BY r.created_at LIMIT 1000 FOR UPDATE SKIP LOCKED)
       RETURNING r.session_id, r.wallet_id, r.cents`,
      walletId ? [walletId] : [],
    );
    let total = 0;
    for (const row of rows.rows) {
      await client.query(
        `UPDATE agentic_wallets SET balance_cents = balance_cents + LEAST($2::int, reserved_cents),
           reserved_cents = GREATEST(reserved_cents - $2::int, 0) WHERE id = $1`,
        [row.wallet_id, row.cents],
      );
      total += row.cents;
    }
    await client.query("COMMIT");
    return total;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Settle a relay session against its agentic-wallet reservation (caller's
 * transaction). Gross accrues into the wallet's sub-cent carry; whole cents are
 * debited from the reservation (a 'spend' row with the session id), and the
 * unused reservation goes back to the wallet balance.
 */
export async function settleSessionTx(
  c: TxClient, walletId: string, reservedCents: number, grossMusd: bigint, sessionId: string,
): Promise<{ debitCents: number; paidInFull: boolean } | null> {
  const w = await c.query<{ carry_musd: string }>(
    `SELECT carry_musd::text AS carry_musd FROM agentic_wallets WHERE id = $1 FOR UPDATE`, [walletId]);
  if (!w.rows[0]) return null;
  await c.query(`DELETE FROM agentic_session_reservations WHERE session_id = $1`, [sessionId]);
  const total = BigInt(w.rows[0].carry_musd) + grossMusd;
  const dueCents = total / 10_000n;
  const debit = dueCents > BigInt(reservedCents) ? reservedCents : Number(dueCents);
  const carry = dueCents > BigInt(reservedCents) ? 0n : total - dueCents * 10_000n;
  await c.query(
    `UPDATE agentic_wallets SET balance_cents = balance_cents + $2, reserved_cents = GREATEST(reserved_cents - $3, 0), carry_musd = $4
     WHERE id = $1`,
    [walletId, reservedCents - debit, reservedCents, carry.toString()],
  );
  if (debit > 0) {
    await c.query(
      `INSERT INTO agentic_wallet_transactions (wallet_id, type, amount_cents, description, session_id)
       VALUES ($1, 'spend', $2, 'Relay session', $3)`,
      [walletId, debit, sessionId],
    );
  }
  return { debitCents: debit, paidInFull: dueCents <= BigInt(reservedCents) };
}

// ─── Get Daily Spend ───────────────────────────────────────────────

export async function getDailySpend(walletId: string): Promise<number> {
  const result = await query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_cents), 0) as total
     FROM agentic_wallet_transactions
     WHERE wallet_id = $1 AND type = 'spend'
       AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
    [walletId],
  );
  return parseInt(result.rows[0].total, 10);
}

// ─── Update Wallet Policy ──────────────────────────────────────────

export async function updateWalletPolicy(
  walletId: string,
  userId: string,
  policy: { dailyLimitCents?: number | null; allowedDomains?: string | null },
): Promise<AgenticWallet> {
  if (policy.dailyLimitCents !== undefined && policy.dailyLimitCents !== null) {
    if (!Number.isInteger(policy.dailyLimitCents) || policy.dailyLimitCents <= 0 || policy.dailyLimitCents > MAX_BALANCE_CENTS) {
      throw new Error("Daily limit must be a positive integer up to 1,000,000 cents");
    }
  }

  if (policy.allowedDomains !== undefined && policy.allowedDomains !== null) {
    if (typeof policy.allowedDomains !== "string" || policy.allowedDomains.length > 4096) {
      throw new Error("Allowed domains must be a JSON string up to 4096 characters");
    }
  }

  const setClauses: string[] = [];
  const params: (string | number | null)[] = [];
  let paramIdx = 1;

  if (policy.dailyLimitCents !== undefined) {
    setClauses.push(`daily_limit_cents = $${paramIdx++}`);
    params.push(policy.dailyLimitCents);
  }

  if (policy.allowedDomains !== undefined) {
    setClauses.push(`allowed_domains = $${paramIdx++}`);
    params.push(policy.allowedDomains);
  }

  if (setClauses.length === 0) {
    throw new Error("No policy fields to update");
  }

  params.push(walletId, userId);
  const walletIdIdx = paramIdx++;
  const userIdIdx = paramIdx++;

  const result = await query<AgenticWallet>(
    `UPDATE agentic_wallets
     SET ${setClauses.join(", ")}
     WHERE id = $${walletIdIdx} AND user_id = $${userIdIdx} AND status = 'active'
     RETURNING id, user_id, label, balance_cents, spending_limit_cents, daily_limit_cents, allowed_domains, status, created_at`,
    params,
  );

  if (result.rows.length === 0) {
    throw new Error("Agentic wallet not found");
  }

  return result.rows[0];
}
