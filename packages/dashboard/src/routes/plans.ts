import { Router, type Request } from "express";
import { planRepo, walletRepo, userRepo, createLogger, getPool } from "@dominusnode/shared";
import { agentAwareRateLimit, isVerifiedAgent } from "../helpers/agent-rate-limit.js";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

// Plans that users are allowed to self-select
const USER_SELECTABLE_PLANS = new Set(["free", "free-dc", "free-res", "payg", "vol100", "vol1tb"]);
// Plans only selectable by MCP agents (identified by X-DominusNode-Agent: mcp header)
const AGENT_ONLY_PLANS = new Set(["agent"]);

// Minimum wallet balance required (in cents) to switch to volume plans
const VOLUME_PLAN_MIN_BALANCE: Record<string, number> = {
  vol100: 1000, // $10 minimum for $4/GB plan
  vol1tb: 5000, // $50 minimum for $3/GB plan
};

const router = Router();
const log = createLogger("api:plans");

// Rate limit plan change requests to prevent abuse (agents get boosted)
const planChangeLimiter = agentAwareRateLimit({
  windowMs: 60_000,
  max: 10,
  keyGenerator: (req: Request) => (req as any).user?.userId ?? req.ip ?? "unknown",
  message: { error: "Too many plan change requests. Try again later." },
  validate: false,
});

// GET /api/plans — list all available plans (public)
router.get("/", async (_req, res) => {
  try {
    const plans = await planRepo.getAllPlans();
    res.json({
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        pricePerGbCents: p.pricePerGbCents,
        pricePerGbUsd: Number((p.pricePerGbCents / 100).toFixed(2)),
        monthlyBandwidthBytes: p.monthlyBandwidthBytes,
        monthlyBandwidthGB: p.monthlyBandwidthBytes > 0
          ? Number((p.monthlyBandwidthBytes / 1_073_741_824).toFixed(2))
          : null,
        isDefault: p.isDefault,
        maxConnections: p.maxConnections,
        allowedProxyTypes: p.allowedProxyTypes,
      })),
    });
  } catch (err) {
    log.error("plans fetch failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to fetch plans" });
  }
});

// GET /api/user/plan — get current user's plan + monthly usage (auth required)
router.get("/user/plan", requireAuth, async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;
    const [plan, monthlyUsageBytes] = await Promise.all([
      planRepo.getUserPlan(userId),
      planRepo.getMonthlyUsage(userId),
    ]);

    res.json({
      plan: {
        id: plan.id,
        name: plan.name,
        pricePerGbCents: plan.pricePerGbCents,
        pricePerGbUsd: Number((plan.pricePerGbCents / 100).toFixed(2)),
        monthlyBandwidthBytes: plan.monthlyBandwidthBytes,
        monthlyBandwidthGB: plan.monthlyBandwidthBytes > 0
          ? Number((plan.monthlyBandwidthBytes / 1_073_741_824).toFixed(2))
          : null,
        isDefault: plan.isDefault,
        maxConnections: plan.maxConnections,
        allowedProxyTypes: plan.allowedProxyTypes,
      },
      usage: {
        monthlyUsageBytes,
        monthlyUsageGB: Number((monthlyUsageBytes / 1_073_741_824).toFixed(4)),
        limitBytes: plan.monthlyBandwidthBytes,
        limitGB: plan.monthlyBandwidthBytes > 0
          ? Number((plan.monthlyBandwidthBytes / 1_073_741_824).toFixed(2))
          : null,
        percentUsed: plan.monthlyBandwidthBytes > 0
          ? Number(((monthlyUsageBytes / plan.monthlyBandwidthBytes) * 100).toFixed(1))
          : null,
      },
    });
  } catch (err) {
    log.error("user plan fetch failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to fetch user plan" });
  }
});

