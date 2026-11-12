import { Router } from "express";
import * as crypto from "node:crypto";
import { adminRepo, createLogger, userRepo, refreshTokenRepo, waitlistRepo, walletRepo, teamRepo, planRepo, referralRepo, sendWaitlistApprovalEmail, sanitizeString, hasMinRole, getProxyInternalPort, relayErasureRepo, query as dbQuery } from "@dominusnode/shared";
import type { AdminRole, DbTxClient } from "@dominusnode/shared";
import type { NextFunction, Request, Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { audit, HttpError, requireReason, withAdminTx, type TxClient } from "./admin-network-common.js";
import { requireAdmin, requireCybersecurityAdmin, requireRootAdmin } from "../middleware/admin.js";
import rateLimit from "express-rate-limit";

const router = Router();
const log = createLogger("api:admin");

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Max single credit operation: $500 (50000 cents) — prevents fat-finger mistakes
const MAX_CREDIT_AMOUNT_CENTS = parseInt(process.env["ADMIN_MAX_CREDIT_CENTS"] ?? "50000", 10);
const SAFE_MAX_CREDIT = Number.isFinite(MAX_CREDIT_AMOUNT_CENTS) && MAX_CREDIT_AMOUNT_CENTS > 0
  ? MAX_CREDIT_AMOUNT_CENTS : 50000;

const VALID_ASSIGNABLE_ROLES = new Set(["none", "admin", "cybersecurity_admin"]);

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

/** Admin tx client as the shared repositories' client type. */
const pc = (c: TxClient): DbTxClient => c as unknown as DbTxClient;

/** Validate the required reason; on failure answer 400 and return null. */
function reasonOr400(req: Parameters<typeof requireReason>[0], res: Response): string | null {
  try {
    return requireReason(req);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "reason is required" });
    return null;
  }
}

/**
 * Reason check as middleware, so it runs before a rate limiter: a request
 * with a bad reason gets 400 without using up the limiter window.
 */
function requireReasonFirst(req: Request, res: Response, next: NextFunction): void {
  const reason = reasonOr400(req as Parameters<typeof requireReason>[0], res);
  if (reason === null) return;
  res.locals.auditReason = reason;
  next();
}

/** HttpError thrown inside withAdminTx (e.g. role re-check) → its status. */
function sendHttpError(res: Response, err: unknown): boolean {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

// All admin routes require auth + admin (base level)
router.use(requireAuth);
router.use(requireAdmin);

// ─── User Management ────────────────────────────────────────────────

// GET /api/admin/users — list all users (paginated)
router.get("/users", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));

    const result = await adminRepo.listUsers(page, limit);

    res.json({
      users: result.users,
      pagination: {
        page,
        limit,
        total: result.total,
        totalPages: Math.ceil(result.total / limit),
      },
    });
  } catch (err) {
    log.error("failed to list users", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to list users" });
  }
});

// GET /api/admin/users/:id — get user details
router.get("/users/:id", async (req, res) => {
  if (!isValidUuid(req.params.id)) {
    res.status(400).json({ error: "Invalid user ID format" });
    return;
  }
  try {
    const user = await adminRepo.getUserDetails(req.params.id);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ user });
  } catch (err) {
    log.error("failed to get user details", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to get user details" });
  }
});

