import { query, getPool } from "../db.js";
import type { Wallet, WalletTransaction } from "../types.js";

export async function createWallet(userId: string): Promise<Wallet> {
  const result = await query<Wallet>(
    `INSERT INTO wallets (user_id)
     VALUES ($1)
     RETURNING id, user_id, balance_cents, currency, last_topped_up`,
    [userId],
  );
  return result.rows[0];
}

export async function getWallet(userId: string): Promise<Wallet | null> {
  const result = await query<Wallet>(
    `SELECT id, user_id, balance_cents, currency, last_topped_up FROM wallets WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function getBalance(userId: string): Promise<number> {
  const result = await query<{ balance_cents: number }>(
    `SELECT balance_cents FROM wallets WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0]?.balance_cents ?? 0;
}

// Maximum wallet balance: $10,000 (prevents abuse and accounting overflow)
const MAX_BALANCE_CENTS = 1_000_000;

export async function creditWallet(
  userId: string,
  amountCents: number,
  provider: string,
  paymentId: string,
  description: string,
): Promise<WalletTransaction> {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 2_147_483_647) {
    throw new Error("Credit amount must be a positive integer within valid range");
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Check current balance before crediting to enforce max cap
    const balanceCheck = await client.query<Wallet>(
      `SELECT id, user_id, balance_cents, currency, last_topped_up FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (balanceCheck.rows.length === 0) {
      throw new Error(`No wallet found for user ${userId}`);
    }
    if (balanceCheck.rows[0].balance_cents + amountCents > MAX_BALANCE_CENTS) {
      throw new Error(`Credit would exceed maximum wallet balance of $${(MAX_BALANCE_CENTS / 100).toFixed(2)}`);
    }

    const walletResult = await client.query<Wallet>(
      `UPDATE wallets
       SET balance_cents = balance_cents + $1,
           last_topped_up = now()
       WHERE user_id = $2
       RETURNING id, user_id, balance_cents, currency, last_topped_up`,
      [amountCents, userId],
    );

    const txResult = await client.query<WalletTransaction>(
      `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description, payment_provider, payment_id)
       VALUES ($1, 'topup', $2, $3, $4, $5)
       RETURNING id, wallet_id, type, amount_cents, description, payment_provider, payment_id, created_at`,
      [walletResult.rows[0].id, amountCents, description, provider, paymentId],
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

export async function debitWallet(
  userId: string,
  amountCents: number,
  description: string,
): Promise<WalletTransaction | null> {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 2_147_483_647) {
    return null;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Lock the wallet row to prevent race conditions
    const walletResult = await client.query<Wallet>(
      `SELECT id, user_id, balance_cents, currency, last_topped_up FROM wallets
       WHERE user_id = $1
       FOR UPDATE`,
      [userId],
    );

    const wallet = walletResult.rows[0];
    if (!wallet || wallet.balance_cents < amountCents) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `UPDATE wallets
       SET balance_cents = balance_cents - $1
       WHERE id = $2`,
      [amountCents, wallet.id],
    );

    const txResult = await client.query<WalletTransaction>(
      `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
       VALUES ($1, 'debit', $2, $3)
       RETURNING id, wallet_id, type, amount_cents, description, payment_provider, payment_id, created_at`,
      [wallet.id, amountCents, description],
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

/**
 * Reserve balance for a proxy session.
 * Atomically deducts reserveAmountCents from balance using FOR UPDATE lock.
 * Returns the wallet ID if successful, null if insufficient balance.
 */
export async function reserveBalance(
  userId: string,
  reserveAmountCents: number,
): Promise<string | null> {
  if (!Number.isInteger(reserveAmountCents) || reserveAmountCents <= 0 || reserveAmountCents > 2_147_483_647) {
    return null;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    const walletResult = await client.query<Wallet>(
      `SELECT id, user_id, balance_cents, currency, last_topped_up FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );

    const wallet = walletResult.rows[0];
    if (!wallet || wallet.balance_cents < reserveAmountCents) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id = $2`,
      [reserveAmountCents, wallet.id],
    );

    // Record reservation hold as a transaction for audit trail
    await client.query(
      `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
       VALUES ($1, 'debit', $2, 'Session reservation hold')`,
      [wallet.id, reserveAmountCents],
    );

    await client.query("COMMIT");
    return wallet.id;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Settle a session: adjust from reserved amount to actual cost.
 * If actualCostCents > reservedCents, debit the difference (may fail if insufficient).
 * If actualCostCents < reservedCents, refund the difference.
 * Records a debit transaction for the actual cost.
 */
export async function settleSession(
  userId: string,
  reservedCents: number,
  actualCostCents: number,
  sessionId: string,
): Promise<boolean> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    const walletResult = await client.query<Wallet>(
      `SELECT id, user_id, balance_cents, currency, last_topped_up FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );

    const wallet = walletResult.rows[0];
    if (!wallet) {
      await client.query("ROLLBACK");
      return false;
    }

    const diff = actualCostCents - reservedCents;
    const sessionLabel = `session ${sessionId.slice(0, 8)}`;

    if (diff > 0) {
      // Need to charge more — check if balance allows
      if (wallet.balance_cents < diff) {
        // Charge whatever is left
        const additional = wallet.balance_cents;
        await client.query(
          `UPDATE wallets SET balance_cents = 0 WHERE id = $1`,
          [wallet.id],
        );
        // Record additional charge (reservation was already recorded)
        if (additional > 0) {
          await client.query(
            `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
             VALUES ($1, 'debit', $2, $3)`,
            [wallet.id, additional, `Proxy usage overage (${sessionLabel})`],
          );
        }
        await client.query("COMMIT");
        return false; // partial payment
      }

      // Debit the additional amount
      await client.query(
        `UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id = $2`,
        [diff, wallet.id],
      );
      // Record additional charge (reservation was already recorded)
      await client.query(
        `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
         VALUES ($1, 'debit', $2, $3)`,
        [wallet.id, diff, `Proxy usage settlement (${sessionLabel})`],
      );
    } else if (diff < 0) {
      // Refund excess reservation, capped at MAX_BALANCE_CENTS
      const refund = Math.min(-diff, MAX_BALANCE_CENTS - wallet.balance_cents);
      if (refund > 0) {
        await client.query(
          `UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id = $2`,
          [refund, wallet.id],
        );
        // Record the refund transaction
        await client.query(
          `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
           VALUES ($1, 'refund', $2, $3)`,
          [wallet.id, refund, `Reservation refund (${sessionLabel})`],
        );
      }
    }
    // If diff == 0, reservation matched actual cost exactly — no additional transaction needed

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Release a reservation back to the wallet (e.g., session failed before any usage).
 */
