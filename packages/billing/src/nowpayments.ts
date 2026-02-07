import * as crypto from "node:crypto";
import { walletRepo, invoiceRepo, createLogger, SUPPORTED_CRYPTO } from "@dominode/shared";
import type { SupportedCrypto } from "@dominode/shared";

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
      order_description: `DomiNode wallet top-up $${amountUsd.toFixed(2)}`,
      is_fixed_rate: true,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`NOWPayments createInvoice failed: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as {
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

  const paymentStatus = body["payment_status"] as string | undefined;
  if (paymentStatus !== "finished" && paymentStatus !== "confirmed") {
    log.info("IPN status not final, ignoring", { paymentStatus });
    return null;
  }

  const paymentId = String(body["payment_id"] ?? "");
  const priceAmount = Number(body["price_amount"] ?? 0);

  if (!paymentId || priceAmount <= 0) {
    log.error("IPN missing required fields", { paymentId, priceAmount });
    return null;
  }

  // Look up the invoice we created at payment time instead of parsing userId from order_id
  const invoice = await invoiceRepo.findInvoice("nowpayments", paymentId);
  if (!invoice) {
    log.error("no matching invoice found for NOWPayments payment", { paymentId });
    return null;
  }

  const userId = invoice.user_id;
  const expectedAmount = invoice.amount_cents / 100;

  // Verify the price amount matches what we originally requested
  if (Math.round(priceAmount * 100) !== Math.round(expectedAmount * 100)) {
    log.error("amount mismatch between invoice and IPN callback", {
      paymentId,
      invoiceAmountUsd: expectedAmount,
      ipnPriceAmount: priceAmount,
    });
    return null;
  }

  const amountCents = invoice.amount_cents;

  try {
    await walletRepo.creditWallet(
      userId,
      amountCents,
      "nowpayments",
      paymentId,
      `Crypto top-up $${priceAmount.toFixed(2)} (${body["pay_currency"] ?? "unknown"})`,
    );
    await invoiceRepo.completeInvoice(invoice.id);
    log.info("wallet credited via NOWPayments", { userId, amountCents, paymentId });
    return { userId, amountCents };
  } catch (err) {
    if (err instanceof Error && err.message.includes("duplicate")) {
      log.info("duplicate IPN ignored", { paymentId });
      return { userId, amountCents };
    }
    throw err;
  }
}