// PUT /api/admin/users/:id/suspend — suspend user
router.put("/users/:id/suspend", async (req, res) => {
  if (!isValidUuid(req.params.id)) {
    res.status(400).json({ error: "Invalid user ID format" });
    return;
  }
  const { userId } = (req as unknown as AuthenticatedRequest).user;
  if (req.params.id === userId) {
    res.status(400).json({ error: "Cannot suspend your own account" });
    return;
  }
  const reason = reasonOr400(req, res);
  if (reason === null) return;
  try {
    // Prevent admin-to-admin attacks — only root_admin can act on other admins
    const targetUser = await userRepo.findUserById(req.params.id);
    const callerRole = (req as unknown as AuthenticatedRequest).user.adminRole as AdminRole ?? "none";
    if (targetUser?.is_admin && !hasMinRole(callerRole, "root_admin")) {
      res.status(403).json({ error: "Only root admin can suspend another admin account" });
      return;
    }
    // The root admin account can never be suspended
    if (adminRepo.isRootAdmin(targetUser)) {
      res.status(403).json({ error: "Root admin account cannot be suspended" });
      return;
    }
    // Suspend + revoke keys/tokens + audit row in one transaction
    const targetId = req.params.id;
    const { revokedKeys, revokedTokens } = await withAdminTx(userId, async (c) => {
      const changed = await adminRepo.suspendUser(targetId, pc(c));
      // Revoke all API keys and refresh tokens so the suspended user is immediately locked out
      const keys = await userRepo.revokeAllApiKeys(targetId, pc(c));
      const tokens = await refreshTokenRepo.revokeAllForUser(targetId, pc(c));
      await audit(c, req, "user_suspend", "user", targetId, {
        reason, previousStatus: targetUser?.status ?? null, newStatus: "suspended", changed,
        revokedKeys: keys, revokedTokens: tokens,
      });
      return { revokedKeys: keys, revokedTokens: tokens };
    });
    // Signal proxy-gateway to terminate active sessions for this user
    let terminatedSessions = 0;
    try {
      const proxyHost = process.env["PROXY_INTERNAL_HOST"] ?? "127.0.0.1";
      const proxyPort = String(getProxyInternalPort());
      // Derive a separate stats secret from JWT_SECRET using HMAC
      const proxySecret = process.env["PROXY_STATS_SECRET"] ??
        (process.env["JWT_SECRET"]
          ? (await import("node:crypto")).createHmac("sha256", process.env["JWT_SECRET"]).update("proxy-stats-endpoint").digest("hex")
          : "");
      const headers: Record<string, string> = { "Content-Length": "0" };
      if (proxySecret) headers["Authorization"] = `Bearer ${proxySecret}`;
      const resp = await fetch(`http://${proxyHost}:${proxyPort}/internal/terminate-sessions/${req.params.id}`, {
        method: "POST",
        headers,
        redirect: "error", // Prevent SSRF via redirect
      });
      if (resp.ok) {
        const body = await resp.json() as { terminated: number };
        terminatedSessions = body.terminated;
      }
    } catch {
      // Best effort — proxy-gateway may not be running in the same process
      log.warn("could not signal proxy-gateway to terminate sessions", { targetUserId: req.params.id });
    }
    log.info("user suspended", { targetUserId: req.params.id, revokedKeys, revokedTokens, terminatedSessions });
    res.json({ message: "User suspended" });
  } catch (err) {
    if (sendHttpError(res, err)) return;
    log.error("failed to suspend user", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to suspend user" });
  }
});

// PUT /api/admin/users/:id/activate — reactivate user
router.put("/users/:id/activate", async (req, res) => {
  if (!isValidUuid(req.params.id)) {
    res.status(400).json({ error: "Invalid user ID format" });
    return;
  }
  const { userId } = (req as unknown as AuthenticatedRequest).user;
  if (req.params.id === userId) {
    res.status(400).json({ error: "Cannot modify your own account" });
    return;
  }
  const reason = reasonOr400(req, res);
  if (reason === null) return;
  try {
    // Prevent reactivating deleted or already-active users
    const targetUser = await userRepo.findUserById(req.params.id);
    if (!targetUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (targetUser.status === "deleted") {
      res.status(400).json({ error: "Cannot reactivate a deleted account" });
      return;
    }
    if (targetUser.status === "active") {
      res.status(400).json({ error: "User is already active" });
      return;
    }
    // Prevent admin-to-admin attacks — only root_admin can act on other admins
    const activateCallerRole = (req as unknown as AuthenticatedRequest).user.adminRole as AdminRole ?? "none";
    if (targetUser.is_admin && !hasMinRole(activateCallerRole, "root_admin")) {
      res.status(403).json({ error: "Only root admin can reactivate another admin account" });
      return;
    }
    const targetId = req.params.id;
    await withAdminTx(userId, async (c) => {
      const changed = await adminRepo.reactivateUser(targetId, pc(c));
      await audit(c, req, "user_activate", "user", targetId, {
        reason, previousStatus: targetUser.status, newStatus: "active", changed,
      });
    });
    log.info("user reactivated", { targetUserId: req.params.id });
    res.json({ message: "User reactivated" });
  } catch (err) {
    if (sendHttpError(res, err)) return;
    log.error("failed to reactivate user", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to reactivate user" });
  }
});

// DELETE /api/admin/users/:id — soft-delete user
router.delete("/users/:id", async (req, res) => {
  if (!isValidUuid(req.params.id)) {
    res.status(400).json({ error: "Invalid user ID format" });
    return;
  }
  const { userId } = (req as unknown as AuthenticatedRequest).user;
  if (req.params.id === userId) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }
  const reason = reasonOr400(req, res);
  if (reason === null) return;
  try {
    // Prevent admin-to-admin attacks — only root_admin can act on other admins
    const targetUser = await userRepo.findUserById(req.params.id);
    const deleteCallerRole = (req as unknown as AuthenticatedRequest).user.adminRole as AdminRole ?? "none";
    if (targetUser?.is_admin && !hasMinRole(deleteCallerRole, "root_admin")) {
      res.status(403).json({ error: "Only root admin can delete another admin account" });
      return;
    }
    // The root admin account can never be deleted
    if (adminRepo.isRootAdmin(targetUser)) {
      res.status(403).json({ error: "Root admin account cannot be deleted" });
      return;
    }
    // Refuse before touching the proxy: erasure cannot run while a payout may
    // be on-chain, and sessions should not be killed for a delete that fails.
    // deleteUser() re-checks under lock; that race is caught below.
    const inFlight = await dbQuery(relayErasureRepo.PAYOUT_IN_FLIGHT_SQL.replace(/\s+FOR UPDATE\s*$/, ""), [req.params.id]);
    if ((inFlight.rows?.length ?? 0) > 0) {
      res.status(409).json({ error: "A payout is in flight; retry after it settles" });
      return;
    }
    // API key/refresh token/MFA revocation moved inside adminRepo.deleteUser() transaction
    // to eliminate race window between separate non-transactional calls and deleteUser().
    // Terminate active proxy sessions before deleting user (same as suspend)
    let terminatedSessions = 0;
    try {
      const proxyHost = process.env["PROXY_INTERNAL_HOST"] ?? "127.0.0.1";
      const proxyPort = String(getProxyInternalPort());
      const proxySecret = process.env["PROXY_STATS_SECRET"] ??
        (process.env["JWT_SECRET"]
          ? (await import("node:crypto")).createHmac("sha256", process.env["JWT_SECRET"]).update("proxy-stats-endpoint").digest("hex")
          : "");
      const headers: Record<string, string> = { "Content-Length": "0" };
      if (proxySecret) headers["Authorization"] = `Bearer ${proxySecret}`;
      const resp = await fetch(`http://${proxyHost}:${proxyPort}/internal/terminate-sessions/${req.params.id}`, {
        method: "POST",
        headers,
        redirect: "error", // Prevent SSRF via redirect
      });
      if (resp.ok) {
        const body = await resp.json() as { terminated: number };
        terminatedSessions = body.terminated;
      }
    } catch {
      log.warn("could not signal proxy-gateway to terminate sessions", { targetUserId: req.params.id });
    }
    const targetId = req.params.id;
    await withAdminTx(userId, async (c) => {
      await adminRepo.deleteUser(targetId, pc(c));
      await audit(c, req, "user_delete", "user", targetId, { reason, previousStatus: targetUser?.status ?? null, newStatus: "deleted" });
    });
    log.info("user deleted (soft)", { targetUserId: req.params.id, terminatedSessions });
    res.json({ message: "User deleted" });
  } catch (err) {
    if (err instanceof Error && err.name === "PayoutInFlightError") {
      res.status(409).json({ error: "A payout is in flight; retry after it settles" });
      return;
    }
    if (sendHttpError(res, err)) return;
    log.error("failed to delete user", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ─── Revenue Analytics ──────────────────────────────────────────────

// GET /api/admin/revenue — revenue stats
router.get("/revenue", async (req, res) => {
  try {
    let since = req.query.since
      ? new Date(req.query.since as string)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const until = req.query.until
      ? new Date(req.query.until as string)
      : new Date();

    if (isNaN(since.getTime()) || isNaN(until.getTime())) {
      res.status(400).json({ error: "Invalid date format for 'since' or 'until'" });
      return;
    }

    // Cap date range to max 365 days for admin
    const MAX_RANGE_MS = 365 * 24 * 60 * 60 * 1000;
    if (until.getTime() - since.getTime() > MAX_RANGE_MS) {
      since = new Date(until.getTime() - MAX_RANGE_MS);
    }

    const stats = await adminRepo.getRevenueStats(since, until);

    res.json({
      ...stats,
      totalRevenueUsd: stats.totalRevenueCents / 100,
      avgTransactionUsd: stats.avgTransactionCents / 100,
      period: {
        since: since.toISOString(),
        until: until.toISOString(),
      },
    });
  } catch (err) {
    log.error("failed to get revenue stats", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to get revenue stats" });
  }
});

// GET /api/admin/revenue/daily — daily revenue breakdown
router.get("/revenue/daily", async (req, res) => {
  try {
    let since = req.query.since
      ? new Date(req.query.since as string)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const until = req.query.until
      ? new Date(req.query.until as string)
      : new Date();

    if (isNaN(since.getTime()) || isNaN(until.getTime())) {
      res.status(400).json({ error: "Invalid date format for 'since' or 'until'" });
      return;
    }

    // Cap date range to max 365 days for admin
    const MAX_RANGE_MS = 365 * 24 * 60 * 60 * 1000;
    if (until.getTime() - since.getTime() > MAX_RANGE_MS) {
      since = new Date(until.getTime() - MAX_RANGE_MS);
    }

    const days = await adminRepo.getDailyRevenue(since, until);

    res.json({
      days: days.map((d) => ({
        ...d,
        revenueUsd: d.revenueCents / 100,
      })),
      period: {
        since: since.toISOString(),
        until: until.toISOString(),
      },
    });
  } catch (err) {
    log.error("failed to get daily revenue", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to get daily revenue" });
  }
});

// ─── System Stats ───────────────────────────────────────────────────

// GET /api/admin/stats — system stats
router.get("/stats", async (_req, res) => {
  try {
    const stats = await adminRepo.getSystemStats();
    res.json(stats);
  } catch (err) {
    log.error("failed to get system stats", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to get system stats" });
  }
});

// ─── Waitlist Management ─────────────────────────────────────────────

const WAITLIST_STATUSES = new Set(["pending", "notified", "registered", "cancelled"]);

// GET /api/admin/waitlist — paginated waitlist with optional status filter
router.get("/waitlist", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const statusFilter = req.query.status ? sanitizeString(req.query.status as string, 20) : undefined;

    if (statusFilter && !WAITLIST_STATUSES.has(statusFilter)) {
      res.status(400).json({ error: "Invalid status filter" });
      return;
    }

    const result = await waitlistRepo.listWaitlist(page, limit, statusFilter);
    const pending = await waitlistRepo.countPending();

    res.json({
      entries: result.entries,
      pendingCount: pending,
      pagination: {
        page,
        limit,
        total: result.total,
        totalPages: Math.ceil(result.total / limit),
      },
    });
  } catch (err) {
    log.error("failed to list waitlist", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to list waitlist" });
  }
});

// POST /api/admin/waitlist/:id/approve — approve a single waitlist entry
router.post("/waitlist/:id/approve", async (req, res) => {
  if (!isValidUuid(req.params.id)) {
    res.status(400).json({ error: "Invalid waitlist entry ID" });
    return;
  }
  const reason = reasonOr400(req, res);
  if (reason === null) return;
  const { userId: adminUserId } = (req as unknown as AuthenticatedRequest).user;
  try {
    const entry = await waitlistRepo.findById(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "Waitlist entry not found" });
      return;
    }
    if (entry.status !== "pending") {
      res.status(400).json({ error: `Entry is already ${entry.status}` });
      return;
    }

    const entryId = req.params.id;
    const marked = await withAdminTx(adminUserId, async (c) => {
      const ok = await waitlistRepo.markNotified(entryId, pc(c));
      if (ok) await audit(c, req, "waitlist_approve", "waitlist", entryId, { reason, previousStatus: entry.status, newStatus: "notified" });
      return ok;
    });
    if (!marked) {
      res.status(400).json({ error: "Failed to approve entry" });
      return;
    }

    // Send approval email (non-blocking)
    sendWaitlistApprovalEmail(entry.email).catch((err) => {
      log.error("failed to send waitlist approval email", { entryId: req.params.id, error: err instanceof Error ? err.message : String(err) });
    });

    log.info("waitlist entry approved", { entryId: req.params.id, email: entry.email.slice(0, 3) + "***" });
    res.json({ message: "Entry approved and notification sent" });
  } catch (err) {
    if (sendHttpError(res, err)) return;
    log.error("failed to approve waitlist entry", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to approve waitlist entry" });
  }
});

// POST /api/admin/waitlist/bulk-approve — approve N oldest pending entries
router.post("/waitlist/bulk-approve", async (req, res) => {
  const reason = reasonOr400(req, res);
  if (reason === null) return;
  const { userId: adminUserId } = (req as unknown as AuthenticatedRequest).user;
  try {
    const count = Math.min(100, Math.max(1, parseInt(req.body.count ?? "10", 10) || 10));

    const pendingEntries = await waitlistRepo.getPendingEmails(count);
    if (pendingEntries.length === 0) {
      res.json({ approved: 0, message: "No pending entries to approve" });
      return;
    }

    const ids = pendingEntries.map((e) => e.id);
    const approvedIds = await withAdminTx(adminUserId, async (c) => {
      const updated = await waitlistRepo.bulkNotify(ids, pc(c));
      await audit(c, req, "waitlist_bulk_approve", "waitlist", "bulk", {
        reason, requested: count, approved: updated.length, entryIds: updated,
      });
      return updated;
    });
    const approved = approvedIds.length;
    const approvedSet = new Set(approvedIds);

    // Send approval emails only to entries this call approved (best-effort)
    for (const entry of pendingEntries.filter((e) => approvedSet.has(e.id))) {
      sendWaitlistApprovalEmail(entry.email).catch((err) => {
        log.error("failed to send bulk approval email", { email: entry.email.slice(0, 3) + "***", error: err instanceof Error ? err.message : String(err) });
      });
    }

    log.info("bulk waitlist approval", { approved, requested: count });
    res.json({ approved, message: `${approved} entries approved and notified` });
  } catch (err) {
    if (sendHttpError(res, err)) return;
    log.error("failed to bulk approve waitlist", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to bulk approve waitlist entries" });
  }
});

// DELETE /api/admin/waitlist/:id — cancel a waitlist entry
router.delete("/waitlist/:id", async (req, res) => {
  if (!isValidUuid(req.params.id)) {
    res.status(400).json({ error: "Invalid waitlist entry ID" });
    return;
  }
  const reason = reasonOr400(req, res);
  if (reason === null) return;
  const { userId: adminUserId } = (req as unknown as AuthenticatedRequest).user;
  try {
    const entryId = req.params.id;
    const cancelled = await withAdminTx(adminUserId, async (c) => {
      const ok = await waitlistRepo.cancelEntry(entryId, pc(c));
      if (ok) await audit(c, req, "waitlist_cancel", "waitlist", entryId, { reason, newStatus: "cancelled" });
      return ok;
    });
    if (!cancelled) {
      res.status(404).json({ error: "Entry not found or already processed" });
      return;
    }
    log.info("waitlist entry cancelled", { entryId: req.params.id });
    res.json({ message: "Entry cancelled" });
  } catch (err) {
    if (sendHttpError(res, err)) return;
    log.error("failed to cancel waitlist entry", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to cancel waitlist entry" });
  }
});

// ─── Plan Assignment ─────────────────────────────────────────────────

// PUT /api/admin/users/:id/plan — assign a plan to a user
router.put("/users/:id/plan", async (req, res) => {
  if (!isValidUuid(req.params.id)) {
    res.status(400).json({ error: "Invalid user ID format" });
    return;
  }

  const { planId } = req.body as { planId?: string };
  if (!planId || typeof planId !== "string" || planId.length > 100) {
    res.status(400).json({ error: "planId is required (string, max 100 chars)" });
    return;
  }

  // Sanitize planId — only allow alphanumeric + hyphens + underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(planId)) {
    res.status(400).json({ error: "Invalid planId format" });
    return;
  }

  const reason = reasonOr400(req, res);
  if (reason === null) return;

  try {
    const { userId: adminId } = (req as unknown as AuthenticatedRequest).user;
    const targetId = req.params.id;
    await withAdminTx(adminId, async (c) => {
      const prev = await c.query<{ plan_id: string | null }>(`SELECT plan_id FROM users WHERE id = $1 FOR UPDATE`, [targetId]);
      await planRepo.setUserPlan(targetId, planId, pc(c));
      await audit(c, req, "user_plan_set", "user", targetId, { reason, previousPlanId: prev.rows[0]?.plan_id ?? null, newPlanId: planId });
    });
    log.info("admin assigned plan", { adminId, targetUserId: req.params.id, planId });
    res.json({ message: "Plan assigned", userId: req.params.id, planId });
  } catch (err) {
    if (sendHttpError(res, err)) return;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found")) {
      res.status(404).json({ error: msg });
      return;
    }
    log.error("failed to assign plan", { error: msg });
    res.status(500).json({ error: "Failed to assign plan" });
  }
});

// ─── Admin Wallet Credit (operator-only, mints credits) ─────────────

// Extra rate limit: 10 credit operations per 15 minutes
const creditLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Credit rate limit exceeded" },
});

// POST /api/admin/credit-wallet — mint credits into a user or team wallet
// Restricted to cybersecurity_admin+ role (cybersecurity admins and root admin)
router.post("/credit-wallet", requireCybersecurityAdmin, creditLimiter, async (req, res) => {
  const { userId: adminId } = (req as unknown as AuthenticatedRequest).user;

  const { targetUserId, teamId, amountCents, reason } = req.body as {
    targetUserId?: string;
    teamId?: string;
    amountCents?: number;
    reason?: string;
  };

  // Must specify either user or team, not both
  if ((!targetUserId && !teamId) || (targetUserId && teamId)) {
    res.status(400).json({ error: "Specify either targetUserId or teamId, not both" });
    return;
  }

  if (targetUserId && !isValidUuid(targetUserId)) {
    res.status(400).json({ error: "Invalid targetUserId format" });
    return;
  }
  if (teamId && !isValidUuid(teamId)) {
    res.status(400).json({ error: "Invalid teamId format" });
    return;
  }

  if (!Number.isInteger(amountCents) || amountCents! <= 0) {
    res.status(400).json({ error: "amountCents must be a positive integer" });
    return;
  }
  if (amountCents! > SAFE_MAX_CREDIT) {
    res.status(400).json({ error: `amountCents exceeds maximum of ${SAFE_MAX_CREDIT} ($${(SAFE_MAX_CREDIT / 100).toFixed(2)})` });
    return;
  }

  const auditReason = reasonOr400(req, res);
  if (auditReason === null) return;
  const sanitizedReason = sanitizeString(reason ?? auditReason, 200);

  try {
    if (targetUserId) {
      // Credit individual user wallet + audit row in one transaction
      const tx = await withAdminTx(adminId, async (c) => {
        const t = await walletRepo.creditWallet(
          targetUserId,
          amountCents!,
          "admin",
          `admin-credit-${Date.now()}`,
          sanitizedReason,
          pc(c),
        );
        await audit(c, req, "wallet_credit", "wallet", targetUserId, {
          reason: auditReason, amountCents, transactionId: t.id,
        });
        return t;
      });
      log.info("admin credited user wallet", {
        adminId,
        targetUserId,
        amountCents,
        reason: sanitizedReason,
        transactionId: tx.id,
      });
      res.json({
        message: "Wallet credited",
        transactionId: tx.id,
        amountCents,
        targetUserId,
      });
    } else {
      // Credit team wallet — admin must be a member of the team
      // For operator flexibility, we bypass the membership check since this is admin-only
      // and restricted to ADMIN_CREDIT_EMAILS
      await withAdminTx(adminId, async (c) => {
        await teamRepo.adminCreditTeamWallet(teamId!, amountCents!, sanitizedReason, pc(c));
        await audit(c, req, "team_wallet_credit", "team_wallet", teamId!, { reason: auditReason, amountCents });
      });
      log.info("admin credited team wallet", {
        adminId,
        teamId,
        amountCents,
        reason: sanitizedReason,
      });
      res.json({
        message: "Team wallet credited",
        amountCents,
        teamId,
      });
    }
  } catch (err) {
    if (sendHttpError(res, err)) return;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("No wallet found") || msg.includes("not found")) {
      res.status(404).json({ error: "Wallet not found for the specified target" });
      return;
    }
    if (msg.includes("exceed")) {
      res.status(400).json({ error: msg });
      return;
    }
    log.error("admin credit failed", { error: msg, adminId, targetUserId, teamId, amountCents });
    res.status(500).json({ error: "Failed to credit wallet" });
  }
});

// ─── Bug Bounty System ──────────────────────────────────────────────

const BUG_STATUSES = new Set(["pending", "approved", "rejected", "credited"]);
// Must match MAX_BALANCE_CENTS in shared wallet-repo
const BUG_BOUNTY_MAX_BALANCE_CENTS = 1_000_000;

// POST /api/admin/bug-reports/:id/approve — approve and optionally credit (cybersecurity_admin+)
router.post("/bug-reports/:id/approve", requireCybersecurityAdmin, async (req, res) => {
  if (!isValidUuid(req.params.id as string)) {
    res.status(400).json({ error: "Invalid report ID" });
    return;
  }

  const { userId: adminId } = (req as unknown as AuthenticatedRequest).user;

  const { creditAmountCents } = req.body as { creditAmountCents?: number };
  if (creditAmountCents !== undefined) {
    if (!Number.isInteger(creditAmountCents) || creditAmountCents <= 0 || creditAmountCents > SAFE_MAX_CREDIT) {
      res.status(400).json({ error: `creditAmountCents must be 1-${SAFE_MAX_CREDIT}` });
      return;
    }
  }

  const reason = reasonOr400(req, res);
  if (reason === null) return;

  const reportId = req.params.id as string;
  const amount = creditAmountCents ?? 0;
  const { getPool } = await import("@dominusnode/shared");
  const client = await getPool().connect();
  try {
    // Single transaction: lock report, guard status, credit wallet, mark credited.
    // Any failure rolls back so the report stays 'pending' and can be retried.
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const reportResult = await client.query(
      `SELECT id, user_id, status FROM bug_reports WHERE id = $1 FOR UPDATE`,
      [reportId],
    );
    if (reportResult.rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Bug report not found" });
      return;
    }
    const report = reportResult.rows[0] as { id: string; user_id: string; status: string };
    if (report.status !== "pending") {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Report is already ${report.status}` });
      return;
    }

    if (amount > 0) {
      const walletResult = await client.query(
        `SELECT id, balance_cents FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [report.user_id],
      );
      if (walletResult.rows.length === 0) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Reporter wallet not found" });
        return;
      }
      const wallet = walletResult.rows[0] as { id: string; balance_cents: number };
      if (Number(wallet.balance_cents) + amount > BUG_BOUNTY_MAX_BALANCE_CENTS) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Credit would exceed maximum wallet balance" });
        return;
      }
      await client.query(
        `UPDATE wallets SET balance_cents = balance_cents + $1, last_topped_up = now() WHERE id = $2`,
        [amount, wallet.id],
      );
      await client.query(
        `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description, payment_provider, payment_id)
         VALUES ($1, 'topup', $2, $3, 'bug_bounty', $4)`,
        [wallet.id, amount, `Bug bounty reward for report #${reportId.slice(0, 8)}`, `bug-${reportId}`],
      );
    }

    await client.query(
      `UPDATE bug_reports SET status = $1, reviewed_by = $2, reviewed_at = now(), credit_amount_cents = $3
       WHERE id = $4 AND status = 'pending'`,
      [amount > 0 ? "credited" : "approved", adminId, amount, reportId],
    );
    await audit(client as unknown as TxClient, req, "bug_report_approve", "bug_report", reportId, {
      reason, previousStatus: report.status, newStatus: amount > 0 ? "credited" : "approved",
      creditAmountCents: amount, reporterId: report.user_id,
    });
    await client.query("COMMIT");

    log.info("bug report approved", { reportId: req.params.id, creditAmountCents, adminId });
    res.json({ message: "Report approved", creditAmountCents: creditAmountCents ?? 0 });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    log.error("failed to approve bug report", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to approve bug report" });
  } finally {
    client.release();
  }
});

// POST /api/admin/bug-reports/:id/reject — reject a bug report (cybersecurity_admin+)
router.post("/bug-reports/:id/reject", requireCybersecurityAdmin, async (req, res) => {
  if (!isValidUuid(req.params.id as string)) {
    res.status(400).json({ error: "Invalid report ID" });
    return;
  }
  const reason = reasonOr400(req, res);
  if (reason === null) return;
  try {
    const { userId: adminId } = (req as unknown as AuthenticatedRequest).user;
    const reportId = req.params.id as string;
    const rejected = await withAdminTx(adminId, async (c) => {
      const r = await c.query<{ id: string }>(
        `UPDATE bug_reports SET status = 'rejected', reviewed_by = $1, reviewed_at = now() WHERE id = $2 AND status = 'pending' RETURNING id`,
        [adminId, reportId],
      );
      if (r.rows.length === 0) return false;
      await audit(c, req, "bug_report_reject", "bug_report", reportId, { reason, previousStatus: "pending", newStatus: "rejected" });
      return true;
    });
    if (!rejected) {
      res.status(404).json({ error: "Report not found or already processed" });
      return;
    }
    log.info("bug report rejected", { reportId: req.params.id, adminId });
    res.json({ message: "Report rejected" });
  } catch (err) {
    if (sendHttpError(res, err)) return;
    log.error("failed to reject bug report", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to reject bug report" });
  }
});

// GET /api/admin/bug-reports — list all bug reports (paginated)
router.get("/bug-reports", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const statusFilter = req.query.status ? sanitizeString(req.query.status as string, 20) : undefined;
    if (statusFilter && !BUG_STATUSES.has(statusFilter)) {
      res.status(400).json({ error: "Invalid status filter" });
      return;
    }

    const { query: dbQuery } = await import("@dominusnode/shared");
    const offset = (page - 1) * limit;
    const whereClause = statusFilter ? `WHERE status = $3` : "";
    const params = statusFilter ? [limit, offset, statusFilter] : [limit, offset];
    const result = await dbQuery(
      `SELECT id, user_id, category, priority, title, integration, status, credit_amount_cents, created_at, reviewed_at
       FROM bug_reports ${whereClause}
       ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      params,
    );
    const countResult = await dbQuery(
      `SELECT count(*) as total FROM bug_reports ${statusFilter ? "WHERE status = $1" : ""}`,
      statusFilter ? [statusFilter] : [],
    );
    const total = parseInt((countResult?.rows[0] as { total: string })?.total ?? "0", 10);

    res.json({
      reports: result?.rows ?? [],
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    log.error("failed to list bug reports", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to list bug reports" });
  }
});

// ─── Promo Code Management ──────────────────────────────────────────

const PROMO_CODE_REGEX = /^[A-Za-z0-9]{4,20}$/;

function hashPromoCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

// POST /api/admin/promo — create promo code
// Promo code creation restricted to cybersecurity_admin+ (promos mint credits)
router.post("/promo", requireCybersecurityAdmin, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { code, creditCents, maxUses, expiresAt } = req.body ?? {};

    if (!code || typeof code !== "string" || !PROMO_CODE_REGEX.test(code.trim())) {
      res.status(400).json({ error: "Invalid promo code format (4-20 alphanumeric characters)" });
      return;
    }
    const sanitizedCode = sanitizeString(code.trim().toUpperCase(), 20);
    const numCreditCents = Number(creditCents);
    if (!Number.isFinite(numCreditCents) || numCreditCents < 1 || numCreditCents > 100000) {
      res.status(400).json({ error: "creditCents must be 1-100000" });
      return;
    }
    const numMaxUses = typeof maxUses === "number" ? Math.min(Math.max(0, maxUses), 1000000) : 0;
    const expiresDate = expiresAt ? new Date(expiresAt) : undefined;
    if (expiresDate && isNaN(expiresDate.getTime())) {
      res.status(400).json({ error: "Invalid expiresAt date" });
      return;
    }

    const reason = reasonOr400(req, res);
    if (reason === null) return;

    const codeHash = hashPromoCode(sanitizedCode);
    const promo = await withAdminTx(authReq.user.userId, async (c) => {
      const p = await referralRepo.createPromoCode(
        authReq.user.userId,
        codeHash,
        sanitizedCode.slice(0, 4),
        numCreditCents,
        { maxUses: numMaxUses, expiresAt: expiresDate },
        pc(c),
      );
      // Never store the plaintext code in the audit trail — prefix only
      await audit(c, req, "promo_create", "promo_code", p.id, {
        reason, prefix: p.code_prefix, creditCents: numCreditCents, maxUses: numMaxUses,
        expiresAt: expiresDate ? expiresDate.toISOString() : null,
      });
      return p;
    });

    log.info("admin created promo code", { adminId: authReq.user.userId, promoId: promo.id });
    res.status(201).json({
      id: promo.id,
      code: sanitizedCode,
      prefix: promo.code_prefix,
      creditCents: promo.credit_cents,
      maxUses: promo.max_uses,
      expiresAt: promo.expires_at,
    });
  } catch (err) {
    if (sendHttpError(res, err)) return;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("duplicate")) {
      res.status(409).json({ error: "Promo code already exists" });
      return;
    }
    log.error("admin create promo failed", { error: msg });
    res.status(500).json({ error: "Failed to create promo code" });
  }
});

// GET /api/admin/promo — list all promo codes
router.get("/promo", async (_req, res) => {
  try {
    const promos = await referralRepo.listPromoCodes();
    res.json({
      promos: promos.map((p) => ({
        id: p.id,
        prefix: p.code_prefix,
        creditCents: p.credit_cents,
        maxUses: p.max_uses,
        uses: p.uses,
        active: p.active,
        expiresAt: p.expires_at,
        createdAt: p.created_at,
      })),
    });
  } catch (err) {
    log.error("admin list promos failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to list promo codes" });
  }
});

// DELETE /api/admin/promo/:id — disable promo code
router.delete("/promo/:id", async (req, res) => {
  try {
    const codeId = req.params.id ?? "";
    if (!isValidUuid(codeId)) {
      res.status(400).json({ error: "Invalid promo code ID" });
      return;
    }
    const reason = reasonOr400(req, res);
    if (reason === null) return;
    const { userId: adminUserId } = (req as unknown as AuthenticatedRequest).user;
    const disabled = await withAdminTx(adminUserId, async (c) => {
      const ok = await referralRepo.disablePromoCode(codeId, pc(c));
      if (ok) await audit(c, req, "promo_disable", "promo_code", codeId, { reason, previousActive: true, newActive: false });
      return ok;
    });
    if (!disabled) {
      res.status(404).json({ error: "Promo code not found or already disabled" });
      return;
    }
    log.info("admin disabled promo code", { promoId: codeId });
    res.json({ success: true });
  } catch (err) {
    if (sendHttpError(res, err)) return;
    log.error("admin disable promo failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to disable promo code" });
  }
});

// GET /api/admin/affiliates — affiliate system stats
router.get("/affiliates", async (_req, res) => {
  try {
    const { query: q } = await import("@dominusnode/shared");
    const [linksResult, commissionsResult, pendingResult] = await Promise.all([
      q<{ cnt: string }>("SELECT COUNT(*) AS cnt FROM affiliate_links"),
      q<{ total: string; cnt: string }>(
        "SELECT COALESCE(SUM(commission_cents), 0) AS total, COUNT(*) AS cnt FROM affiliate_commissions"
      ),
      q<{ total: string }>(
        "SELECT COALESCE(SUM(commission_cents), 0) AS total FROM affiliate_commissions WHERE status = 'pending'"
      ),
    ]);
    res.json({
      totalLinks: parseInt(linksResult.rows[0]?.cnt ?? "0", 10),
      totalCommissions: parseInt(commissionsResult.rows[0]?.cnt ?? "0", 10),
      totalCommissionCents: parseInt(commissionsResult.rows[0]?.total ?? "0", 10),
      pendingCommissionCents: parseInt(pendingResult.rows[0]?.total ?? "0", 10),
    });
  } catch (err) {
    log.error("admin affiliates stats failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to get affiliate stats" });
  }
});

// POST /api/admin/loyalty/process — trigger monthly loyalty calculation
const loyaltyProcessLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Loyalty processing limited to once per hour" },
});

router.post("/loyalty/process", requireReasonFirst, loyaltyProcessLimiter, async (req, res) => {
  const reason = res.locals.auditReason as string;
  try {
    const authReq = req as AuthenticatedRequest;
    // Calculate for previous month
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth(), 1);
    const period = periodStart.toISOString().slice(0, 7);

    // Batch job runs per-user transactions. Record (and re-check the admin)
    // before any money moves; a failure here means nothing was credited.
    await withAdminTx(authReq.user.userId, async (c) => {
      await audit(c, req, "loyalty_process_started", "loyalty", period, { reason });
    });

    // Get all active users with usage
    const { query: q } = await import("@dominusnode/shared");
    const usersResult = await q<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM usage_records
       WHERE created_at >= $1 AND created_at < $2`,
      [periodStart.toISOString(), periodEnd.toISOString()],
    );

    let processed = 0;
    let rewarded = 0;
    for (const row of usersResult.rows) {
      try {
        const reward = await referralRepo.calculateAndRecordMonthlyReward(
          row.user_id,
          periodStart,
          periodEnd,
        );
        processed++;
        if (reward) rewarded++;
      } catch {
        // Skip individual user errors
      }
    }

    // Credit pending rewards
    const credited = await referralRepo.creditPendingLoyaltyRewards();

    // Credits have committed: a failed completion row must not turn the
    // response into an error (an admin could re-run and pay out twice).
    try {
      await withAdminTx(authReq.user.userId, async (c) => {
        await audit(c, req, "loyalty_process", "loyalty", period, {
          reason, processed, rewarded, creditedCents: credited,
        });
      });
    } catch (auditErr) {
      log.error("loyalty run completed but completion audit row failed", {
        adminId: authReq.user.userId, processed, rewarded, creditedCents: credited,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }

    log.info("admin loyalty processing complete", {
      adminId: authReq.user.userId,
      processed,
      rewarded,
      creditedCents: credited,
    });
    res.json({ processed, rewarded, creditedCents: credited });
  } catch (err) {
    if (sendHttpError(res, err)) return;
    log.error("admin loyalty process failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to process loyalty rewards" });
  }
});

// POST /api/admin/commissions/process — trigger commission payouts for all users
const commissionProcessLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Commission processing limited to once per hour" },
});

