import type pg from "pg";
import { query, getPool } from "../db.js";
import type { Team, TeamMember, TeamInvite, TeamWallet, TeamWalletTransaction, TeamRole } from "../types.js";

// ─── Constants ────────────────────────────────────────────────────────

const MAX_TEAMS_PER_USER = 5;
const MAX_BALANCE_CENTS = 1_000_000; // $10,000
const MAX_INT = 2_147_483_647;
const MAX_NAME_LENGTH = 100;

// ─── Validation ──────────────────────────────────────────────────────

function validateAmountCents(amount: number, label: string): void {
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_INT) {
    throw new Error(`${label} must be a positive integer within valid range`);
  }
}

// ─── Team CRUD ──────────────────────────────────────────────────────

export async function createTeam(
  userId: string,
  name: string,
  planId: string = "payg",
  maxMembers?: number,
): Promise<Team & { walletId: string }> {
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new Error("Team name must be 1-100 characters");
  }
  if (maxMembers !== undefined && (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 100)) {
    throw new Error("maxMembers must be between 1 and 100");
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Atomic count check + insert to prevent TOCTOU
    // Lock the user's team rows first, then count them
    await client.query(
      `SELECT id FROM teams WHERE owner_id = $1 AND status != 'deleted' FOR UPDATE`,
      [userId],
    );
    const countResult = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM teams WHERE owner_id = $1 AND status != 'deleted'`,
      [userId],
    );
    if (parseInt(countResult.rows[0].count, 10) >= MAX_TEAMS_PER_USER) {
      throw new Error(`Maximum of ${MAX_TEAMS_PER_USER} teams per user`);
    }

    // Create team (atomically set maxMembers if provided)
    const teamResult = maxMembers !== undefined
      ? await client.query<Team>(
          `INSERT INTO teams (name, owner_id, plan_id, max_members)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, owner_id, plan_id, max_members, status, created_at`,
          [name, userId, planId, maxMembers],
        )
      : await client.query<Team>(
          `INSERT INTO teams (name, owner_id, plan_id)
           VALUES ($1, $2, $3)
           RETURNING id, name, owner_id, plan_id, max_members, status, created_at`,
          [name, userId, planId],
        );
    const team = teamResult.rows[0];

    // Create team wallet
    const walletResult = await client.query<{ id: string }>(
      `INSERT INTO team_wallets (team_id)
       VALUES ($1)
       RETURNING id`,
      [team.id],
    );

    // Add owner as team member
    await client.query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [team.id, userId],
    );

    await client.query("COMMIT");
    return { ...team, walletId: walletResult.rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getTeam(
  teamId: string,
  userId: string,
): Promise<(Team & { role: TeamRole; balance_cents: number }) | null> {
  const result = await query<Team & { role: TeamRole; balance_cents: number }>(
    `SELECT t.id, t.name, t.owner_id, t.plan_id, t.max_members, t.status, t.created_at,
            tm.role, tw.balance_cents
     FROM teams t
     JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $2
     JOIN team_wallets tw ON tw.team_id = t.id
     WHERE t.id = $1 AND t.status != 'deleted'`,
    [teamId, userId],
  );
  return result.rows[0] ?? null;
}

export async function listTeams(
  userId: string,
): Promise<Array<Team & { role: TeamRole; balance_cents: number }>> {
  const result = await query<Team & { role: TeamRole; balance_cents: number }>(
    `SELECT t.id, t.name, t.owner_id, t.plan_id, t.max_members, t.status, t.created_at,
            tm.role, tw.balance_cents
     FROM teams t
     JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $1
     JOIN team_wallets tw ON tw.team_id = t.id
     WHERE t.status != 'deleted'
     ORDER BY t.created_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function updateTeam(
  teamId: string,
  userId: string,
  updates: { name?: string; maxMembers?: number },
): Promise<Team> {
  // Wrap role check + UPDATE in transaction to prevent TOCTOU
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Verify ownership/admin (inside transaction with lock)
    const memberCheck = await client.query<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
      [teamId, userId],
    );
    if (!memberCheck.rows[0] || (memberCheck.rows[0].role !== "owner" && memberCheck.rows[0].role !== "admin")) {
      throw new Error("Only team owners or admins can update team settings");
    }

    const sets: string[] = [];
    const params: unknown[] = [teamId];
    let idx = 2;

    if (updates.name !== undefined) {
      if (!updates.name || updates.name.length > MAX_NAME_LENGTH) {
        throw new Error("Team name must be 1-100 characters");
      }
      sets.push(`name = $${idx++}`);
      params.push(updates.name);
    }
    if (updates.maxMembers !== undefined) {
      if (!Number.isInteger(updates.maxMembers) || updates.maxMembers < 1 || updates.maxMembers > 100) {
        throw new Error("maxMembers must be between 1 and 100");
      }
      sets.push(`max_members = $${idx++}`);
      params.push(updates.maxMembers);
    }

    if (sets.length === 0) throw new Error("No updates provided");

    const result = await client.query<Team>(
      `UPDATE teams SET ${sets.join(", ")}
       WHERE id = $1 AND status != 'deleted'
       RETURNING id, name, owner_id, plan_id, max_members, status, created_at`,
      params,
    );
    if (result.rows.length === 0) throw new Error("Team not found");

    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteTeam(
  teamId: string,
  userId: string,
): Promise<{ refundedCents: number }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Verify owner only
    const memberCheck = await client.query<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
      [teamId, userId],
    );
    if (!memberCheck.rows[0] || memberCheck.rows[0].role !== "owner") {
      throw new Error("Only the team owner can delete the team");
    }

    // Lock team wallet
    const walletResult = await client.query<{ id: string; balance_cents: number }>(
      `SELECT id, balance_cents FROM team_wallets WHERE team_id = $1 FOR UPDATE`,
      [teamId],
    );
    if (walletResult.rows.length === 0) throw new Error("Team wallet not found");
    const teamWallet = walletResult.rows[0];
    const refundCents = teamWallet.balance_cents;

    if (refundCents > 0) {
      // Lock owner's personal wallet
      const ownerWalletResult = await client.query<{ id: string; balance_cents: number }>(
        `SELECT id, balance_cents FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      if (ownerWalletResult.rows.length === 0) throw new Error("Owner wallet not found");
      const ownerWallet = ownerWalletResult.rows[0];

      if (ownerWallet.balance_cents + refundCents > MAX_BALANCE_CENTS) {
        throw new Error("Cannot delete: refund would exceed personal wallet balance cap. Withdraw funds first.");
      }

      // Credit owner wallet
      await client.query(
        `UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id = $2`,
        [refundCents, ownerWallet.id],
      );
      // Record refund on owner wallet
      await client.query(
        `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
         VALUES ($1, 'refund', $2, $3)`,
        [ownerWallet.id, refundCents, `Refund from deleted team ${teamId.slice(0, 8)}`],
      );
      // Zero team wallet
      await client.query(
        `UPDATE team_wallets SET balance_cents = 0 WHERE id = $1`,
        [teamWallet.id],
      );
    }

    // Clean up pending invites
    await client.query(
      `DELETE FROM team_invites WHERE team_id = $1 AND accepted_at IS NULL`,
      [teamId],
    );

    // Revoke all team API keys
    await client.query(
      `UPDATE api_keys SET revoked_at = now() WHERE team_id = $1 AND revoked_at IS NULL`,
      [teamId],
    );

    // Remove all team members
    await client.query(
      `DELETE FROM team_members WHERE team_id = $1`,
      [teamId],
    );

    // Mark team as deleted
    await client.query(
      `UPDATE teams SET status = 'deleted' WHERE id = $1`,
      [teamId],
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

// ─── Team Wallet ────────────────────────────────────────────────────

export async function getTeamWallet(
  teamId: string,
  userId: string,
): Promise<TeamWallet> {
  // Verify membership
  const memberCheck = await query<{ id: string }>(
    `SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId],
  );
  if (memberCheck.rows.length === 0) throw new Error("Not a member of this team");

  const result = await query<TeamWallet>(
    `SELECT id, team_id, balance_cents, currency, last_topped_up
     FROM team_wallets WHERE team_id = $1`,
    [teamId],
  );
  if (result.rows.length === 0) throw new Error("Team wallet not found");
  return result.rows[0];
}

