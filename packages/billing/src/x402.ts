import * as crypto from "node:crypto";
import { createLogger, query } from "@dominusnode/shared";

const log = createLogger("billing:x402");

// ─── Prototype Pollution Protection ─────────────────────────────────

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Recursively strip dangerous keys to prevent prototype pollution */
function stripDangerousKeys(obj: Record<string, unknown>, depth = 0): void {
  if (depth > 5) return; // prevent deep recursion
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) {
      delete obj[key];
    } else if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
      stripDangerousKeys(obj[key] as Record<string, unknown>, depth + 1);
    }
  }
}

// ─── Types ──────────────────────────────────────────────────────────

export type X402Facilitator = "coinbase" | "payai";

export interface X402Requirements {
  version: string;
  accepts: X402PaymentOption[];
}

export interface X402PaymentOption {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  payTo: string;
  extra: { facilitator: X402Facilitator };
}

export interface X402VerifyResult {
  valid: boolean;
  payer: string;
  amountUsd: string;
  facilitator: X402Facilitator;
  error?: string;
}

export interface X402Settlement {
  txHash: string;
  amountSettled: string;
  facilitator: X402Facilitator;
}

// ─── Config ─────────────────────────────────────────────────────────

export function isX402Enabled(): boolean {
  return process.env["X402_ENABLED"] === "true";
}

export function getDcPricePerRequestUsd(): string {
  return process.env["X402_DC_PRICE_PER_REQUEST_USD"] ?? "0.001";
}

export function getResPricePerRequestUsd(): string {
  return process.env["X402_RES_PRICE_PER_REQUEST_USD"] ?? "0.005";
}

function getMaxRequestBodyBytes(): number {
  const val = parseInt(process.env["X402_MAX_REQUEST_BODY_BYTES"] ?? "10485760", 10);
  if (isNaN(val) || val < 1024 || val > 104857600) {
    throw new Error("X402_MAX_REQUEST_BODY_BYTES must be between 1024 and 104857600");
  }
  return val;
}

// ─── Facilitator Detection ──────────────────────────────────────────

/**
 * Detect which facilitator to use based on the X-PAYMENT header content.
 * - Coinbase: payment contains EVM-style 0x addresses (Base chain)
 * - PayAI: payment contains Solana-style base58 addresses
 * Falls back to coinbase if ambiguous.
 */
export function detectFacilitator(paymentHeader: string): X402Facilitator {
  if (!paymentHeader || paymentHeader.length === 0) {
    return "coinbase"; // default
  }

  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(paymentHeader);
    // Recursive prototype pollution protection
    if (typeof parsed === "object" && parsed !== null) {
      stripDangerousKeys(parsed);
    }
    // Check for explicit facilitator field
    if (parsed.facilitator === "payai" || parsed.network === "solana") {
      return "payai";
    }
    if (parsed.facilitator === "coinbase" || parsed.network === "base" || parsed.network === "base-sepolia") {
      return "coinbase";
    }
    // Check payTo address format
    if (typeof parsed.payTo === "string") {
      if (parsed.payTo.startsWith("0x")) return "coinbase";
      // Solana base58 addresses are 32-44 chars, no 0x prefix
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(parsed.payTo)) return "payai";
    }
  } catch {
    // Not JSON — check raw content patterns
    if (paymentHeader.includes('"network":"solana"') || paymentHeader.includes('"facilitator":"payai"')) {
      return "payai";
    }
  }

  return "coinbase"; // default fallback
}

// ─── USDC Amount Helpers ────────────────────────────────────────────

/** Parse USDC base units from facilitator response, returning 0 on invalid input */
function parseUsdcAmount(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const val = parseInt(raw, 10);
  if (!Number.isSafeInteger(val) || val < 0) return 0;
  return val;
}

// ─── Build Requirements ─────────────────────────────────────────────

/**
 * Build x402 payment requirements for a given pool type.
 * Returns the JSON structure that goes in the 402 response body.
 */
