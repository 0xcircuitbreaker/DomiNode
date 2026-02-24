import { Router } from "express";
import { adminRepo, createLogger, userRepo, refreshTokenRepo, waitlistRepo, sendWaitlistApprovalEmail, sanitizeString } from "@dominusnode/shared";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";

const router = Router();
const log = createLogger("api:admin");

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

// All admin routes require auth + admin
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
  try {
    // Prevent admin-to-admin attacks
    const targetUser = await userRepo.findUserById(req.params.id);
    if (targetUser?.is_admin) {
      res.status(403).json({ error: "Cannot suspend another admin account" });
      return;
    }
    await adminRepo.suspendUser(req.params.id);
    // Revoke all API keys and refresh tokens so the suspended user is immediately locked out
    const [revokedKeys, revokedTokens] = await Promise.all([
      userRepo.revokeAllApiKeys(req.params.id),
      refreshTokenRepo.revokeAllForUser(req.params.id),
    ]);
    // Signal proxy-gateway to terminate active sessions for this user
    let terminatedSessions = 0;
    try {
      const proxyHost = process.env["PROXY_INTERNAL_HOST"] ?? "127.0.0.1";
      const proxyPort = process.env["PROXY_INTERNAL_PORT"] ?? process.env["PROXY_LISTEN_PORT"] ?? "8080";
      // R18-H4: Derive a separate stats secret from JWT_SECRET using HMAC
      const proxySecret = process.env["PROXY_STATS_SECRET"] ??
        (process.env["JWT_SECRET"]
          ? (await import("node:crypto")).createHmac("sha256", process.env["JWT_SECRET"]).update("proxy-stats-endpoint").digest("hex")
          : "");
      const headers: Record<string, string> = { "Content-Length": "0" };
      if (proxySecret) headers["Authorization"] = `Bearer ${proxySecret}`;
      const resp = await fetch(`http://${proxyHost}:${proxyPort}/internal/terminate-sessions/${req.params.id}`, {
        method: "POST",
        headers,
        redirect: "error", // R19 H-5: Prevent SSRF via redirect
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
  try {
    // R46 H-3: Prevent reactivating deleted or already-active users
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
    // Prevent admin-to-admin attacks
    if (targetUser.is_admin) {
      res.status(403).json({ error: "Cannot reactivate another admin account" });
      return;
    }
    await adminRepo.reactivateUser(req.params.id);
    log.info("user reactivated", { targetUserId: req.params.id });
    res.json({ message: "User reactivated" });
  } catch (err) {
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
  try {
    // Prevent admin-to-admin attacks
    const targetUser = await userRepo.findUserById(req.params.id);
    if (targetUser?.is_admin) {
      res.status(403).json({ error: "Cannot delete another admin account" });
      return;
    }
    // R41 C-1: API key/refresh token/MFA revocation moved inside adminRepo.deleteUser() transaction
    // to eliminate race window between separate non-transactional calls and deleteUser().
    // R19 H-3: Terminate active proxy sessions before deleting user (same as suspend)
    let terminatedSessions = 0;
    try {
      const proxyHost = process.env["PROXY_INTERNAL_HOST"] ?? "127.0.0.1";
      const proxyPort = process.env["PROXY_INTERNAL_PORT"] ?? process.env["PROXY_LISTEN_PORT"] ?? "8080";
      const proxySecret = process.env["PROXY_STATS_SECRET"] ??
        (process.env["JWT_SECRET"]
          ? (await import("node:crypto")).createHmac("sha256", process.env["JWT_SECRET"]).update("proxy-stats-endpoint").digest("hex")
          : "");
      const headers: Record<string, string> = { "Content-Length": "0" };
      if (proxySecret) headers["Authorization"] = `Bearer ${proxySecret}`;
      const resp = await fetch(`http://${proxyHost}:${proxyPort}/internal/terminate-sessions/${req.params.id}`, {
        method: "POST",
        headers,
        redirect: "error", // R19 H-5: Prevent SSRF via redirect
      });
      if (resp.ok) {
        const body = await resp.json() as { terminated: number };
        terminatedSessions = body.terminated;
      }
    } catch {
      log.warn("could not signal proxy-gateway to terminate sessions", { targetUserId: req.params.id });
    }
    await adminRepo.deleteUser(req.params.id);
    log.info("user deleted (soft)", { targetUserId: req.params.id, terminatedSessions });
    res.json({ message: "User deleted" });
  } catch (err) {
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

    const marked = await waitlistRepo.markNotified(req.params.id);
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
    log.error("failed to approve waitlist entry", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to approve waitlist entry" });
  }
});

// POST /api/admin/waitlist/bulk-approve — approve N oldest pending entries
router.post("/waitlist/bulk-approve", async (req, res) => {
  try {
    const count = Math.min(100, Math.max(1, parseInt(req.body.count ?? "10", 10) || 10));

    const pendingEntries = await waitlistRepo.getPendingEmails(count);
    if (pendingEntries.length === 0) {
      res.json({ approved: 0, message: "No pending entries to approve" });
      return;
    }

    const ids = pendingEntries.map((e) => e.id);
    const approved = await waitlistRepo.bulkNotify(ids);

    // Send approval emails (non-blocking, best-effort)
    for (const entry of pendingEntries) {
      sendWaitlistApprovalEmail(entry.email).catch((err) => {
        log.error("failed to send bulk approval email", { email: entry.email.slice(0, 3) + "***", error: err instanceof Error ? err.message : String(err) });
      });
    }

    log.info("bulk waitlist approval", { approved, requested: count });
    res.json({ approved, message: `${approved} entries approved and notified` });
  } catch (err) {
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
  try {
    const cancelled = await waitlistRepo.cancelEntry(req.params.id);
    if (!cancelled) {
      res.status(404).json({ error: "Entry not found or already processed" });
      return;
    }
    log.info("waitlist entry cancelled", { entryId: req.params.id });
    res.json({ message: "Entry cancelled" });
  } catch (err) {
    log.error("failed to cancel waitlist entry", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to cancel waitlist entry" });
  }
});

export default router;