export async function fundTeamWallet(
  userId: string,
  teamId: string,
  amountCents: number,
): Promise<TeamWalletTransaction> {
  validateAmountCents(amountCents, "Fund amount");

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Verify ownership/admin
    const memberCheck = await client.query<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
      [teamId, userId],
    );
    if (!memberCheck.rows[0] || (memberCheck.rows[0].role !== "owner" && memberCheck.rows[0].role !== "admin")) {
      throw new Error("Only team owners or admins can fund the team wallet");
    }

    // Lock personal wallet
    const personalResult = await client.query<{ id: string; balance_cents: number }>(
      `SELECT id, balance_cents FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (personalResult.rows.length === 0) throw new Error("Personal wallet not found");
    const personalWallet = personalResult.rows[0];

    if (personalWallet.balance_cents < amountCents) {
      throw new Error("Insufficient balance in personal wallet");
    }

    // Lock team wallet
    const teamWalletResult = await client.query<{ id: string; balance_cents: number }>(
      `SELECT id, balance_cents FROM team_wallets WHERE team_id = $1 FOR UPDATE`,
      [teamId],
    );
    if (teamWalletResult.rows.length === 0) throw new Error("Team wallet not found");
    const teamWallet = teamWalletResult.rows[0];

    if (teamWallet.balance_cents + amountCents > MAX_BALANCE_CENTS) {
      throw new Error(`Fund would exceed team wallet balance cap of $${(MAX_BALANCE_CENTS / 100).toFixed(2)}`);
    }

    // Debit personal wallet
    await client.query(
      `UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id = $2`,
      [amountCents, personalWallet.id],
    );
    await client.query(
      `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
       VALUES ($1, 'debit', $2, $3)`,
      [personalWallet.id, amountCents, `Fund team ${teamId.slice(0, 8)}`],
    );

    // Credit team wallet
    await client.query(
      `UPDATE team_wallets SET balance_cents = balance_cents + $1, last_topped_up = now() WHERE id = $2`,
      [amountCents, teamWallet.id],
    );

    // Record team wallet transaction
    const txResult = await client.query<TeamWalletTransaction>(
      `INSERT INTO team_wallet_transactions (wallet_id, type, amount_cents, description)
       VALUES ($1, 'fund', $2, 'Funded from personal wallet')
       RETURNING id, wallet_id, type, amount_cents, description, created_at`,
      [teamWallet.id, amountCents],
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
 * Admin-only: Credit a team wallet directly without personal wallet debit.
 * Used by operator to seed swarm teams with credits ($0 real cost).
 */
export async function adminCreditTeamWallet(
  teamId: string,
  amountCents: number,
  reason: string,
): Promise<void> {
  validateAmountCents(amountCents, "Credit amount");

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    const teamWalletResult = await client.query<{ id: string; balance_cents: number }>(
      `SELECT id, balance_cents FROM team_wallets WHERE team_id = $1 FOR UPDATE`,
      [teamId],
    );
    if (teamWalletResult.rows.length === 0) throw new Error("Team wallet not found");
    const teamWallet = teamWalletResult.rows[0];

    if (teamWallet.balance_cents + amountCents > MAX_BALANCE_CENTS) {
      throw new Error(`Credit would exceed team wallet balance cap of $${(MAX_BALANCE_CENTS / 100).toFixed(2)}`);
    }

    await client.query(
      `UPDATE team_wallets SET balance_cents = balance_cents + $1, last_topped_up = now() WHERE id = $2`,
      [amountCents, teamWallet.id],
    );

    await client.query(
      `INSERT INTO team_wallet_transactions (wallet_id, type, amount_cents, description)
       VALUES ($1, 'fund', $2, $3)`,
      [teamWallet.id, amountCents, reason],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getTeamWalletTransactions(
  teamId: string,
  userId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<TeamWalletTransaction[]> {
  limit = Math.max(1, Math.min(100, limit));
  offset = Math.max(0, offset);

  // Verify membership
  const memberCheck = await query<{ id: string }>(
    `SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId],
  );
  if (memberCheck.rows.length === 0) throw new Error("Not a member of this team");

  const result = await query<TeamWalletTransaction>(
    `SELECT t.id, t.wallet_id, t.type, t.amount_cents, t.description, t.created_at
     FROM team_wallet_transactions t
     JOIN team_wallets tw ON tw.id = t.wallet_id
     WHERE tw.team_id = $1
     ORDER BY t.created_at DESC
     LIMIT $2 OFFSET $3`,
    [teamId, limit, offset],
  );
  return result.rows;
}