export function buildX402Requirements(poolType: "dc" | "residential"): X402Requirements {
  const priceUsd = poolType === "dc" ? getDcPricePerRequestUsd() : getResPricePerRequestUsd();
  // Convert USD string to USDC base units (6 decimals)
  const priceFloat = parseFloat(priceUsd);
  if (isNaN(priceFloat) || priceFloat <= 0) {
    throw new Error(`Invalid x402 price for ${poolType}: ${priceUsd}`);
  }
  const amountUsdc = Math.ceil(priceFloat * 1_000_000).toString();

  const accepts: X402PaymentOption[] = [];

  // Coinbase facilitator (Base chain)
  const evmAddr = process.env["X402_RECEIVING_ADDRESS"];
  if (evmAddr) {
    // H-1: Validate EVM address format
    if (!/^0x[0-9a-fA-F]{40}$/.test(evmAddr)) {
      log.warn("Invalid X402_RECEIVING_ADDRESS format — must be 0x + 40 hex chars", { addr: evmAddr.slice(0, 6) });
    } else {
      accepts.push({
        scheme: "exact",
        network: process.env["X402_NETWORK"] ?? "base-sepolia",
        maxAmountRequired: amountUsdc,
        resource: `https://${process.env["PROXY_PUBLIC_HOST"] ?? "proxy.dominusnode.com"}`,
        payTo: evmAddr,
        extra: { facilitator: "coinbase" },
      });
    }
  }

  // PayAI facilitator (Solana)
  const solAddr = process.env["X402_RECEIVING_ADDRESS_SOLANA"];
  if (solAddr) {
    // H-1: Validate Solana address format (base58, 32-44 chars)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(solAddr)) {
      log.warn("Invalid X402_RECEIVING_ADDRESS_SOLANA format", { addr: solAddr.slice(0, 6) });
    } else {
      accepts.push({
        scheme: "exact",
        network: "solana",
        maxAmountRequired: amountUsdc,
        resource: `https://${process.env["PROXY_PUBLIC_HOST"] ?? "proxy.dominusnode.com"}`,
        payTo: solAddr,
        extra: { facilitator: "payai" },
      });
    }
  }

  // H-8: Warn if no accepts and x402 is enabled
  if (accepts.length === 0 && isX402Enabled()) {
    log.error("x402 is enabled but no valid receiving addresses configured");
  }

  return { version: "1", accepts };
}

// ─── Replay Protection ──────────────────────────────────────────────

/**
 * C-5: Hash the payment header for replay detection.
 */
export function hashPaymentHeader(paymentHeader: string): string {
  return crypto.createHash("sha256").update(paymentHeader).digest("hex");
}

/**
 * Atomic replay guard — INSERT with ON CONFLICT to prevent TOCTOU race.
 * Returns true if the hash was claimed (proceed), false if already used (replay).
 * Only settled transactions block replays (failed settlements don't poison).
 */
export async function claimPaymentHash(paymentHash: string): Promise<boolean> {
  const result = await query(
    `INSERT INTO x402_transactions (facilitator, payer_address, amount_usd, pool_type, status, payment_hash)
     VALUES ('coinbase', '', '0', 'dc', 'pending', $1)
     ON CONFLICT (payment_hash) DO NOTHING`,
    [paymentHash],
  );
  return (result.rowCount ?? 0) > 0; // true = claimed, false = replay
}

// ─── Verify Payment ─────────────────────────────────────────────────

/**
 * Verify an x402 payment header against requirements.
 * This calls the appropriate facilitator API to validate the payment.
 */
