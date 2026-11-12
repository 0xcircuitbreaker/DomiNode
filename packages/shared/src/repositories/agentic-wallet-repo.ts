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
      `SELECT id, user_id, label, balance_cents, spending_limit_cents, daily_limit_cents, allowed_domains, status, created_at
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
    if (agenticWallet.balance_cents + amountCents > MAX_BALANCE_CENTS) {
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
      `SELECT id, user_id, label, balance_cents, spending_limit_cents, daily_limit_cents, allowed_domains, status, created_at
       FROM agentic_wallets
       WHERE id = $1 AND user_id = $2 AND status = 'active'
       FOR UPDATE`,
      [walletId, userId],
    );
    if (walletResult.rows.length === 0) {
      throw new Error("Agentic wallet not found or not active (frozen wallets must be unfrozen before deletion)");
    }

    const agenticWallet = walletResult.rows[0];
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
