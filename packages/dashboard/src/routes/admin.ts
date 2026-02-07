import { Router } from "express";
import { adminRepo, createLogger } from "@dominode/shared";
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
    await adminRepo.suspendUser(req.params.id);
    log.info("user suspended", { targetUserId: req.params.id });
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
  try {
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
    await adminRepo.deleteUser(req.params.id);
    log.info("user deleted (soft)", { targetUserId: req.params.id });
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

export default router;