/** Reserve balance from team wallet (for proxy session billing) */
export async function reserveTeamBalance(
  teamId: string,
  amountCents: number,
): Promise<string | null> {
  // Validate amount and check team status
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_INT) {
    return null;
  }
  // Use SELECT FOR UPDATE + UPDATE in a transaction to prevent concurrent reservation races.
  // The FOR UPDATE lock serializes concurrent reservation attempts on the same wallet row.
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const walletResult = await client.query<{ id: string; balance_cents: number }>(
      `SELECT tw.id, tw.balance_cents FROM team_wallets tw
       JOIN teams t ON t.id = tw.team_id
       WHERE tw.team_id = $1 AND t.status = 'active'
       FOR UPDATE OF tw`,
      [teamId],
    );
    const wallet = walletResult.rows[0];
    if (!wallet || wallet.balance_cents < amountCents) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE team_wallets SET balance_cents = balance_cents - $1 WHERE id = $2`,
      [amountCents, wallet.id],
    );
    // Record reservation hold as a transaction for audit trail
    await client.query(
      `INSERT INTO team_wallet_transactions (wallet_id, type, amount_cents, description)
       VALUES ($1, 'debit', $2, 'Session reservation hold')`,
      [wallet.id, amountCents],
    );
    await client.query("COMMIT");
    return wallet.id;
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    return null;
  } finally {
    client.release();
  }
}

/** Release a failed reservation back to team wallet */
export async function releaseTeamReservation(
  teamId: string,
  amountCents: number,
): Promise<void> {
  // Atomic release with FOR UPDATE lock + MAX_BALANCE_CENTS cap
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_INT) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const walletResult = await client.query<{ id: string; balance_cents: number }>(
      `SELECT id, balance_cents FROM team_wallets WHERE team_id = $1 FOR UPDATE`,
      [teamId],
    );
    const wallet = walletResult.rows[0];
    if (!wallet) { await client.query("ROLLBACK"); return; }
    if (wallet.balance_cents + amountCents > MAX_BALANCE_CENTS) {
      throw new Error(
        `Team reservation release of ${amountCents} cents would exceed wallet balance cap; release aborted to avoid fund loss`,
      );
    }
    const cappedRefund = amountCents;
    await client.query(
      `UPDATE team_wallets SET balance_cents = balance_cents + $1 WHERE id = $2`,
      [cappedRefund, wallet.id],
    );
    // Record reservation release as a transaction for audit trail
    await client.query(
      `INSERT INTO team_wallet_transactions (wallet_id, type, amount_cents, description)
       VALUES ($1, 'refund', $2, 'Reservation released (session failed)')`,
      [wallet.id, cappedRefund],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Settle a team session inside a caller-owned transaction (caller issued
 * BEGIN and owns COMMIT/ROLLBACK). "invalid"/"no_wallet" write nothing.
 */
export async function settleTeamSessionTx(
  client: Pick<pg.PoolClient, "query">,
  teamId: string,
  reservedCents: number,
  actualCostCents: number,
  sessionId: string,
): Promise<"ok" | "partial" | "no_wallet" | "invalid"> {
  if (!Number.isInteger(reservedCents) || reservedCents < 0 || reservedCents > MAX_INT) return "invalid";
  if (!Number.isInteger(actualCostCents) || actualCostCents < 0 || actualCostCents > MAX_INT) return "invalid";

  const walletResult = await client.query<{ id: string; balance_cents: number }>(
    `SELECT id, balance_cents FROM team_wallets WHERE team_id = $1 FOR UPDATE`,
    [teamId],
  );
  const wallet = walletResult.rows[0];
  if (!wallet) return "no_wallet";

  const diff = reservedCents - actualCostCents;
  if (diff > 0) {
    // Refund excess reservation in full; never silently truncate at the cap.
    if (wallet.balance_cents + diff > MAX_BALANCE_CENTS) {
      throw new Error(
        `Team reservation refund of ${diff} cents would exceed wallet balance cap (session ${sessionId.slice(0, 8)}); settlement aborted to avoid fund loss`,
      );
    }
    await client.query(
      `UPDATE team_wallets SET balance_cents = balance_cents + $1 WHERE id = $2`,
      [diff, wallet.id],
    );
  } else if (diff < 0) {
    // Charge overage — partial charge if insufficient (matches personal wallet behavior)
    const overage = Math.abs(diff);
    if (wallet.balance_cents < overage) {
      const partial = wallet.balance_cents;
      if (partial > 0) {
        await client.query(
          `UPDATE team_wallets SET balance_cents = 0 WHERE id = $1`,
          [wallet.id],
        );
      }
      if (actualCostCents > 0) {
        await client.query(
          `INSERT INTO team_wallet_transactions (wallet_id, type, amount_cents, description)
           VALUES ($1, 'debit', $2, $3)`,
          [wallet.id, actualCostCents, `Proxy session ${sessionId.slice(0, 8)} (partial)`],
        );
      }
      return "partial";
    }
    await client.query(
      `UPDATE team_wallets SET balance_cents = balance_cents - $1 WHERE id = $2`,
      [overage, wallet.id],
    );
  }
  if (actualCostCents > 0) {
    await client.query(
      `INSERT INTO team_wallet_transactions (wallet_id, type, amount_cents, description)
       VALUES ($1, 'debit', $2, $3)`,
      [wallet.id, actualCostCents, `Proxy session ${sessionId.slice(0, 8)}`],
    );
  }
  return "ok";
}

/** Settle a team proxy session: refund excess or charge overage */
export async function settleTeamSession(
  teamId: string,
  reservedCents: number,
  actualCostCents: number,
  sessionId: string,
): Promise<boolean> {
  if (!Number.isInteger(reservedCents) || reservedCents < 0 || reservedCents > MAX_INT) return false;
  if (!Number.isInteger(actualCostCents) || actualCostCents < 0 || actualCostCents > MAX_INT) return false;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const r = await settleTeamSessionTx(client, teamId, reservedCents, actualCostCents, sessionId);
    if (r === "no_wallet" || r === "invalid") { await client.query("ROLLBACK"); return false; }
    await client.query("COMMIT");
    return r === "ok";
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Get team wallet balance (for balance check in proxy gateway) */
export async function getTeamBalance(teamId: string): Promise<number> {
  const result = await query<{ balance_cents: number }>(
    `SELECT balance_cents FROM team_wallets WHERE team_id = $1`,
    [teamId],
  );
  return result.rows[0]?.balance_cents ?? 0;
}

// ─── Members ────────────────────────────────────────────────────────

export async function listMembers(
  teamId: string,
  userId: string,
): Promise<TeamMember[]> {
  // Verify membership
  const memberCheck = await query<{ id: string }>(
    `SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId],
  );
  if (memberCheck.rows.length === 0) throw new Error("Not a member of this team");

  const result = await query<TeamMember & { email: string }>(
    `SELECT tm.id, tm.team_id, tm.user_id, tm.role, tm.joined_at, u.email
     FROM team_members tm
     JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = $1
     ORDER BY tm.joined_at`,
    [teamId],
  );
  return result.rows;
}

