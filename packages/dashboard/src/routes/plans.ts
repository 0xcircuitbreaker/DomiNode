import { Router } from "express";
import { planRepo, createLogger } from "@dominode/shared";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

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

    // Verify plan exists
    const plan = await planRepo.getPlan(planId);
    if (!plan) {
      res.status(404).json({ error: `Plan '${planId}' not found` });
      return;
    }

    await planRepo.setUserPlan(userId, planId);

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
      },
    });
  } catch (err) {
    log.error("user plan change failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to update plan" });
  }
});

export default router;