// PUT /api/user/plan — change user's plan (auth required)
router.put("/user/plan", requireAuth, planChangeLimiter, async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;
    const { planId } = req.body;

    // Require verified email before changing plans (matches other financial endpoints)
    const planUser = await userRepo.findUserById(userId);
    if (!planUser || !planUser.email_verified) {
      res.status(403).json({ error: "Please verify your email address before changing plans" });
      return;
    }

    if (!planId || typeof planId !== "string") {
      res.status(400).json({ error: "planId is required" });
      return;
    }

    // Restrict to user-selectable plans (prevents switching to free/admin-only plans)
    // MCP agents (X-DominusNode-Agent: mcp + verified secret) can additionally select agent-only plans
    const isMcpAgent = isVerifiedAgent(req);
    const isAllowed = USER_SELECTABLE_PLANS.has(planId) || (isMcpAgent && AGENT_ONLY_PLANS.has(planId));
    if (!isAllowed) {
      res.status(403).json({ error: "This plan cannot be selected. Contact support for assistance." });
      return;
    }

    // Verify plan exists
    const plan = await planRepo.getPlan(planId);
    if (!plan) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }

    // Volume plans require minimum wallet balance — use atomic transaction with FOR UPDATE
    // to prevent TOCTOU race between balance check and plan update
    const minBalance = VOLUME_PLAN_MIN_BALANCE[planId];
    if (minBalance) {
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const walletResult = await client.query(
          "SELECT balance_cents FROM wallets WHERE user_id = $1 FOR UPDATE",
          [userId],
        );
        const wallet = walletResult.rows[0];
        if (!wallet || wallet.balance_cents < minBalance) {
          await client.query("ROLLBACK");
          res.status(402).json({
            error: `Minimum wallet balance of $${(minBalance / 100).toFixed(2)} required for ${plan.name} plan`,
          });
          return;
        }
        // Use users.plan_id column (user_plans table does not exist)
        await client.query(
          "UPDATE users SET plan_id = $1 WHERE id = $2",
          [planId, userId],
        );
        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK").catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
    } else {
      await planRepo.setUserPlan(userId, planId);
    }

    log.info("user plan changed", { userId, planId });

    // Terminate active sessions on ANY plan change to prevent stale pricing
    // Sessions lock pricePerGbCents at start — any plan change leaves active sessions
    // running with stale pricing (upgrade: free sessions keep $0, downgrade: paid sessions keep old limits)
    try {
      const proxyHost = process.env["PROXY_INTERNAL_HOST"] ?? "127.0.0.1";
      const proxyPort = process.env["PROXY_LISTEN_PORT"] ?? "8080";
      const jwtSecret = process.env["JWT_SECRET"] ?? "";
      if (jwtSecret) {
        const crypto = await import("node:crypto");
        const statsSecret = crypto.createHmac("sha256", jwtSecret).update("proxy-stats-endpoint").digest("hex");
        await fetch(`http://${proxyHost}:${proxyPort}/internal/terminate-sessions/${userId}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${statsSecret}`, "Content-Length": "0" },
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
      }
    } catch {
      // Best effort — sessions will eventually expire via stale cleanup
      log.warn("failed to terminate sessions on plan change", { userId, planId });
    }

    res.json({
      message: "Plan updated successfully",
      plan: {
        id: plan.id,
        name: plan.name,
        pricePerGbCents: plan.pricePerGbCents,
        pricePerGbUsd: Number((plan.pricePerGbCents / 100).toFixed(2)),
        monthlyBandwidthBytes: plan.monthlyBandwidthBytes,
        monthlyBandwidthGB: plan.monthlyBandwidthBytes > 0
          ? Number((plan.monthlyBandwidthBytes / 1_073_741_824).toFixed(2))
          : null,
        isDefault: plan.isDefault,
        maxConnections: plan.maxConnections,
        allowedProxyTypes: plan.allowedProxyTypes,
      },
    });
  } catch (err) {
    log.error("user plan change failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to update plan" });
  }
});

export default router;