export async function addMember(
  teamId: string,
  userId: string,
  targetUserId: string,
  role: TeamRole = "member",
): Promise<TeamMember> {
  if (role === "owner") throw new Error("Cannot add a second owner");

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Verify caller is owner/admin
    const callerCheck = await client.query<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
      [teamId, userId],
    );
    if (!callerCheck.rows[0] || (callerCheck.rows[0].role !== "owner" && callerCheck.rows[0].role !== "admin")) {
      throw new Error("Only team owners or admins can add members");
    }

    // Check team status
    const teamCheck = await client.query<{ max_members: number; status: string }>(
      `SELECT max_members, status FROM teams WHERE id = $1 FOR UPDATE`,
      [teamId],
    );
    if (!teamCheck.rows[0] || teamCheck.rows[0].status !== "active") {
      throw new Error("Team not found or not active");
    }

    // Check member count
    const countResult = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM team_members WHERE team_id = $1`,
      [teamId],
    );
    if (parseInt(countResult.rows[0].count, 10) >= teamCheck.rows[0].max_members) {
      throw new Error("Team has reached maximum member count");
    }

    // Verify target user exists and is active
    const targetUserCheck = await client.query<{ status: string }>(
      `SELECT status FROM users WHERE id = $1`,
      [targetUserId],
    );
    if (!targetUserCheck.rows[0]) {
      throw new Error("Target user not found");
    }
    if (targetUserCheck.rows[0].status !== "active") {
      throw new Error("Target user account is not active");
    }

    const result = await client.query<TeamMember>(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, $3)
       RETURNING id, team_id, user_id, role, joined_at`,
      [teamId, targetUserId, role],
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