router.post("/commissions/process", requireReasonFirst, commissionProcessLimiter, async (req, res) => {
  const reason = res.locals.auditReason as string;
  try {
    const authReq = req as AuthenticatedRequest;
    // Record (and re-check the admin) before any money moves.
    await withAdminTx(authReq.user.userId, async (c) => {
      await audit(c, req, "commissions_process_started", "affiliate_commissions", "batch", { reason });
    });
    const { query: q } = await import("@dominusnode/shared");

    // Get all referrers with pending commissions
    const referrersResult = await q<{ referrer_id: string }>(
      "SELECT DISTINCT referrer_id FROM affiliate_commissions WHERE status = 'pending'",
    );

    let processed = 0;
    let totalCredited = 0;
    for (const row of referrersResult.rows) {
      try {
        const amount = await referralRepo.creditPendingCommissions(row.referrer_id);
        processed++;
        totalCredited += amount;
      } catch {
        // Skip individual errors
      }
    }

    // Credits have committed: never report the run as failed afterwards.
    try {
      await withAdminTx(authReq.user.userId, async (c) => {
        await audit(c, req, "commissions_process", "affiliate_commissions", "batch", {
          reason, processed, totalCreditedCents: totalCredited,
        });
      });
    } catch (auditErr) {
      log.error("commission run completed but completion audit row failed", {
        adminId: authReq.user.userId, processed, totalCreditedCents: totalCredited,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }

    log.info("admin commission processing complete", {
      adminId: authReq.user.userId,
      processed,
      totalCreditedCents: totalCredited,
    });
    res.json({ processed, totalCreditedCents: totalCredited });
  } catch (err) {
    if (sendHttpError(res, err)) return;
    log.error("admin commission process failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to process commissions" });
  }
});

// ─── Admin Role Management (Root Admin Only) ───────────────────────

// GET /api/admin/roles — list all admin users with their roles
router.get("/roles", requireRootAdmin, async (_req, res) => {
  try {
    const result = await dbQuery(
      `SELECT id, email, admin_role, is_admin, status, created_at
       FROM users
       WHERE admin_role != 'none'
       ORDER BY
         CASE admin_role
           WHEN 'root_admin' THEN 1
           WHEN 'cybersecurity_admin' THEN 2
           WHEN 'admin' THEN 3
           ELSE 4
         END,
         created_at ASC`,
    );
    res.json({
      admins: (result?.rows ?? []).map((r: Record<string, unknown>) => ({
        id: r.id,
        email: r.email,
        adminRole: r.admin_role,
        status: r.status,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    log.error("failed to list admin roles", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to list admin roles" });
  }
});

// PUT /api/admin/roles/:userId — assign admin role to a user (root_admin only)
// Only root admin can promote/demote other users
// root_admin role cannot be assigned via API — it's hardcoded to one email
router.put("/roles/:userId", requireRootAdmin, async (req, res) => {
  const targetId = req.params.userId as string;
  if (!isValidUuid(targetId)) {
    res.status(400).json({ error: "Invalid user ID format" });
    return;
  }

  const { userId: adminId } = (req as unknown as AuthenticatedRequest).user;
  if (targetId === adminId) {
    res.status(400).json({ error: "Cannot change your own role" });
    return;
  }

  const { role } = req.body as { role?: string };
  if (!role || typeof role !== "string" || !VALID_ASSIGNABLE_ROLES.has(role)) {
    res.status(400).json({ error: "Invalid role. Must be: none, admin, or cybersecurity_admin" });
    return;
  }

  try {
    const targetUser = await userRepo.findUserById(targetId);
    if (!targetUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (targetUser.status !== "active") {
      res.status(400).json({ error: "Cannot assign roles to inactive accounts" });
      return;
    }

    const reason = reasonOr400(req, res);
    if (reason === null) return;

    const success = await withAdminTx(adminId, async (c) => {
      const ok = await adminRepo.setAdminRole(targetId, role, pc(c));
      if (ok) {
        await audit(c, req, "admin_role_set", "user", targetId, {
          reason, previousRole: targetUser.admin_role ?? "none", newRole: role,
        });
      }
      return ok;
    });
    if (!success) {
      res.status(400).json({ error: "Cannot modify this user's role" });
      return;
    }

    log.info("admin role changed", {
      adminId,
      targetUserId: targetId,
      targetEmail: targetUser.email.slice(0, 3) + "***",
      newRole: role,
      previousRole: targetUser.admin_role,
    });
    res.json({
      message: `Role updated to ${role}`,
      userId: targetId,
      role,
    });
  } catch (err) {
    if (sendHttpError(res, err)) return;
    log.error("failed to set admin role", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to update admin role" });
  }
});

export default router;
