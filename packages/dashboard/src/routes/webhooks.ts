import { Router, raw, json } from "express";
import { createLogger } from "@dominode/shared";
import { handleCheckoutWebhook } from "@dominode/billing";
import { handleIpnCallback } from "@dominode/billing";

const router = Router();
const log = createLogger("api:webhooks");

// POST /api/webhooks/stripe — raw body for signature verification
router.post("/stripe", raw({ type: "application/json" }), async (req, res) => {
  try {
    const signature = req.headers["stripe-signature"] as string;
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature header" });
      return;
    }

    const result = await handleCheckoutWebhook(req.body as Buffer, signature);

    if (result) {
      log.info("stripe webhook processed", result);
    }

    res.json({ received: true });
  } catch (err) {
    log.error("stripe webhook error", { error: err instanceof Error ? err.message : String(err) });
    // Return 500 for transient errors so Stripe retries
    res.status(500).json({ error: "Internal webhook processing error" });
  }
});

// POST /api/webhooks/nowpayments
router.post("/nowpayments", json(), async (req, res) => {
  try {
    const signature = req.headers["x-nowpayments-sig"] as string;
    if (!signature) {
      res.status(400).json({ error: "Missing x-nowpayments-sig header" });
      return;
    }

    const result = await handleIpnCallback(
      req.body as Record<string, unknown>,
      signature,
    );

    if (result) {
      log.info("nowpayments IPN processed", result);
    }

    res.json({ received: true });
  } catch (err) {
    log.error("nowpayments webhook error", { error: err instanceof Error ? err.message : String(err) });
    // Return 500 for transient errors so the provider retries
    res.status(500).json({ error: "Internal webhook processing error" });
  }
});

export default router;