export async function updateMemberRole(
  teamId: string,
  userId: string,
  targetUserId: string,
  newRole: TeamRole,
): Promise<TeamMember> {
  if (newRole === "owner") throw new Error("Cannot assign owner role");
  // Cannot change own role
  if (userId === targetUserId) throw new Error("Cannot change your own role");

  // Wrap role check + UPDATE in transaction to prevent TOCTOU
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Verify caller is owner (inside transaction with lock)
    const callerCheck = await client.query<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
      [teamId, userId],
    );
    if (!callerCheck.rows[0] || callerCheck.rows[0].role !== "owner") {
      throw new Error("Only the team owner can change member roles");
    }

    const result = await client.query<TeamMember>(
      `UPDATE team_members SET role = $1
       WHERE team_id = $2 AND user_id = $3 AND role != 'owner'
       RETURNING id, team_id, user_id, role, joined_at`,
      [newRole, teamId, targetUserId],
    );
    if (result.rows.length === 0) throw new Error("Member not found or is the owner");

    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function removeMember(
  teamId: string,
  userId: string,
  targetUserId: string,
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Verify caller is owner/admin
    const callerCheck = await client.query<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
      [teamId, userId],
    );
    if (!callerCheck.rows[0] || (callerCheck.rows[0].role !== "owner" && callerCheck.rows[0].role !== "admin")) {
      throw new Error("Only team owners or admins can remove members");
    }

    // Cannot remove the owner
    const targetCheck = await client.query<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
      [teamId, targetUserId],
    );
    if (!targetCheck.rows[0]) throw new Error("Member not found");
    if (targetCheck.rows[0].role === "owner") throw new Error("Cannot remove the team owner");

    // Admins cannot remove other admins
    if (callerCheck.rows[0].role === "admin" && targetCheck.rows[0].role === "admin") {
      throw new Error("Admins cannot remove other admins");
    }

    // Revoke target's team API keys
    await client.query(
      `UPDATE api_keys SET revoked_at = now()
       WHERE team_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [teamId, targetUserId],
    );

    // Remove member
    await client.query(
      `DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, targetUserId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Invites ────────────────────────────────────────────────────────

export async function createInvite(
  teamId: string,
  userId: string,
  email: string,
  role: TeamRole,
  tokenHash: string,
  expiresAt: Date,
): Promise<TeamInvite> {
  if (role === "owner") throw new Error("Cannot invite as owner");

  // Wrap all checks + INSERT in a single transaction to prevent TOCTOU
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Verify caller is owner/admin (inside transaction)
    const callerCheck = await client.query<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
      [teamId, userId],
    );
    if (!callerCheck.rows[0] || (callerCheck.rows[0].role !== "owner" && callerCheck.rows[0].role !== "admin")) {
      throw new Error("Only team owners or admins can create invites");
    }

    // Check if email is already a member (inside transaction)
    const existingMember = await client.query<{ id: string }>(
      `SELECT tm.id FROM team_members tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1 AND u.email = $2`,
      [teamId, email],
    );
    if (existingMember.rows.length > 0) throw new Error("User is already a member of this team");

    // Check for existing pending invite (inside transaction with lock)
    const existingInvite = await client.query<{ id: string }>(
      `SELECT id FROM team_invites
       WHERE team_id = $1 AND email = $2 AND accepted_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [teamId, email],
    );
    if (existingInvite.rows.length > 0) throw new Error("Pending invite already exists for this email");

    const result = await client.query<TeamInvite>(
      `INSERT INTO team_invites (team_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, team_id, email, role, invited_by, expires_at, accepted_at, created_at`,
      [teamId, email, role, tokenHash, userId, expiresAt],
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

export async function listInvites(
  teamId: string,
  userId: string,
): Promise<TeamInvite[]> {
  // Verify membership
  const memberCheck = await query<{ id: string }>(
    `SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId],
  );
  if (memberCheck.rows.length === 0) throw new Error("Not a member of this team");

  const result = await query<TeamInvite>(
    `SELECT id, team_id, email, role, invited_by, expires_at, accepted_at, created_at
     FROM team_invites
     WHERE team_id = $1 AND accepted_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC`,
    [teamId],
  );
  return result.rows;
}

