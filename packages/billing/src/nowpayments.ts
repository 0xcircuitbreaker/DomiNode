import * as crypto from "node:crypto";
import { walletRepo, invoiceRepo, createLogger, SUPPORTED_CRYPTO } from "@dominusnode/shared";
import type { SupportedCrypto } from "@dominusnode/shared";

const log = createLogger("billing:nowpayments");

function getApiUrl(): string {
  return process.env["NOWPAYMENTS_API_URL"] ?? "https://api.nowpayments.io/v1";
}

function getApiKey(): string {
  const key = process.env["NOWPAYMENTS_API_KEY"];
  if (!key) throw new Error("NOWPAYMENTS_API_KEY is required");
  return key;
}

function getIpnSecret(): string {
  const secret = process.env["NOWPAYMENTS_IPN_SECRET"];
  if (!secret) throw new Error("NOWPAYMENTS_IPN_SECRET is required");
  return secret;
}

// ─── Create Invoice ──────────────────────────────────────────────────

export interface CryptoInvoice {
  invoiceId: string;
  invoiceUrl: string;
  payCurrency: SupportedCrypto;
  priceAmount: number;
  orderId: string;
}

export async function createCryptoInvoice(
  userId: string,
  amountUsd: number,
  payCurrency: SupportedCrypto,
): Promise<CryptoInvoice> {
  // R30 H-4: Defense-in-depth validation
  if (!Number.isFinite(amountUsd) || amountUsd < 5 || amountUsd > 1000) {
    throw new Error("Invalid amount: must be between $5 and $1,000");
  }

  if (!(SUPPORTED_CRYPTO as readonly string[]).includes(payCurrency)) {
    throw new Error(`Unsupported currency: ${payCurrency}`);
  }

  const orderId = `topup_${userId}_${Date.now()}`;

  const resp = await fetch(`${getApiUrl()}/invoice`, {
    method: "POST",
    headers: {
      "x-api-key": getApiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      price_amount: amountUsd,
      price_currency: "usd",
      pay_currency: payCurrency,
      order_id: orderId,
      order_description: `Dominus Node wallet top-up $${amountUsd.toFixed(2)}`,
      is_fixed_rate: true,
    }),
    redirect: "error", // R18-C2: Prevent HTTPS→HTTP redirect leaking x-api-key
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    // R23 C-3: Cap error body read to prevent OOM from malicious/compromised upstream
    await resp.body?.cancel();
    throw new Error(`NOWPayments createInvoice failed: ${resp.status}`);
  }

  // R18-H1: Response size limit to prevent OOM from oversized upstream response
  const responseText = await resp.text();
  if (responseText.length > 1_048_576) {
    throw new Error("NOWPayments response too large");
  }
  const data = JSON.parse(responseText) as {
    id: string;
    invoice_url: string;
  };

  await invoiceRepo.createInvoice(userId, "nowpayments", String(data.id), Math.round(amountUsd * 100));

  log.info("crypto invoice created", { userId, amountUsd, payCurrency, invoiceId: data.id });

  return {
    invoiceId: String(data.id),
    invoiceUrl: data.invoice_url,
    payCurrency,
    priceAmount: amountUsd,
    orderId,
  };
}

// ─── IPN Signature Verification ──────────────────────────────────────

export function verifyIpnSignature(
  body: Record<string, unknown>,
  signature: string,
): boolean {
  const secret = getIpnSecret();

  const sorted = Object.keys(body)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = body[key];
      return acc;
    }, {});

  const hmac = crypto.createHmac("sha512", secret).update(JSON.stringify(sorted)).digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hmac, "hex"),
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false; // length mismatch or invalid hex
  }
}

// ─── IPN Callback Handler ────────────────────────────────────────────

