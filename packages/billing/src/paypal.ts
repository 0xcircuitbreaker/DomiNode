import { randomUUID } from "node:crypto";
import { walletRepo, invoiceRepo, createLogger } from "@dominusnode/shared";

const log = createLogger("billing:paypal");

// R46 H-4: Prototype pollution protection
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function stripDangerousKeys(obj: Record<string, unknown>, depth = 0): void {
  if (depth > 5) return;
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) {
      delete obj[key];
    } else if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
      stripDangerousKeys(obj[key] as Record<string, unknown>, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

function getClientId(): string {
  const id = process.env["PAYPAL_CLIENT_ID"];
  if (!id) throw new Error("PAYPAL_CLIENT_ID is required");
  return id;
}

function getClientSecret(): string {
  const secret = process.env["PAYPAL_CLIENT_SECRET"];
  if (!secret) throw new Error("PAYPAL_CLIENT_SECRET is required");
  return secret;
}

function getWebhookId(): string {
  const id = process.env["PAYPAL_WEBHOOK_ID"];
  if (!id) throw new Error("PAYPAL_WEBHOOK_ID is required");
  return id;
}

function getApiBase(): string {
  const env = (process.env["PAYPAL_ENVIRONMENT"] ?? "sandbox").toLowerCase();
  return env === "production"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function validateRedirectUrl(envVar: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${envVar} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${envVar} must use http or https protocol: ${url}`);
  }
  const allowedOrigins = (process.env["CORS_ORIGINS"] ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim());
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new Error(`${envVar} origin ${parsed.origin} is not in CORS_ORIGINS (${allowedOrigins.join(", ")})`);
  }
}

const PAYPAL_RETURN_URL = process.env["PAYPAL_RETURN_URL"] ?? "http://localhost:5173/wallet?topup=success&provider=paypal";
const PAYPAL_CANCEL_URL = process.env["PAYPAL_CANCEL_URL"] ?? "http://localhost:5173/wallet?topup=cancel&provider=paypal";

let redirectUrlsValidated = false;

// ---------------------------------------------------------------------------
// OAuth2 access token (cached with expiry)
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const base = getApiBase();

  const resp = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });

  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(`PayPal OAuth token request failed: ${resp.status}`);
  }

  const text = await resp.text();
  if (text.length > 65_536) throw new Error("PayPal OAuth response too large");

  const data = JSON.parse(text) as { access_token: string; expires_in: number };
  if (!data.access_token) throw new Error("PayPal OAuth response missing access_token");

  cachedToken = data.access_token;
  // Expire 60s early to avoid edge cases; cap at 1 hour max
  const expiresIn = Math.min(Math.max(data.expires_in ?? 0, 0), 3600);
  tokenExpiresAt = Date.now() + Math.max(expiresIn - 60, 0) * 1000;

  return cachedToken;
}

// ---------------------------------------------------------------------------
// Create PayPal Order
// ---------------------------------------------------------------------------

export interface PaypalOrder {
  orderId: string;
  approvalUrl: string;
  amountCents: number;
}

export async function createPaypalOrder(
  userId: string,
  amountCents: number,
): Promise<PaypalOrder> {
  // Defense-in-depth validation
  if (!Number.isInteger(amountCents) || amountCents < 500 || amountCents > 100_000) {
    throw new Error("Invalid top-up amount: must be integer between 500 and 100000 cents");
  }

  // Validate redirect URLs on first use
  if (!redirectUrlsValidated) {
    validateRedirectUrl("PAYPAL_RETURN_URL", PAYPAL_RETURN_URL);
    validateRedirectUrl("PAYPAL_CANCEL_URL", PAYPAL_CANCEL_URL);
    redirectUrlsValidated = true;
  }

  const token = await getAccessToken();
  const base = getApiBase();
  const amountUsd = (amountCents / 100).toFixed(2);

  const resp = await fetch(`${base}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "PayPal-Request-Id": `topup_${userId}_${randomUUID()}`,
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "USD",
            value: amountUsd,
          },
          description: `Dominus Node Wallet Top-Up $${amountUsd}`,
          custom_id: userId,
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: PAYPAL_RETURN_URL,
            cancel_url: PAYPAL_CANCEL_URL,
            user_action: "PAY_NOW",
            brand_name: "Dominus Node",
          },
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    log.error("PayPal create order failed", { status: resp.status, body: errText.slice(0, 500) });
    await resp.body?.cancel().catch(() => {});
    throw new Error(`PayPal create order failed: ${resp.status}`);
  }

  const text = await resp.text();
  if (text.length > 1_048_576) throw new Error("PayPal response too large");

  const data = JSON.parse(text) as {
    id: string;
    links: Array<{ rel: string; href: string }>;
  };

  if (!data.id) throw new Error("PayPal response missing order ID");

  const approvalLink = data.links?.find((l) => l.rel === "payer-action");
  const approvalUrl = approvalLink?.href ?? "";

  // Validate approval URL is a PayPal domain (prevent redirect hijacking)
  if (approvalUrl) {
    try {
      const approvalParsed = new URL(approvalUrl);
      if (approvalParsed.protocol !== "https:") {
        throw new Error("PayPal approval URL must use HTTPS");
      }
      const host = approvalParsed.hostname.toLowerCase();
      if (!host.endsWith(".paypal.com") && host !== "paypal.com") {
        throw new Error(`PayPal approval URL has unexpected hostname: ${host}`);
      }
    } catch (urlErr) {
      if (urlErr instanceof Error && urlErr.message.includes("PayPal")) throw urlErr;
      throw new Error("PayPal approval URL is not a valid URL");
    }
  }

  // Store invoice
  await invoiceRepo.createInvoice(userId, "paypal", data.id, amountCents);

  log.info("PayPal order created", { userId, amountCents, orderId: data.id });

  return {
    orderId: data.id,
    approvalUrl,
    amountCents,
  };
}