export async function releaseReservation(
  userId: string,
  reservedCents: number,
): Promise<void> {
  if (reservedCents <= 0) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    // Lock wallet row first to prevent exceeding MAX_BALANCE_CENTS
    const lockResult = await client.query<Wallet>(
      `SELECT id, user_id, balance_cents, currency, last_topped_up FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const wallet = lockResult.rows[0];
    if (!wallet) {
      await client.query("ROLLBACK");
      return;
    }
    // Cap refund to MAX_BALANCE_CENTS to prevent exceeding limit
    const cappedRefund = Math.min(reservedCents, MAX_BALANCE_CENTS - wallet.balance_cents);
    if (cappedRefund <= 0) {
      await client.query("ROLLBACK");
      return;
    }
    await client.query(
      `UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id = $2`,
      [cappedRefund, wallet.id],
    );
    await client.query(
      `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
       VALUES ($1, 'refund', $2, 'Reservation released (session failed)')`,
      [wallet.id, cappedRefund],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Atomically complete an invoice AND credit the wallet in a single
 * DB transaction. Eliminates the crash window between completeInvoice and
 * creditWallet that could result in lost payments.
 * Returns { claimed: true } if the invoice was claimed and wallet credited,
 * or { claimed: false } if the invoice was already processed (idempotent).
 */
export async function atomicCompleteInvoiceAndCredit(
  invoiceId: string,
  userId: string,
  amountCents: number,
  provider: string,
  paymentId: string,
  description: string,
): Promise<{ claimed: boolean; transaction?: WalletTransaction }> {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 2_147_483_647) {
    throw new Error("Credit amount must be a positive integer within valid range");
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Step 1: Atomically claim the invoice (UPDATE WHERE status='pending')
    const claimResult = await client.query(
      `UPDATE payment_invoices SET status = 'completed'
       WHERE id = $1 AND status = 'pending'`,
      [invoiceId],
    );
    if ((claimResult.rowCount ?? 0) === 0) {
      // Already processed — idempotent return
      await client.query("ROLLBACK");
      return { claimed: false };
    }

    // Step 2: Lock wallet and check balance cap
    const balanceCheck = await client.query<Wallet>(
      `SELECT id, user_id, balance_cents, currency, last_topped_up
       FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (balanceCheck.rows.length === 0) {
      throw new Error(`No wallet found for user ${userId}`);
    }
    if (balanceCheck.rows[0].balance_cents + amountCents > MAX_BALANCE_CENTS) {
      throw new Error(`Credit would exceed maximum wallet balance of $${(MAX_BALANCE_CENTS / 100).toFixed(2)}`);
    }

    // Step 3: Credit wallet
    const walletResult = await client.query<Wallet>(
      `UPDATE wallets
       SET balance_cents = balance_cents + $1, last_topped_up = now()
       WHERE user_id = $2
       RETURNING id, user_id, balance_cents, currency, last_topped_up`,
      [amountCents, userId],
    );

    // Step 4: Record transaction
    const txResult = await client.query<WalletTransaction>(
      `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description, payment_provider, payment_id)
       VALUES ($1, 'topup', $2, $3, $4, $5)
       RETURNING id, wallet_id, type, amount_cents, description, payment_provider, payment_id, created_at`,
      [walletResult.rows[0].id, amountCents, description, provider, paymentId],
    );

    await client.query("COMMIT");
    return { claimed: true, transaction: txResult.rows[0] };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getTransactions(
  userId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<WalletTransaction[]> {
  offset = Math.max(0, offset);
  limit = Math.max(1, Math.min(100, limit));
  const result = await query<WalletTransaction>(
    `SELECT wt.id, wt.wallet_id, wt.type, wt.amount_cents, wt.description, wt.payment_provider, wt.payment_id, wt.created_at
     FROM wallet_transactions wt
     JOIN wallets w ON w.id = wt.wallet_id
     WHERE w.user_id = $1
     ORDER BY wt.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return result.rows;
}