export async function cancelInvite(
  teamId: string,
  userId: string,
  inviteId: string,
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Verify caller is owner/admin
    const callerCheck = await client.query<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
      [teamId, userId],
    );
    if (!callerCheck.rows[0] || (callerCheck.rows[0].role !== "owner" && callerCheck.rows[0].role !== "admin")) {
      throw new Error("Only team owners or admins can cancel invites");
    }

    const result = await client.query(
      `DELETE FROM team_invites WHERE id = $1 AND team_id = $2 AND accepted_at IS NULL`,
      [inviteId, teamId],
    );
    if ((result.rowCount ?? 0) === 0) throw new Error("Invite not found or already accepted");

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getInviteByToken(
  tokenHash: string,
): Promise<(TeamInvite & { team_name: string }) | null> {
  const result = await query<TeamInvite & { team_name: string }>(
    `SELECT ti.id, ti.team_id, ti.email, ti.role, ti.invited_by, ti.expires_at, ti.accepted_at, ti.created_at,
            t.name AS team_name
     FROM team_invites ti
     JOIN teams t ON t.id = ti.team_id
     WHERE ti.token_hash = $1 AND ti.accepted_at IS NULL`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

export async function acceptInvite(
  tokenHash: string,
  userId: string,
): Promise<TeamMember> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Find and lock invite
    const inviteResult = await client.query<TeamInvite>(
      `SELECT id, team_id, email, role, expires_at, accepted_at
       FROM team_invites
       WHERE token_hash = $1 AND accepted_at IS NULL
       FOR UPDATE`,
      [tokenHash],
    );
    if (inviteResult.rows.length === 0) throw new Error("Invite not found or already accepted");
    const invite = inviteResult.rows[0];

    if (new Date(invite.expires_at) < new Date()) throw new Error("Invite has expired");

    // Verify the accepting user's email matches the invite email
    const userCheck = await client.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`,
      [userId],
    );
    if (!userCheck.rows[0]) throw new Error("User not found");
    if (userCheck.rows[0].email.toLowerCase() !== invite.email.toLowerCase()) {
      throw new Error("Invite was sent to a different email address");
    }

    // Check team status and member count
    const teamCheck = await client.query<{ max_members: number; status: string }>(
      `SELECT max_members, status FROM teams WHERE id = $1 FOR UPDATE`,
      [invite.team_id],
    );
    if (!teamCheck.rows[0] || teamCheck.rows[0].status !== "active") {
      throw new Error("Team not found or not active");
    }

    const countResult = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM team_members WHERE team_id = $1`,
      [invite.team_id],
    );
    if (parseInt(countResult.rows[0].count, 10) >= teamCheck.rows[0].max_members) {
      throw new Error("Team has reached maximum member count");
    }

    // Check if already a member
    const existingMember = await client.query<{ id: string }>(
      `SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [invite.team_id, userId],
    );
    if (existingMember.rows.length > 0) throw new Error("Already a member of this team");

    // Add member
    const memberResult = await client.query<TeamMember>(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, $3)
       RETURNING id, team_id, user_id, role, joined_at`,
      [invite.team_id, userId, invite.role],
    );

    // Mark invite as accepted
    await client.query(
      `UPDATE team_invites SET accepted_at = now() WHERE id = $1`,
      [invite.id],
    );

    await client.query("COMMIT");
    return memberResult.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Team API Keys ──────────────────────────────────────────────────

export async function createTeamApiKey(
  teamId: string,
  userId: string,
  keyHash: string,
  keyPrefix: string,
  label: string,
): Promise<{ id: string; key_prefix: string; label: string; created_at: Date }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Verify membership
    const memberCheck = await client.query<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
      [teamId, userId],
    );
    if (!memberCheck.rows[0] || (memberCheck.rows[0].role !== "owner" && memberCheck.rows[0].role !== "admin")) {
      throw new Error("Only team owners or admins can create team API keys");
    }

    // Verify team is active
    const teamCheck = await client.query<{ status: string }>(
      `SELECT status FROM teams WHERE id = $1 FOR UPDATE`,
      [teamId],
    );
    if (!teamCheck.rows[0] || teamCheck.rows[0].status !== "active") {
      throw new Error("Team not found or not active");
    }

    const result = await client.query<{ id: string; key_prefix: string; label: string; created_at: Date }>(
      `INSERT INTO api_keys (user_id, team_id, key_hash, key_prefix, label)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, key_prefix, label, created_at`,
      [userId, teamId, keyHash, keyPrefix, label],
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

export async function listTeamApiKeys(
  teamId: string,
  userId: string,
): Promise<Array<{ id: string; user_id: string; key_prefix: string; label: string; team_id: string; created_at: Date; revoked_at: Date | null }>> {
  // Verify membership
  const memberCheck = await query<{ id: string }>(
    `SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId],
  );
  if (memberCheck.rows.length === 0) throw new Error("Not a member of this team");

  const result = await query<{ id: string; user_id: string; key_prefix: string; label: string; team_id: string; created_at: Date; revoked_at: Date | null }>(
    `SELECT id, user_id, key_prefix, label, team_id, created_at, revoked_at
     FROM api_keys
     WHERE team_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [teamId],
  );
  return result.rows;
}

export async function revokeTeamApiKey(
  teamId: string,
  userId: string,
  keyId: string,
): Promise<boolean> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Verify caller is owner/admin
    const callerCheck = await client.query<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
      [teamId, userId],
    );
    if (!callerCheck.rows[0] || (callerCheck.rows[0].role !== "owner" && callerCheck.rows[0].role !== "admin")) {
      throw new Error("Only team owners or admins can revoke team API keys");
    }

    const result = await client.query(
      `UPDATE api_keys SET revoked_at = now()
       WHERE id = $1 AND team_id = $2 AND revoked_at IS NULL`,
      [keyId, teamId],
    );

    await client.query("COMMIT");
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Team-wallet twin of wallet-repo accrueCarryTx (sub-cent carry under the row lock). */
export async function accrueTeamCarryTx(
  client: Pick<pg.PoolClient, "query">,
  teamId: string,
  grossMusd: bigint,
): Promise<{ cents: bigint; carryMusd: bigint } | null> {
  if (grossMusd < 0n) throw new Error("grossMusd must be >= 0");
  const r = await client.query<{ id: string; carry_musd: string }>(
    `SELECT id, carry_musd FROM team_wallets WHERE team_id = $1 FOR UPDATE`,
    [teamId],
  );
  const w = r.rows[0];
  if (!w) return null;
  const total = BigInt(w.carry_musd ?? "0") + grossMusd;
  const cents = total / 10_000n;
  const carryMusd = total % 10_000n;
  await client.query(`UPDATE team_wallets SET carry_musd = $1 WHERE id = $2`, [carryMusd.toString(), w.id]);
  return { cents, carryMusd };
}