// ---------------------------------------------------------------------------
// Capture PayPal Order (after user approves)
// ---------------------------------------------------------------------------

// R45 H-3: PayPal order IDs are alphanumeric (uppercase + digits), max 50 chars.
// Validate to prevent injection into URL construction.
const PAYPAL_ORDER_ID_RE = /^[A-Z0-9]{5,50}$/;

export async function capturePaypalOrder(
  orderId: string,
  userId: string,
): Promise<{ userId: string; amountCents: number } | null> {
  if (!orderId || typeof orderId !== "string") {
    throw new Error("orderId is required");
  }
  if (!PAYPAL_ORDER_ID_RE.test(orderId)) {
    throw new Error("Invalid PayPal order ID format");
  }

  // Look up the stored invoice first
  const invoice = await invoiceRepo.findInvoice("paypal", orderId);
  if (!invoice) {
    log.error("no matching invoice found for PayPal order", { orderId });
    return null;
  }

  // Verify the requesting user owns this invoice
  if (invoice.user_id !== userId) {
    log.error("PayPal order user mismatch", { orderId, invoiceUserId: invoice.user_id, requestUserId: userId });
    return null;
  }

  if (invoice.status === "completed") {
    log.info("PayPal order already captured", { orderId });
    return { userId: invoice.user_id, amountCents: invoice.amount_cents };
  }

  if (invoice.status === "failed") {
    log.warn("PayPal order previously failed", { orderId });
    return null;
  }

  const token = await getAccessToken();
  const base = getApiBase();

  const resp = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: "{}",
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    log.error("PayPal capture failed", { orderId, status: resp.status, body: errText.slice(0, 500) });
    // R46 C-1: Only permanently fail invoice on definitive PayPal rejection (4xx client errors).
    // Leave 5xx/timeout as pending — the webhook may still arrive and complete it.
    // markCreditFailed only transitions completed→failed; failInvoice transitions pending→failed.
    if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
      try { await invoiceRepo.failInvoice(invoice.id); } catch { /* best effort */ }
    }
    return null;
  }

  const text = await resp.text();
  if (text.length > 1_048_576) throw new Error("PayPal capture response too large");

  const data = JSON.parse(text) as {
    id: string;
    status: string;
    purchase_units: Array<{
      payments?: {
        captures?: Array<{
          amount?: { value: string; currency_code: string };
          status: string;
        }>;
      };
    }>;
  };

  if (data.status !== "COMPLETED") {
    log.warn("PayPal order not completed after capture", { orderId, status: data.status });
    return null;
  }

  // Verify captured amount matches invoice
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture || !capture.amount?.value) {
    log.error("PayPal capture response missing amount", { orderId });
    return null;
  }
  const capturedCents = Math.round(parseFloat(capture.amount.value) * 100);
  // R46 C-2: NaN check — parseFloat("abc") = NaN, Math.round(NaN) = NaN, NaN > 1 = false (bypass)
  if (isNaN(capturedCents) || Math.abs(capturedCents - invoice.amount_cents) > 1) {
    log.error("PayPal captured amount mismatch", {
      orderId,
      capturedCents,
      invoiceAmountCents: invoice.amount_cents,
    });
    return null;
  }

  // R45 C-1: Atomically complete invoice + credit wallet in a single
  // DB transaction. If the server crashes mid-operation, both roll back.
  const amountCents = invoice.amount_cents;
  const result = await walletRepo.atomicCompleteInvoiceAndCredit(
    invoice.id,
    invoice.user_id,
    amountCents,
    "paypal",
    orderId,
    `PayPal top-up $${(amountCents / 100).toFixed(2)}`,
  );
  if (!result.claimed) {
    log.info("duplicate PayPal capture ignored (invoice already completed)", { orderId });
    return { userId: invoice.user_id, amountCents };
  }

  log.info("wallet credited via PayPal", { userId: invoice.user_id, amountCents, orderId });
  return { userId: invoice.user_id, amountCents };
}

// ---------------------------------------------------------------------------
// Webhook Signature Verification
// ---------------------------------------------------------------------------