export async function verifyX402Payment(
  paymentHeader: string,
  requirements: X402Requirements,
): Promise<X402VerifyResult> {
  if (!paymentHeader || paymentHeader.length === 0) {
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Empty payment header" };
  }

  // Cap payment header size to prevent abuse
  if (paymentHeader.length > 10_000) {
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Payment header too large" };
  }

  // H-8: Reject if no accepts configured
  if (requirements.accepts.length === 0) {
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "No payment facilitators configured" };
  }

  // Atomic replay guard — claim the hash BEFORE verify/settle
  const paymentHash = hashPaymentHeader(paymentHeader);
  try {
    const claimed = await claimPaymentHash(paymentHash);
    if (!claimed) {
      return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Payment already used" };
    }
  } catch (err) {
    // DB check failed — fail closed
    log.error("replay claim failed", { error: err instanceof Error ? err.message : String(err) });
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Payment verification temporarily unavailable" };
  }

  const facilitator = detectFacilitator(paymentHeader);

  try {
    let result: X402VerifyResult;
    if (facilitator === "coinbase") {
      result = await verifyCoinbasePayment(paymentHeader, requirements);
    } else {
      result = await verifyPayAIPayment(paymentHeader, requirements);
    }
    // If verification returned invalid, release the claimed hash so
    // the same payment can be retried (e.g., after transient facilitator error)
    if (!result.valid) {
      await releasePaymentHash(paymentHash).catch(() => {});
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("x402 verification failed", { facilitator, error: msg });
    // Release hash so payment can be retried after transient errors
    await releasePaymentHash(paymentHash).catch(() => {});
    // H-2: Generic error to client — specific error logged server-side
    return { valid: false, payer: "", amountUsd: "0", facilitator, error: "Payment verification failed" };
  }
}

// ─── Coinbase Facilitator ───────────────────────────────────────────

async function verifyCoinbasePayment(
  paymentHeader: string,
  requirements: X402Requirements,
): Promise<X402VerifyResult> {
  const cdpKeyId = process.env["CDP_API_KEY_ID"];
  const cdpKeySecret = process.env["CDP_API_KEY_SECRET"];

  if (!cdpKeyId || !cdpKeySecret) {
    // H-2: Generic error to client
    log.error("Coinbase CDP credentials not configured");
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Facilitator unavailable" };
  }

  // Find the coinbase accept entry from requirements
  const coinbaseAccept = requirements.accepts.find(a => a.extra.facilitator === "coinbase");
  if (!coinbaseAccept) {
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Facilitator unavailable" };
  }

  // Call Coinbase x402 facilitator verify endpoint
  // C-1: Include both key ID and secret in auth headers
  const verifyUrl = "https://x402.org/facilitator/verify";
  const body = JSON.stringify({
    payment: paymentHeader,
    requirements: coinbaseAccept,
  });

  const res = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CDP-API-KEY-ID": cdpKeyId,
      "X-CDP-API-KEY-SECRET": cdpKeySecret,
    },
    body,
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    log.error("Coinbase verify failed", { status: res.status, error: errText.slice(0, 200) });
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Payment verification failed" };
  }

  // Size-limit facilitator response to prevent OOM
  const resText = await res.text();
  if (resText.length > 10_000) {
    log.error("Coinbase verify response too large", { length: resText.length });
    return { valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Facilitator response too large" };
  }
  const result = JSON.parse(resText) as { valid?: boolean; payer?: string; amount?: string };
  stripDangerousKeys(result as Record<string, unknown>);

  if (!result.valid) {
    return { valid: false, payer: result.payer ?? "", amountUsd: "0", facilitator: "coinbase", error: "Payment invalid" };
  }

  // H-5: Validate amount format
  const amountUsdc = parseUsdcAmount(result.amount);
  if (amountUsdc === 0) {
    return { valid: false, payer: result.payer ?? "", amountUsd: "0", facilitator: "coinbase", error: "Invalid amount from facilitator" };
  }

  // C-4: Verify amount meets requirement
  const requiredAmount = parseInt(coinbaseAccept.maxAmountRequired, 10);
  if (amountUsdc < requiredAmount) {
    return { valid: false, payer: result.payer ?? "", amountUsd: "0", facilitator: "coinbase", error: "Payment amount insufficient" };
  }

  const amountUsd = (amountUsdc / 1_000_000).toFixed(6);

  return {
    valid: true,
    payer: result.payer ?? "",
    amountUsd,
    facilitator: "coinbase",
  };
}

// ─── PayAI Facilitator ──────────────────────────────────────────────

