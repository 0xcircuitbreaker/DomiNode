import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { getOpsAlerter } from "../ops-alerts.js";
import { HttpError, fail, withAdminTx, audit, adminId, requireReason } from "./admin-network-common.js";

/**
 * Operator alerting admin endpoints (ADMIN_API.md §16). Mounted at
 * /api/admin/ops-alerts. Webhook URLs are never returned (Slack/Discord paths
 * are secrets); only kind and hostname.
 */
const router = Router();
router.use(requireAuth, requireAdmin);

function alerter() {
  const a = getOpsAlerter();
  if (!a) throw new HttpError(503, "Ops alerting is not running");
  return a;
}

router.get("/", (req: Request, res: Response) => {
  try {
    const a = alerter();
    const raw = typeof req.query["limit"] === "string" ? req.query["limit"] : "50";
    const limit = /^\d{1,3}$/.test(raw) ? Math.min(Math.max(parseInt(raw, 10), 1), 200) : 50;
    const c = a.config;
    res.json({
      webhooks: c.webhooks.map((h) => ({ kind: h.kind, host: h.url.hostname })),
      thresholds: {
        intervalSec: c.intervalSec, gatewayStaleSec: c.gatewayStaleSec, minLiveNodes: c.minLiveNodes,
        nodeDropPct: c.nodeDropPct, paymentFailures: c.paymentFailures, debitSpikeCents: c.debitSpikeCents,
        debitSpikeFactor: c.debitSpikeFactor, v1ErrorPct: c.v1ErrorPct, v1MinRequests: c.v1MinRequests,
        dedupeSec: c.dedupeSec, maxPerHour: c.maxPerHour,
      },
      firing: a.firingRules(),
      alerts: a.recentAlerts(limit),
    });
  } catch (err) {
    fail(res, err, "List ops alerts");
  }
});

router.post("/test", async (req: Request, res: Response) => {
  try {
    const a = alerter();
    const reason = requireReason(req);
    const sent = await a.sendTest();
    await withAdminTx(adminId(req), (c) => audit(c, req, "ops_alert_test", "ops_alert", "test", {
      reason, delivered: sent.delivered, webhooks: a.config.webhooks.length, suppressed: sent.suppressed,
    }));
    res.json({ alert: sent, webhooks: a.config.webhooks.length });
  } catch (err) {
    fail(res, err, "Send test alert");
  }
});

export default router;
