import { Router } from "express";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { clearAuthCookies } from "../helpers/cookies.js";
import { query, getPool, createLogger, userRepo, adminRepo, agentCreditsRepo, relayErasureRepo, relayExportRepo, verifyPassword, isWalletEmail, getProxyInternalPort } from "@dominusnode/shared";
import { recoverSignerAddress } from "../helpers/verify-signature.js";

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
const deleteChallengeLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many deletion challenges. Please try again later." },
  keyGenerator: (req) => (req as AuthenticatedRequest).user?.userId ?? "unknown",
});

const deleteLimiter = rateLimit({
  windowMs: 60 * 60_000, // 1 hour
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Account deletion is rate limited. Please try again later." },
  keyGenerator: (req) => (req as AuthenticatedRequest).user?.userId ?? "unknown",
});

const PROXY_INTERNAL_HOST = process.env["PROXY_INTERNAL_HOST"] ?? "127.0.0.1";
const PROXY_LISTEN_PORT = String(getProxyInternalPort());

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
        referralCodesResult,
        referralRedemptionsResult,
        affiliateLinksResult,
        affiliateCommissionsResult,
        promoRedemptionsResult,
        loyaltyRewardsResult,
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
        // Include agentic wallets in GDPR export
        query(
          "SELECT id, label, balance_cents, spending_limit_cents, status, created_at FROM agentic_wallets WHERE user_id = $1",
          [userId]
        ),
        // Include team memberships in GDPR export
        query(
          `SELECT tm.team_id, tm.role, tm.joined_at, t.name AS team_name
           FROM team_members tm JOIN teams t ON t.id = tm.team_id
           WHERE tm.user_id = $1`,
          [userId]
        ),
        // Include team invites sent by user
        query(
          "SELECT id, team_id, email, role, expires_at, accepted_at, created_at FROM team_invites WHERE invited_by = $1",
          [userId]
        ),
        // Include team invites received by user
        query(
          `SELECT id, team_id, role, expires_at, accepted_at, created_at
           FROM team_invites WHERE email = (SELECT email FROM users WHERE id = $1)`,
          [userId]
        ),
        // Include agentic wallet transactions
        query(
          `SELECT awt.id, awt.wallet_id, awt.type, awt.amount_cents, awt.description, awt.created_at
           FROM agentic_wallet_transactions awt
           JOIN agentic_wallets aw ON aw.id = awt.wallet_id
           WHERE aw.user_id = $1
           ORDER BY awt.created_at DESC LIMIT 10000`,
          [userId]
        ),
        // Referral/affiliate data
        query(
          "SELECT id, code_prefix, max_uses, uses, credit_cents, active, expires_at, created_at FROM referral_codes WHERE user_id = $1",
          [userId]
        ),
        // Export referral_redemptions for BOTH referee AND referrer sides
        query(
          "SELECT id, referral_code_id, referrer_id, referee_id, credit_cents, created_at FROM referral_redemptions WHERE referee_id = $1 OR referrer_id = $1",
          [userId]
        ),
        query(
          "SELECT id, referee_id, active, created_at FROM affiliate_links WHERE referrer_id = $1",
          [userId]
        ),
        // Export commissions for BOTH referrer AND referee sides
        query(
          "SELECT id, referrer_id, referee_id, topup_cents, commission_cents, commission_rate, status, created_at FROM affiliate_commissions WHERE referrer_id = $1 OR referee_id = $1",
          [userId]
        ),
        query(
          "SELECT id, promo_code_id, credit_cents, created_at FROM promo_redemptions WHERE user_id = $1",
          [userId]
        ),
        query(
          "SELECT id, tier_id, period_start, period_end, spend_cents, reward_cents, status, created_at FROM loyalty_rewards WHERE user_id = $1",
          [userId]
        ),
      ]);

      // Relay-network personal data (nodes, abuse log, charges, earnings, payouts, x402/MPP, ...)
      const relayNetwork = await relayExportRepo.exportRelayPersonalData(
        userId,
        (userResult.rows[0] as { wallet_address?: string | null } | undefined)?.wallet_address ?? null,
      );

      const exportData = {
        exportedAt: new Date().toISOString(),
        exportVersion: "1.2",
        user: userResult.rows[0] ?? null,
        wallet: walletResult.rows[0] ?? null,
        transactions: transactionsResult.rows,
        apiKeys: apiKeysResult.rows,
        sessions: sessionsResult.rows,
        usageRecords: usageResult.rows,
        paymentInvoices: invoicesResult.rows,
        auditEvents: auditResult.rows,
        agenticWallets: agenticWalletsResult.rows,
        agenticWalletTransactions: agenticWalletTransactionsResult.rows,
        teamMemberships: teamMembershipsResult.rows,
        teamInvitesSent: teamInvitesSentResult.rows,
        teamInvitesReceived: teamInvitesReceivedResult.rows,
        referralCodes: referralCodesResult.rows,
        referralRedemptions: referralRedemptionsResult.rows,
        affiliateLinks: affiliateLinksResult.rows,
        affiliateCommissions: affiliateCommissionsResult.rows,
        promoRedemptions: promoRedemptionsResult.rows,
        loyaltyRewards: loyaltyRewardsResult.rows,
        relayNetwork,
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

const HEX64 = /^[0-9a-f]{64}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const sha256Hex = (v: string): string => crypto.createHash("sha256").update(v).digest("hex");

export function accountDeleteMessage(i: { userId: string; wallet: string; nonce: string }): string {
  return [
    "DominusNode account deletion",
    "Action: account_delete",
    `User: ${i.userId}`,
    `Account wallet: ${i.wallet}`,
    "This permanently erases the account. Unspent balance and node credit are forfeited.",
    `Nonce: ${i.nonce}`,
  ].join("\n");
}

/**
 * POST /api/account/delete-challenge
 * Single-use message the linked wallet signs to authorize DELETE /api/account.
 */
router.post("/delete-challenge", requireAuth, deleteChallengeLimiter, async (req, res) => {
  const { userId } = (req as AuthenticatedRequest).user;
  try {
    const row = (await query("SELECT email, wallet_address FROM users WHERE id = $1", [userId])).rows[0];
    if (!row) { res.status(404).json({ error: "Account not found." }); return; }
    if (!isWalletEmail(row.email)) { res.status(400).json({ error: "Password accounts confirm deletion with their password." }); return; }
    const wallet = typeof row.wallet_address === "string" ? row.wallet_address.toLowerCase() : "";
    if (!wallet) { res.status(400).json({ error: "A linked wallet is required to delete this account.", code: "NO_LINKED_WALLET" }); return; }
    const nonce = crypto.randomBytes(32).toString("hex");
    const message = accountDeleteMessage({ userId, wallet, nonce });
    const stored = await agentCreditsRepo.createSignChallenge(userId, "account_delete", sha256Hex(nonce), message);
    if (!stored) { res.status(429).json({ error: "Too many outstanding challenges", code: "RATE_LIMITED" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.json({ nonce, message, expiresAt: stored.expiresAt, signer: wallet });
  } catch (err) {
    log.error("account delete challenge failed", { userId, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to create challenge" });
  }
});

/**
 * DELETE /api/account
 * GDPR right to erasure: anonymize user data
 * H-1 fix: Requires password re-authentication for security
 */
const ADMIN_DELETE_REFUSED = {
  error: "Admin accounts cannot be deleted while they hold an admin role. Ask the root admin to remove the role first.",
  code: "ADMIN_ROLE_HELD",
};
class AdminSelfDeleteError extends Error {}
function isAdminRole(role: unknown): boolean {
  return typeof role === "string" && role !== "" && role !== "none";
}

router.delete(
  "/",
  requireAuth,
  deleteLimiter,
  async (req, res) => {
    const { userId } = (req as AuthenticatedRequest).user;

    try {
      // Look up user email for auth check
      const emailRow = (await query("SELECT email, wallet_address, admin_role FROM users WHERE id = $1", [userId])).rows[0];
      if (!emailRow) {
        res.status(404).json({ error: "Account not found." });
        return;
      }
      // Admins cannot self-erase: the erasure redacts their audit rows and the
      // admin role must be removed (by root) first. Re-checked under the row lock.
      if (isAdminRole(emailRow.admin_role)) {
        res.status(409).json(ADMIN_DELETE_REFUSED);
        return;
      }
      const userEmail = emailRow.email;

      // Wallet accounts: a JWT can be minted from a bare dn_live_ key
      // (verify-key), so erasure needs a fresh EIP-191 signature from the linked
      // wallet over a single-use challenge (POST /api/account/delete-challenge).
      if (isWalletEmail(userEmail)) {
        const wallet = typeof emailRow.wallet_address === "string" ? emailRow.wallet_address.toLowerCase() : "";
        const b = (req.body ?? {}) as Record<string, unknown>;
        const nonce = typeof b["nonce"] === "string" ? b["nonce"].toLowerCase() : "";
        const sig = typeof b["signature"] === "string" ? b["signature"] : "";
        if (!wallet) {
          res.status(400).json({ error: "A linked wallet is required to delete this account.", code: "NO_LINKED_WALLET" });
          return;
        }
        if (!HEX64.test(nonce) || !SIG_RE.test(sig)) {
          res.status(400).json({ error: "Wallet signature required: request POST /api/account/delete-challenge and sign its message.", code: "SIGNATURE_REQUIRED" });
          return;
        }
        // Consume before verifying (single use, no brute force on one challenge).
        const stored = await agentCreditsRepo.consumeSignChallenge(userId, "account_delete", sha256Hex(nonce));
        if (!stored || stored !== accountDeleteMessage({ userId, wallet, nonce })) {
          res.status(400).json({ error: "Invalid or expired challenge", code: "INVALID_CHALLENGE" });
          return;
        }
        if (recoverSignerAddress(stored, sig) !== wallet) {
          res.status(403).json({ error: "Signature does not match your linked wallet", code: "BAD_SIGNATURE" });
          return;
        }
      } else {
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

      // Refuse before touching the proxy (as the admin route does): sessions must
      // not be killed for a delete that will fail. The erasure re-checks under lock.
      const inFlight = await query(relayErasureRepo.PAYOUT_IN_FLIGHT_SQL.replace(/\s+FOR UPDATE\s*$/, ""), [userId]);
      if ((inFlight.rows?.length ?? 0) > 0) {
        res.status(409).json({ error: "A payout is in flight. Retry account deletion once it settles." });
        return;
      }

      // Terminate active proxy sessions BEFORE erasing (matches admin delete flow), so
      // their settles land before the erasure scrubs abuse-log/usage rows. Settles
      // that still arrive later are tombstoned in settleRelayCharge.
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

      // Wrap all deletion operations in a single DB transaction.
      // Partial erasure (e.g. email anonymized but browsing history retained) violates GDPR.
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const locked = await client.query("SELECT admin_role FROM users WHERE id = $1 FOR UPDATE", [userId]);
        if (isAdminRole(locked.rows[0]?.admin_role)) {
          throw new AdminSelfDeleteError();
        }

        // One erasure statement list, shared with the admin delete path.
        await adminRepo.deleteUser(userId, client);

        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK");
        throw txErr;
      } finally {
        client.release();
      }

      log.info("account deleted (GDPR erasure)", { userId });

      // Use clearAuthCookies helper — bare clearCookie() omits path/httpOnly/secure/sameSite
      // options, so the browser won't actually clear the cookie (options must match how it was set)
      clearAuthCookies(res);
      res.json({ message: "Account deleted. Your data has been anonymized." });
    } catch (err) {
      log.error("account deletion failed", { userId, error: err instanceof Error ? err.message : String(err) });
      if (err instanceof AdminSelfDeleteError) {
        res.status(409).json(ADMIN_DELETE_REFUSED);
        return;
      }
      if (err instanceof Error && err.name === "PayoutInFlightError") {
        res.status(409).json({ error: "A payout is in flight. Retry account deletion once it settles." });
        return;
      }
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
