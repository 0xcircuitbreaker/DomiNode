import { Router } from "express";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { clearAuthCookies } from "../helpers/cookies.js";
import { query, getPool, createLogger, userRepo, verifyPassword, isWalletEmail } from "@dominusnode/shared";

const log = createLogger("api:account");
const router = Router();

// Rate limit: 1 export per day per user
const exportLimiter = rateLimit({
  windowMs: 24 * 60 * 60_000, // 24 hours
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Data export limited to once per day. Please try again tomorrow." },
  keyGenerator: (req) => (req as AuthenticatedRequest).user?.userId ?? "unknown",
});

// Rate limit: 1 deletion per hour per user
const deleteLimiter = rateLimit({
  windowMs: 60 * 60_000, // 1 hour
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Account deletion is rate limited. Please try again later." },
  keyGenerator: (req) => (req as AuthenticatedRequest).user?.userId ?? "unknown",
});

const PROXY_INTERNAL_HOST = process.env["PROXY_INTERNAL_HOST"] ?? "localhost";
const PROXY_LISTEN_PORT = process.env["PROXY_LISTEN_PORT"] ?? "8080";

/**
 * GET /api/account/export
 * GDPR data export: returns all personal data as JSON
 */
router.get(
  "/export",
  requireAuth,
  exportLimiter,
  async (req, res) => {
    const { userId } = (req as AuthenticatedRequest).user;

    try {
      // Fetch all user data in parallel
      const [
        userResult,
        walletResult,
        transactionsResult,
        apiKeysResult,
        sessionsResult,
        usageResult,
        invoicesResult,
        auditResult,
        agenticWalletsResult,
        teamMembershipsResult,
        teamInvitesSentResult,
        teamInvitesReceivedResult,
        agenticWalletTransactionsResult,
      ] = await Promise.all([
        query("SELECT id, email, status, created_at, plan_id, wallet_address FROM users WHERE id = $1", [userId]),
        query("SELECT id, balance_cents, currency, last_topped_up FROM wallets WHERE user_id = $1", [userId]),
        query(
          `SELECT wt.id, wt.type, wt.amount_cents, wt.description, wt.payment_provider, wt.created_at
           FROM wallet_transactions wt
           JOIN wallets w ON w.id = wt.wallet_id
           WHERE w.user_id = $1
           ORDER BY wt.created_at DESC
           LIMIT 10000`,
          [userId]
        ),
        query(
          "SELECT id, key_prefix, label, created_at, revoked_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC",
          [userId]
        ),
        // M-1 fix: Omit proxy_ip from export — leaks upstream infrastructure details
        query(
          "SELECT id, started_at, ended_at, bytes_total, status FROM sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 10000",
          [userId]
        ),
        query(
          "SELECT id, bytes_in, bytes_out, cost_cents, proxy_type, target_host, created_at FROM usage_records WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10000",
          [userId]
        ),
        query(
          "SELECT id, provider, external_id, amount_cents, status, created_at FROM payment_invoices WHERE user_id = $1 ORDER BY created_at DESC",
          [userId]
        ),
        query(
          "SELECT id, action, resource, resource_id, ip_address, created_at FROM audit_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10000",
          [userId]
        ),
        // R41 H-3: Include agentic wallets in GDPR export
        query(
          "SELECT id, label, balance_cents, spending_limit_cents, status, created_at FROM agentic_wallets WHERE user_id = $1",
          [userId]
        ),
        // R41 H-3: Include team memberships in GDPR export
        query(
          `SELECT tm.team_id, tm.role, tm.joined_at, t.name AS team_name
           FROM team_members tm JOIN teams t ON t.id = tm.team_id
           WHERE tm.user_id = $1`,
          [userId]
        ),
        // R42 M-1: Include team invites sent by user
        query(
          "SELECT id, team_id, email, role, expires_at, accepted_at, created_at FROM team_invites WHERE invited_by = $1",
          [userId]
        ),
        // R42 M-1: Include team invites received by user
        query(
          `SELECT id, team_id, role, expires_at, accepted_at, created_at
           FROM team_invites WHERE email = (SELECT email FROM users WHERE id = $1)`,
          [userId]
        ),
        // R42 L-2: Include agentic wallet transactions
        query(
          `SELECT awt.id, awt.wallet_id, awt.type, awt.amount_cents, awt.description, awt.created_at
           FROM agentic_wallet_transactions awt
           JOIN agentic_wallets aw ON aw.id = awt.wallet_id
           WHERE aw.user_id = $1
           ORDER BY awt.created_at DESC LIMIT 10000`,
          [userId]
        ),
      ]);

      const exportData = {
        exportedAt: new Date().toISOString(),
        exportVersion: "1.0",
        user: userResult.rows[0] ?? null,
        wallet: walletResult.rows[0] ?? null,
        transactions: transactionsResult.rows,
        apiKeys: apiKeysResult.rows,
        sessions: sessionsResult.rows,
        usageRecords: usageResult.rows,
        paymentInvoices: invoicesResult.rows,
        auditEvents: auditResult.rows,
        agenticWallets: agenticWalletsResult.rows, // R41 H-3
        agenticWalletTransactions: agenticWalletTransactionsResult.rows, // R42 L-2
        teamMemberships: teamMembershipsResult.rows, // R41 H-3
        teamInvitesSent: teamInvitesSentResult.rows, // R42 M-1
        teamInvitesReceived: teamInvitesReceivedResult.rows, // R42 M-1
      };

      log.info("GDPR data export", { userId });

      res.setHeader("Content-Disposition", `attachment; filename="dominusnode-export-${userId}.json"`);
      res.json(exportData);
    } catch (err) {
      log.error("data export failed", { userId, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Data export failed. Please try again later." });
    }
  }
);

/**
 * DELETE /api/account
 * GDPR right to erasure: anonymize user data
 * H-1 fix: Requires password re-authentication for security
 */
router.delete(
  "/",
  requireAuth,
  deleteLimiter,
  async (req, res) => {
    const { userId } = (req as AuthenticatedRequest).user;

    try {
      // Look up user email for auth check
      const emailRow = (await query("SELECT email FROM users WHERE id = $1", [userId])).rows[0];
      if (!emailRow) {
        res.status(404).json({ error: "Account not found." });
        return;
      }
      const userEmail = emailRow.email;

      // Wallet-only accounts don't have a usable password — allow deletion
      // since they already proved identity via JWT from wallet auth
      if (!isWalletEmail(userEmail)) {
        // Password-based accounts: require password re-authentication
        const { password } = req.body ?? {};
        if (!password || typeof password !== "string") {
          res.status(400).json({ error: "Password confirmation required to delete account." });
          return;
        }

        // H-9 fix: Cap password length to prevent bcrypt DoS (15KB → seconds of CPU)
        if (password.length > 128) {
          res.status(400).json({ error: "Password too long." });
          return;
        }

        const user = await userRepo.findUserForAuth(userEmail);
        if (!user || !await verifyPassword(password, user.password_hash)) {
          res.status(403).json({ error: "Incorrect password." });
          return;
        }
      }

      // R29 C-3: Wrap all deletion operations in a single DB transaction.
      // Partial erasure (e.g. email anonymized but browsing history retained) violates GDPR.
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // R41 H-4: Read wallet_address BEFORE anonymization (UPDATE sets it to NULL)
        const walletAddrRow = (await client.query(
          "SELECT wallet_address FROM users WHERE id = $1", [userId]
        )).rows[0];

        // Anonymize user: replace email, clear wallet_address, set status to deleted
        await client.query(
          `UPDATE users SET
            email = 'deleted-' || id || '@deleted.dominusnode.com',
            password_hash = 'DELETED',
            status = 'deleted',
            wallet_address = NULL
           WHERE id = $1`,
          [userId]
        );

        // Anonymize browsing history (GDPR: target_host is personal data)
        await client.query(
          "UPDATE usage_records SET target_host = 'REDACTED' WHERE user_id = $1",
          [userId]
        );

        // R29 H-2: Anonymize wallet transaction payment references (links to external processors)
        await client.query(
          `UPDATE wallet_transactions SET payment_id = 'REDACTED', description = 'REDACTED'
           WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = $1)`,
          [userId]
        );

        // Revoke all API keys
        await client.query(
          "UPDATE api_keys SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
          [userId]
        );

        // Revoke all refresh tokens
        await client.query(
          "UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1 AND NOT revoked",
          [userId]
        );

        // Delete MFA config
        await client.query("DELETE FROM mfa_backup_codes WHERE user_id = $1", [userId]);
        await client.query("DELETE FROM mfa_configs WHERE user_id = $1", [userId]);

        // R37 H-7: Delete password reset tokens and email verification tokens (GDPR completeness)
        await client.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [userId]);
        await client.query("DELETE FROM email_verification_tokens WHERE user_id = $1", [userId]);

        // R40 C-1: Delete wallet challenges by wallet address (table has no user_id column)
        // R41 H-4: walletAddrRow captured BEFORE anonymization (above) so wallet_address is non-NULL
        if (walletAddrRow?.wallet_address) {
          await client.query(
            "DELETE FROM wallet_challenges WHERE address = $1",
            [walletAddrRow.wallet_address.toLowerCase()]
          );
        }

        // R36 H-1: Clean up agentic wallets (GDPR: sub-wallet data is personal)
        await client.query(
          "DELETE FROM agentic_wallet_transactions WHERE wallet_id IN (SELECT id FROM agentic_wallets WHERE user_id = $1)",
          [userId]
        );
        await client.query("DELETE FROM agentic_wallets WHERE user_id = $1", [userId]);

        // R46 C-3: Handle teams owned by this user
        // Revoke all API keys for owned teams
        await client.query(
          `UPDATE api_keys SET revoked_at = NOW()
           WHERE team_id IN (SELECT id FROM teams WHERE owner_id = $1)
           AND revoked_at IS NULL`,
          [userId]
        );
        // Delete team wallet transactions for owned teams
        await client.query(
          `DELETE FROM team_wallet_transactions
           WHERE wallet_id IN (
             SELECT tw.id FROM team_wallets tw
             JOIN teams t ON t.id = tw.team_id WHERE t.owner_id = $1
           )`,
          [userId]
        );
        // Remove all members from owned teams (except self — deleted below)
        await client.query(
          `DELETE FROM team_members
           WHERE team_id IN (SELECT id FROM teams WHERE owner_id = $1)
           AND user_id != $1`,
          [userId]
        );
        // Delete team invites for owned teams
        await client.query(
          `DELETE FROM team_invites
           WHERE team_id IN (SELECT id FROM teams WHERE owner_id = $1)`,
          [userId]
        );
        // Delete team wallets for owned teams
        await client.query(
          `DELETE FROM team_wallets WHERE team_id IN (SELECT id FROM teams WHERE owner_id = $1)`,
          [userId]
        );
        // Delete owned teams
        await client.query("DELETE FROM teams WHERE owner_id = $1", [userId]);

        // R36 H-1: Clean up team memberships and owned teams
        await client.query("DELETE FROM team_invites WHERE invited_by = $1", [userId]);
        // R38 H-1: Delete pending team invites sent TO this user's email
        // (userEmail captured before anonymization above)
        await client.query(
          "DELETE FROM team_invites WHERE email = $1 AND accepted_at IS NULL",
          [userEmail]
        );
        await client.query(
          "DELETE FROM team_members WHERE user_id = $1",
          [userId]
        );

        // R40 H-1: Anonymize team wallet transactions for teams owned by this user
        await client.query(
          `UPDATE team_wallet_transactions SET description = 'REDACTED'
           WHERE wallet_id IN (
             SELECT tw.id FROM team_wallets tw
             JOIN teams t ON t.id = tw.team_id
             WHERE t.owner_id = $1
           )`,
          [userId]
        );

        // R39 H-1: Anonymize audit events (IP addresses and action details are personal data)
        await client.query(
          "UPDATE audit_events SET ip_address = 'REDACTED', details = NULL WHERE user_id = $1",
          [userId]
        );

        // R39 H-1: Anonymize payment invoice external references
        await client.query(
          "UPDATE payment_invoices SET external_id = 'REDACTED' WHERE user_id = $1",
          [userId]
        );

        // R39 H-2: Anonymize session records (proxy_ip is infra, but timestamps are personal)
        await client.query(
          "UPDATE sessions SET proxy_ip = 'REDACTED' WHERE user_id = $1",
          [userId]
        );

        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK");
        throw txErr;
      } finally {
        client.release();
      }

      // Terminate active proxy sessions with auth header (matches admin suspend flow)
      try {
        const terminateUrl = `http://${PROXY_INTERNAL_HOST}:${PROXY_LISTEN_PORT}/internal/terminate-sessions/${userId}`;
        const proxySecret = process.env["PROXY_STATS_SECRET"] ??
          (process.env["JWT_SECRET"]
            ? crypto.createHmac("sha256", process.env["JWT_SECRET"]).update("proxy-stats-endpoint").digest("hex")
            : "");
        const headers: Record<string, string> = { "Content-Length": "0" };
        if (proxySecret) headers["Authorization"] = `Bearer ${proxySecret}`;
        await fetch(terminateUrl, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
      } catch {
        // Best effort — proxy gateway may be unreachable
        log.warn("failed to terminate proxy sessions during account deletion", { userId });
      }

      log.info("account deleted (GDPR erasure)", { userId });

      // R46 C-2: Use clearAuthCookies helper — bare clearCookie() omits path/httpOnly/secure/sameSite
      // options, so the browser won't actually clear the cookie (options must match how it was set)
      clearAuthCookies(res);
      res.json({ message: "Account deleted. Your data has been anonymized." });
    } catch (err) {
      log.error("account deletion failed", { userId, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Account deletion failed. Please contact support." });
    }
  }
);

/**
 * GET /api/account/preferences
 * Returns user privacy preferences
 */
router.get("/preferences", requireAuth, async (req, res) => {
  const { userId } = (req as AuthenticatedRequest).user;
  try {
    const user = await userRepo.findUserById(userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ logTargetHosts: user.log_target_hosts });
  } catch (err) {
    log.error("preferences fetch failed", { userId, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to fetch preferences" });
  }
});

/**
 * PUT /api/account/preferences
 * Update user privacy preferences
 */
router.put("/preferences", requireAuth, async (req, res) => {
  const { userId } = (req as AuthenticatedRequest).user;
  try {
    const { logTargetHosts } = req.body ?? {};
    if (typeof logTargetHosts !== "boolean") {
      res.status(400).json({ error: "logTargetHosts must be a boolean" });
      return;
    }
    const updated = await userRepo.updateLogTargetHosts(userId, logTargetHosts);
    if (!updated) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    log.info("privacy preferences updated", { userId, logTargetHosts });
    res.json({ logTargetHosts });
  } catch (err) {
    log.error("preferences update failed", { userId, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to update preferences" });
  }
});

export default router;