export async function verifyPaypalWebhook(
  headers: Record<string, string>,
  rawBody: string,
): Promise<boolean> {
  const webhookId = getWebhookId();
  const token = await getAccessToken();
  const base = getApiBase();

  // PayPal webhook signature headers
  const transmissionId = headers["paypal-transmission-id"];
  const transmissionTime = headers["paypal-transmission-time"];
  const transmissionSig = headers["paypal-transmission-sig"];
  const certUrl = headers["paypal-cert-url"];
  const authAlgo = headers["paypal-auth-algo"];

  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
    log.error("PayPal webhook missing required signature headers");
    return false;
  }

  // SSRF: cert_url must be a PayPal domain
  try {
    const certParsed = new URL(certUrl);
    if (certParsed.protocol !== "https:") {
      log.error("PayPal cert_url is not HTTPS", { certUrl });
      return false;
    }
    const host = certParsed.hostname.toLowerCase();
    if (!host.endsWith(".paypal.com") && !host.endsWith(".symantec.com") && !host.endsWith(".verisign.com")) {
      log.error("PayPal cert_url hostname not allowed", { certUrl, host });
      return false;
    }
  } catch {
    log.error("PayPal cert_url is not a valid URL", { certUrl });
    return false;
  }

  // Call PayPal's verification API
  const resp = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: webhookId,
      webhook_event: JSON.parse(rawBody),
    }),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });

  if (!resp.ok) {
    log.error("PayPal webhook verification API failed", { status: resp.status });
    return false;
  }

  const text = await resp.text();
  if (text.length > 65_536) return false;

  const result = JSON.parse(text) as { verification_status: string };
  return result.verification_status === "SUCCESS";
}

// ---------------------------------------------------------------------------
// Webhook Handler
// ---------------------------------------------------------------------------

export async function handlePaypalWebhook(
  headers: Record<string, string>,
  rawBody: string,
): Promise<{ userId: string; amountCents: number } | null> {
  const verified = await verifyPaypalWebhook(headers, rawBody);
  if (!verified) {
    log.error("PayPal webhook signature verification failed");
    return null;
  }

  let event: { event_type: string; resource: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody);
    // R46 H-4: Prototype pollution protection on parsed webhook body
    if (typeof event === "object" && event !== null) {
      stripDangerousKeys(event as unknown as Record<string, unknown>);
    }
  } catch {
    log.error("PayPal webhook body is not valid JSON");
    return null;
  }

  // Handle PAYMENT.CAPTURE.COMPLETED — the primary payment event
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const resource = event.resource;
    // The supplementary_data.related_ids.order_id links back to the order
    const orderId = (resource as Record<string, unknown>)?.supplementary_data
      ? ((resource as Record<string, Record<string, Record<string, string>>>).supplementary_data?.related_ids?.order_id)
      : undefined;

    if (!orderId || typeof orderId !== "string") {
      log.warn("PayPal PAYMENT.CAPTURE.COMPLETED missing order_id", { resource: JSON.stringify(resource).slice(0, 500) });
      return null;
    }

    const invoice = await invoiceRepo.findInvoice("paypal", orderId);
    if (!invoice) {
      log.error("no matching invoice for PayPal webhook order", { orderId });
      return null;
    }

    if (invoice.status === "failed") {
      log.warn("webhook received for failed PayPal invoice, ignoring", { orderId });
      return null;
    }

    // R45 C-3: Amount verification is mandatory — reject if capture data is missing
    const capturedAmount = resource.amount as { value?: string } | undefined;
    if (!capturedAmount?.value) {
      log.error("PayPal webhook capture missing amount — rejecting", { orderId });
      return null;
    }
    const capturedCents = Math.round(parseFloat(capturedAmount.value) * 100);
    if (isNaN(capturedCents) || Math.abs(capturedCents - invoice.amount_cents) > 1) {
      log.error("PayPal webhook amount mismatch", { orderId, capturedCents, invoiceAmountCents: invoice.amount_cents });
      return null;
    }

    // R45 C-1: Atomically complete invoice + credit wallet in a single
    // DB transaction. If the server crashes mid-operation, both roll back.
    const amountCents = invoice.amount_cents;
    const result = await walletRepo.atomicCompleteInvoiceAndCredit(
      invoice.id,
      invoice.user_id,
      amountCents,
      "paypal",
      orderId,
      `PayPal top-up $${(amountCents / 100).toFixed(2)}`,
    );
    if (!result.claimed) {
      log.info("duplicate PayPal webhook ignored (invoice already completed)", { orderId });
      return { userId: invoice.user_id, amountCents };
    }

    log.info("wallet credited via PayPal webhook", { userId: invoice.user_id, amountCents, orderId });
    return { userId: invoice.user_id, amountCents };
  }

  // Handle CHECKOUT.ORDER.APPROVED — optional, for logging
  if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
    log.info("PayPal order approved (awaiting capture)", { resource: JSON.stringify(event.resource).slice(0, 200) });
    return null;
  }

  // Ignore other event types
  log.info("PayPal webhook event type not handled", { eventType: event.event_type });
  return null;
}
