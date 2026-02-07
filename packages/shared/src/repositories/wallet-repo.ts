import { query, getPool } from "../db.js";
import type { Wallet, WalletTransaction } from "../types.js";

export async function createWallet(userId: string): Promise<Wallet> {
  const result = await query<Wallet>(
    `INSERT INTO wallets (user_id)
     VALUES ($1)
     RETURNING *`,
    [userId],
  );
  return result.rows[0];
}

export async function getWallet(userId: string): Promise<Wallet | null> {
  const result = await query<Wallet>(
    `SELECT * FROM wallets WHERE user_id = $1`,
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

export async function creditWallet(
  userId: string,
  amountCents: number,
  provider: string,
  paymentId: string,
  description: string,
): Promise<WalletTransaction> {
  if (amountCents <= 0) throw new Error("Credit amount must be positive");
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const walletResult = await client.query<Wallet>(
      `UPDATE wallets
       SET balance_cents = balance_cents + $1,
           last_topped_up = now()
       WHERE user_id = $2
       RETURNING *`,
      [amountCents, userId],
    );

    if (walletResult.rows.length === 0) {
      throw new Error(`No wallet found for user ${userId}`);
    }

    const txResult = await client.query<WalletTransaction>(
      `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description, payment_provider, payment_id)
       VALUES ($1, 'topup', $2, $3, $4, $5)
       RETURNING *`,
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
  if (amountCents <= 0) return null;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the wallet row to prevent race conditions
    const walletResult = await client.query<Wallet>(
      `SELECT * FROM wallets
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
       RETURNING *`,
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
  if (reserveAmountCents <= 0) return null;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const walletResult = await client.query<Wallet>(
      `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
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

    const walletResult = await client.query<Wallet>(
      `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );

    const wallet = walletResult.rows[0];
    if (!wallet) {
      await client.query("ROLLBACK");
      return false;
    }

    const diff = actualCostCents - reservedCents;

    if (diff > 0) {
      // Need to charge more — check if balance allows
      if (wallet.balance_cents < diff) {
        // Charge whatever is left + record the shortfall
        const available = wallet.balance_cents;
        await client.query(
          `UPDATE wallets SET balance_cents = 0 WHERE id = $1`,
          [wallet.id],
        );
        // Record debit for reserved + available (actual charged amount)
        const charged = reservedCents + available;
        if (charged > 0) {
          await client.query(
            `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
             VALUES ($1, 'debit', $2, $3)`,
            [wallet.id, charged, `Proxy usage (session ${sessionId.slice(0, 8)})`],
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
    } else if (diff < 0) {
      // Refund excess reservation
      await client.query(
        `UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id = $2`,
        [-diff, wallet.id],
      );
    }

    // Record the debit transaction for actual cost
    if (actualCostCents > 0) {
      await client.query(
        `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
         VALUES ($1, 'debit', $2, $3)`,
        [wallet.id, actualCostCents, `Proxy usage (session ${sessionId.slice(0, 8)})`],
      );
    }

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
  await query(
    `UPDATE wallets SET balance_cents = balance_cents + $1
     WHERE user_id = $2`,
    [reservedCents, userId],
  );
}

export async function getTransactions(
  userId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<WalletTransaction[]> {
  const result = await query<WalletTransaction>(
    `SELECT wt.*
     FROM wallet_transactions wt
     JOIN wallets w ON w.id = wt.wallet_id
     WHERE w.user_id = $1
     ORDER BY wt.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return result.rows;
}