async function verifyPayAIPayment(
  paymentHeader: string,
  requirements: X402Requirements,
): Promise<X402VerifyResult> {
  const payaiKeyId = process.env["PAYAI_API_KEY_ID"];
  const payaiKeySecret = process.env["PAYAI_API_KEY_SECRET"];

  if (!payaiKeyId || !payaiKeySecret) {
    log.error("PayAI credentials not configured");
    return { valid: false, payer: "", amountUsd: "0", facilitator: "payai", error: "Facilitator unavailable" };
  }

  // Find the payai accept entry from requirements
  const payaiAccept = requirements.accepts.find(a => a.extra.facilitator === "payai");
  if (!payaiAccept) {
    return { valid: false, payer: "", amountUsd: "0", facilitator: "payai", error: "Facilitator unavailable" };
  }

  // Call PayAI facilitator verify endpoint
  const verifyUrl = "https://api.payai.network/v1/x402/verify";
  const body = JSON.stringify({
    payment: paymentHeader,
    requirements: payaiAccept,
  });

  const res = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PayAI-Key-ID": payaiKeyId,
      "X-PayAI-Key-Secret": payaiKeySecret,
    },
    body,
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    log.error("PayAI verify failed", { status: res.status, error: errText.slice(0, 200) });
    return { valid: false, payer: "", amountUsd: "0", facilitator: "payai", error: "Payment verification failed" };
  }

  // Size-limit facilitator response to prevent OOM
  const resText = await res.text();
  if (resText.length > 10_000) {
    log.error("PayAI verify response too large", { length: resText.length });
    return { valid: false, payer: "", amountUsd: "0", facilitator: "payai", error: "Facilitator response too large" };
  }
  const result = JSON.parse(resText) as { valid?: boolean; payer?: string; amount?: string };
  stripDangerousKeys(result as Record<string, unknown>);

  if (!result.valid) {
    return { valid: false, payer: result.payer ?? "", amountUsd: "0", facilitator: "payai", error: "Payment invalid" };
  }

  // H-5: Validate amount format
  const amountUsdc = parseUsdcAmount(result.amount);
  if (amountUsdc === 0) {
    return { valid: false, payer: result.payer ?? "", amountUsd: "0", facilitator: "payai", error: "Invalid amount from facilitator" };
  }

  // C-4: Verify amount meets requirement
  const requiredAmount = parseInt(payaiAccept.maxAmountRequired, 10);
  if (amountUsdc < requiredAmount) {
    return { valid: false, payer: result.payer ?? "", amountUsd: "0", facilitator: "payai", error: "Payment amount insufficient" };
  }

  const amountUsd = (amountUsdc / 1_000_000).toFixed(6);

  return {
    valid: true,
    payer: result.payer ?? "",
    amountUsd,
    facilitator: "payai",
  };
}

// ─── Settle Payment ─────────────────────────────────────────────────

/**
 * Settle (finalize) an x402 payment.
 * C-2: Settlement is now called BEFORE proxying to prevent free service.
 */
export async function settleX402Payment(
  paymentHeader: string,
  facilitator: X402Facilitator,
): Promise<X402Settlement> {
  if (facilitator === "coinbase") {
    return settleCoinbasePayment(paymentHeader);
  } else {
    return settlePayAIPayment(paymentHeader);
  }
}

async function settleCoinbasePayment(paymentHeader: string): Promise<X402Settlement> {
  // H-3: Validate credentials exist before settlement
  const cdpKeyId = process.env["CDP_API_KEY_ID"];
  const cdpKeySecret = process.env["CDP_API_KEY_SECRET"];
  if (!cdpKeyId || !cdpKeySecret) {
    throw new Error("Coinbase CDP credentials not configured for settlement");
  }

  const settleUrl = "https://x402.org/facilitator/settle";
  const body = JSON.stringify({ payment: paymentHeader });

  // C-1: Include both key ID and secret
  const res = await fetch(settleUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CDP-API-KEY-ID": cdpKeyId,
      "X-CDP-API-KEY-SECRET": cdpKeySecret,
    },
    body,
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    // Log full facilitator error server-side but scrub from thrown error
    // to prevent leaking internal facilitator details to callers/logs upstream
    log.error("Coinbase settle failed", { status: res.status, body: errText.slice(0, 200) });
    throw new Error(`Coinbase settlement failed (HTTP ${res.status})`);
  }

  // Size-limit settle response
  const settleText = await res.text();
  if (settleText.length > 10_000) throw new Error("Coinbase settle response too large");
  const result = JSON.parse(settleText) as { txHash?: string; amount?: string };
  return {
    txHash: result.txHash ?? "",
    amountSettled: result.amount ?? "0",
    facilitator: "coinbase",
  };
}