export async function handleIpnCallback(
  body: Record<string, unknown>,
  signature: string,
): Promise<{ userId: string; amountCents: number } | null> {
  if (!verifyIpnSignature(body, signature)) {
    log.error("IPN signature verification failed");
    return null;
  }

  // Validate payment_status is actually a string (R12 H-1: type confusion defense)
  const rawStatus = body["payment_status"];
  if (typeof rawStatus !== "string") {
    log.error("IPN payment_status is not a string", { type: typeof rawStatus });
    return null;
  }
  const paymentStatus = rawStatus;
  if (paymentStatus !== "finished" && paymentStatus !== "confirmed") {
    log.info("IPN status not final, ignoring", { paymentStatus });
    return null;
  }

  const rawPaymentId = body["payment_id"];
  const rawInvoiceId = body["invoice_id"];
  const rawPriceAmount = body["price_amount"];

  // R16-C2: Strict type guards — only accept string or number, reject all other types
  // to prevent type confusion from boolean/object/array coercion
  if (rawPaymentId !== undefined && typeof rawPaymentId !== "string" && typeof rawPaymentId !== "number") {
    log.error("IPN payment_id has unexpected type", { type: typeof rawPaymentId });
    return null;
  }
  // R31 C-2: Type guard for invoice_id matching the pattern used for payment_id and price_amount
  if (rawInvoiceId !== undefined && typeof rawInvoiceId !== "string" && typeof rawInvoiceId !== "number") {
    log.error("IPN invoice_id has unexpected type", { type: typeof rawInvoiceId });
    return null;
  }
  if (rawPriceAmount !== undefined && typeof rawPriceAmount !== "number" && typeof rawPriceAmount !== "string") {
    log.error("IPN price_amount has unexpected type", { type: typeof rawPriceAmount });
    return null;
  }

  // Explicit type narrowing: only coerce validated string/number types
  const paymentId = typeof rawPaymentId === "string" ? rawPaymentId
    : typeof rawPaymentId === "number" ? String(rawPaymentId) : "";
  const invoiceId = typeof rawInvoiceId === "string" ? rawInvoiceId
    : typeof rawInvoiceId === "number" ? String(rawInvoiceId) : "";
  const priceAmount = Number(rawPriceAmount ?? 0);

  if (!paymentId || priceAmount <= 0) {
    log.error("IPN missing required fields", { paymentId, priceAmount });
    return null;
  }

  // Look up by invoice_id only (matches the external_id we stored at invoice creation time).
  // NOWPayments IPN has both invoice_id and payment_id — they are different identifiers.
  // We stored data.id (invoice ID) in createCryptoInvoice, so we must look up by invoice_id only.
  // Do NOT fall back to paymentId — it's a different identifier and could match the wrong invoice.
  if (!invoiceId) {
    log.error("IPN missing invoice_id", { paymentId });
    return null;
  }
  const invoice = await invoiceRepo.findInvoice("nowpayments", invoiceId);
  if (!invoice) {
    log.error("no matching invoice found for NOWPayments payment", { paymentId, invoiceId });
    return null;
  }

  // R30 H-3: Reject IPNs for invoices that have been permanently failed
  if (invoice.status === "failed") {
    log.warn("webhook received for failed invoice, ignoring", { externalId: invoiceId });
    return null;
  }

  const userId = invoice.user_id;

  // Verify the price amount matches what we originally requested
  // Compare as integer cents — allow ±1 cent tolerance for floating-point rounding
  // (NOWPayments sends price_amount as a float which can drift by fractions of a cent)
  const ipnAmountCents = Math.round(priceAmount * 100);
  if (Math.abs(ipnAmountCents - invoice.amount_cents) > 1) {
    log.error("amount mismatch between invoice and IPN callback", {
      paymentId,
      invoiceAmountCents: invoice.amount_cents,
      ipnAmountCents,
    });
    return null;
  }

  const amountCents = invoice.amount_cents;

  // Atomically mark invoice as completed — only one concurrent IPN
  // can succeed here since UPDATE ... WHERE status='pending' is atomic.
  const claimed = await invoiceRepo.completeInvoice(invoice.id);
  if (!claimed) {
    log.info("duplicate IPN ignored (invoice already completed)", { paymentId, invoiceId });
    return { userId, amountCents };
  }

  try {
    await walletRepo.creditWallet(
      userId,
      amountCents,
      "nowpayments",
      paymentId,
      // R26 C-2: Sanitize pay_currency — only allow alphanumeric + hyphen/underscore, cap length
      `Crypto top-up $${priceAmount.toFixed(2)} (${(typeof body["pay_currency"] === "string" ? body["pay_currency"].replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20) : "unknown")})`,
    );
  } catch (creditErr) {
    // R30 C-1: Do NOT revert to pending — this creates infinite retry loops.
    // Mark as failed; operator can manually reconcile if needed.
    log.error("wallet credit failed after invoice completion — marking invoice as failed", {
      invoiceId: invoice.id, userId, paymentId,
      error: creditErr instanceof Error ? creditErr.message : String(creditErr),
    });
    try { await invoiceRepo.markCreditFailed(invoice.id); } catch { /* best effort */ }
    throw creditErr;
  }
  log.info("wallet credited via NOWPayments", { userId, amountCents, paymentId });
  return { userId, amountCents };
}
