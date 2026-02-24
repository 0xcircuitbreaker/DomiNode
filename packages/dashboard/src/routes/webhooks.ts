import { Router, raw, json, type Request, type Response, type NextFunction } from "express";
import { createLogger } from "@dominusnode/shared";
import { handleCheckoutWebhook } from "@dominusnode/billing";
import { handleIpnCallback } from "@dominusnode/billing";
import { handlePaypalWebhook } from "@dominusnode/billing";

const router = Router();
const log = createLogger("api:webhooks");

// ─── Webhook IP Allowlisting ───────────────────────────────────────
// Stripe webhook source IPs: https://docs.stripe.com/ips#webhook-ip-addresses
const STRIPE_WEBHOOK_IPS = new Set([
  "3.18.12.63", "3.130.192.231", "13.235.14.237", "13.235.122.149",
  "18.211.135.69", "35.154.171.200", "52.15.183.38", "54.88.130.119",
  "54.88.130.237", "54.187.174.169", "54.187.205.235", "54.187.216.72",
]);

// NOWPayments IPN source IPs (optional — IPN signature verification is primary security)
const NOWPAYMENTS_IPS = new Set<string>([
  // NOWPayments does not publish a fixed IP list.
  // When NOWPAYMENTS_WEBHOOK_IPS env var is set, those IPs are used.
  // If empty, IP check is skipped and IPN HMAC signature is the sole verification.
]);

// Load additional IPs from env (comma-separated)
const envStripeIps = process.env["STRIPE_WEBHOOK_IPS"];
if (envStripeIps) {
  for (const ip of envStripeIps.split(",")) STRIPE_WEBHOOK_IPS.add(ip.trim());
}
const envNowpaymentsIps = process.env["NOWPAYMENTS_WEBHOOK_IPS"];
if (envNowpaymentsIps) {
  for (const ip of envNowpaymentsIps.split(",")) NOWPAYMENTS_IPS.add(ip.trim());
} else if (process.env["NOWPAYMENTS_API_KEY"]) {
  // Warn if NOWPayments is configured but no webhook IP allowlist is set (R12 H-2)
  log.warn("NOWPAYMENTS_WEBHOOK_IPS not set — webhook IP allowlisting is disabled. Set this in production.");
}

// R45 H-2: Normalize IPv6-mapped/compatible addresses to IPv4 for allowlist matching
function normalizeWebhookIp(rawIp: string): string {
  let ip = rawIp.trim();
  // Strip ::ffff: (IPv4-mapped IPv6)
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }
  // Strip :: prefix (IPv4-compatible IPv6, e.g. ::10.0.0.1)
  else if (ip.startsWith("::") && ip.includes(".")) {
    ip = ip.slice(2);
  }
  // Strip IPv6 zone ID (%eth0 etc.)
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) {
    ip = ip.slice(0, zoneIdx);
  }
  return ip;
}

export function webhookIpCheck(allowedIps: Set<string>, providerName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // If no IPs configured, skip IP check (rely on signature verification instead)
    if (allowedIps.size === 0) {
      next();
      return;
    }
    const ip = normalizeWebhookIp(req.ip ?? req.socket.remoteAddress ?? "");
    if (!allowedIps.has(ip)) {
      log.warn(`${providerName} webhook from unauthorized IP`, { ip });
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

// POST /api/webhooks/stripe — raw body for signature verification
router.post("/stripe", webhookIpCheck(STRIPE_WEBHOOK_IPS, "stripe"), raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
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
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("stripe webhook error", { error: errMsg });
    // R45 H-4: Only return 500 for transient DB errors (Stripe retries on 500).
    // For permanent errors (balance cap exceeded, wallet not found), return 200
    // to prevent infinite retry loops that would never succeed.
    // R46 H-5: Balance cap errors are retryable (user might spend down balance)
    const isTransient = errMsg.includes("connection") || errMsg.includes("timeout")
      || errMsg.includes("ECONNREFUSED") || errMsg.includes("lock")
      || errMsg.includes("exceed maximum wallet balance");
    if (isTransient) {
      res.status(500).json({ error: "Transient processing error, retry later" });
    } else {
      res.json({ received: true, error: "Permanent processing failure logged" });
    }
  }
});

// POST /api/webhooks/nowpayments
router.post("/nowpayments", webhookIpCheck(NOWPAYMENTS_IPS, "nowpayments"), json({ limit: "16kb" }), async (req, res) => {
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
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("nowpayments webhook error", { error: errMsg });
    // R45 H-4: Only return 500 for transient DB errors (NOWPayments retries on 500).
    // R46 H-5: Balance cap errors are retryable (user might spend down balance)
    const isTransient = errMsg.includes("connection") || errMsg.includes("timeout")
      || errMsg.includes("ECONNREFUSED") || errMsg.includes("lock")
      || errMsg.includes("exceed maximum wallet balance");
    if (isTransient) {
      res.status(500).json({ error: "Transient processing error, retry later" });
    } else {
      res.json({ received: true, error: "Permanent processing failure logged" });
    }
  }
});

// PayPal webhook source IPs (PayPal does not publish a fixed list;
// webhook signature verification is the primary security mechanism).
// Set PAYPAL_WEBHOOK_IPS env var in production if you want IP-layer filtering.
const PAYPAL_WEBHOOK_IPS = new Set<string>();
const envPaypalIps = process.env["PAYPAL_WEBHOOK_IPS"];
if (envPaypalIps) {
  for (const ip of envPaypalIps.split(",")) PAYPAL_WEBHOOK_IPS.add(ip.trim());
} else if (process.env["PAYPAL_CLIENT_ID"]) {
  log.warn("PAYPAL_WEBHOOK_IPS not set — webhook IP allowlisting is disabled. Set this in production.");
}

// POST /api/webhooks/paypal — raw body for signature verification
router.post("/paypal", webhookIpCheck(PAYPAL_WEBHOOK_IPS, "paypal"), raw({ type: "application/json", limit: "64kb" }), async (req, res) => {
  try {
    const rawBody = (req.body as Buffer).toString("utf-8");

    // Collect PayPal signature headers
    const paypalHeaders: Record<string, string> = {};
    for (const key of [
      "paypal-transmission-id",
      "paypal-transmission-time",
      "paypal-transmission-sig",
      "paypal-cert-url",
      "paypal-auth-algo",
    ]) {
      const val = req.headers[key];
      if (typeof val === "string") {
        paypalHeaders[key] = val;
      }
    }

    if (!paypalHeaders["paypal-transmission-sig"]) {
      res.status(400).json({ error: "Missing PayPal signature headers" });
      return;
    }

    const result = await handlePaypalWebhook(paypalHeaders, rawBody);

    if (result) {
      log.info("paypal webhook processed", result);
    }

    res.json({ received: true });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("paypal webhook error", { error: errMsg });
    // R45 H-4: Only return 500 for transient DB errors (PayPal retries on 500).
    // R46 H-5: Balance cap errors are retryable (user might spend down balance)
    const isTransient = errMsg.includes("connection") || errMsg.includes("timeout")
      || errMsg.includes("ECONNREFUSED") || errMsg.includes("lock")
      || errMsg.includes("exceed maximum wallet balance");
    if (isTransient) {
      res.status(500).json({ error: "Transient processing error, retry later" });
    } else {
      res.json({ received: true, error: "Permanent processing failure logged" });
    }
  }
});

export default router;