async function settlePayAIPayment(paymentHeader: string): Promise<X402Settlement> {
  const payaiKeyId = process.env["PAYAI_API_KEY_ID"];
  const payaiKeySecret = process.env["PAYAI_API_KEY_SECRET"];
  if (!payaiKeyId || !payaiKeySecret) {
    throw new Error("PayAI credentials not configured for settlement");
  }

  const settleUrl = "https://api.payai.network/v1/x402/settle";
  const body = JSON.stringify({ payment: paymentHeader });

  const res = await fetch(settleUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PayAI-Key-ID": payaiKeyId,
      "X-PayAI-Key-Secret": payaiKeySecret,
    },
    body,
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    // Log full facilitator error server-side but scrub from thrown error
    log.error("PayAI settle failed", { status: res.status, body: errText.slice(0, 200) });
    throw new Error(`PayAI settlement failed (HTTP ${res.status})`);
  }

  // Size-limit settle response
  const settleText = await res.text();
  if (settleText.length > 10_000) throw new Error("PayAI settle response too large");
  const result = JSON.parse(settleText) as { txHash?: string; amount?: string };
  return {
    txHash: result.txHash ?? "",
    amountSettled: result.amount ?? "0",
    facilitator: "payai",
  };
}

// ─── Record Transaction ─────────────────────────────────────────────

/**
 * Update a pending x402 transaction (claimed by claimPaymentHash) with settlement result.
 * This replaces the old INSERT-after-settle pattern with UPDATE-after-settle.
 */
export async function updateX402Transaction(
  paymentHash: string,
  facilitator: X402Facilitator,
  payerAddress: string,
  amountUsd: string,
  txHash: string | null,
  poolType: "dc" | "residential",
  targetHost: string,
  status: "settled" | "failed",
): Promise<void> {
  const safePayer = payerAddress.slice(0, 255);
  const safeAmount = /^\d+\.?\d*$/.test(amountUsd) ? amountUsd.slice(0, 50) : "0";
  const safeTxHash = txHash ? txHash.slice(0, 255) : null;
  const safeTarget = targetHost.slice(0, 255);

  await query(
    `UPDATE x402_transactions
     SET facilitator = $1, payer_address = $2, amount_usd = $3, tx_hash = $4,
         pool_type = $5, target_host = $6, status = $7
     WHERE payment_hash = $8`,
    [facilitator, safePayer, safeAmount, safeTxHash, poolType, safeTarget, status, paymentHash],
  );
}

// ─── Release Payment Hash ────────────────────────────────────────────

/**
 * Release a pending payment hash so the same payment can be retried
 * after a failed settlement. Only deletes rows with status='pending'.
 */
export async function releasePaymentHash(paymentHash: string): Promise<void> {
  await query(
    "DELETE FROM x402_transactions WHERE payment_hash = $1 AND status = 'pending'",
    [paymentHash],
  );
}

// ─── Response Size Config ────────────────────────────────────────────

/**
 * Max response bytes per x402 request.
 * Prevents bandwidth theft through unlimited data transfer for a single micropayment.
 */
export function getX402MaxResponseBytes(): number {
  const val = parseInt(process.env["X402_MAX_RESPONSE_BYTES"] ?? "10485760", 10);
  if (isNaN(val) || val < 1024 || val > 104857600) {
    throw new Error("X402_MAX_RESPONSE_BYTES must be between 1024 and 104857600");
  }
  return val;
}

// ─── Re-exports for convenience ─────────────────────────────────────

export { getMaxRequestBodyBytes, hashPaymentHeader as _hashPaymentHeader };
