import { Router } from "express";
import { planRepo, walletRepo, createLogger, getPool } from "@dominode/shared";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

// Plans that users are allowed to self-select
const USER_SELECTABLE_PLANS = new Set(["free", "payg", "vol100", "vol1tb"]);

// Minimum wallet balance required (in cents) to switch to volume plans
const VOLUME_PLAN_MIN_BALANCE: Record<string, number> = {
  vol100: 1000, // $10 minimum for $4/GB plan
  vol1tb: 5000, // $50 minimum for $3/GB plan
};

const router = Router();
const log = createLogger("api:plans");

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
router.put("/user/plan", requireAuth, async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;
    const { planId } = req.body;

    if (!planId || typeof planId !== "string") {
      res.status(400).json({ error: "planId is required" });
      return;
    }

    // Restrict to user-selectable plans (prevents switching to free/admin-only plans)
    if (!USER_SELECTABLE_PLANS.has(planId)) {
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
        await client.query(
          "INSERT INTO user_plans (user_id, plan_id) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET plan_id = $2, updated_at = now()",
          [userId, planId],
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
      },
    });
  } catch (err) {
    log.error("user plan change failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to update plan" });
  }
});

export default router;
