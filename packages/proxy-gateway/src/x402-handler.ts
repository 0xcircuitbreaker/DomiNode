import * as http from "node:http";
import * as net from "node:net";
import { createLogger } from "@dominusnode/shared";
import {
  isX402Enabled,
  buildX402Requirements,
  verifyX402Payment,
  settleX402Payment,
  updateX402Transaction,
  releasePaymentHash,
  hashPaymentHeader,
  getX402MaxResponseBytes,
} from "@dominusnode/billing";
import type { X402Facilitator } from "@dominusnode/billing";

const log = createLogger("proxy:x402");

// ─── Rate Limiting ──────────────────────────────────────────────────

// C-3: Validate NaN + range on rate limit config
const parsedRateMax = parseInt(process.env["X402_RATE_LIMIT_MAX"] ?? "60", 10);
if (isNaN(parsedRateMax) || parsedRateMax < 1 || parsedRateMax > 10_000) {
  throw new Error("X402_RATE_LIMIT_MAX must be an integer between 1 and 10000");
}
const X402_RATE_LIMIT_MAX = parsedRateMax;
const X402_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_ENTRIES = 100_000;

const x402RateLimits = new Map<string, number[]>();

// Periodic cleanup to prevent OOM
let lastCleanup = Date.now();
function cleanupRateLimits(): void {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  for (const [key, timestamps] of x402RateLimits) {
    const valid = timestamps.filter(t => now - t < X402_RATE_LIMIT_WINDOW_MS);
    if (valid.length === 0) {
      x402RateLimits.delete(key);
    } else {
      x402RateLimits.set(key, valid);
    }
  }
}

// H-5: Periodic cleanup interval to prevent OOM even during idle periods
const _cleanupInterval = setInterval(() => {
  lastCleanup = 0; // Force cleanup on next call
  cleanupRateLimits();
}, 60_000);
_cleanupInterval.unref(); // Don't prevent process exit

function checkX402RateLimit(payerAddress: string): boolean {
  cleanupRateLimits();

  if (x402RateLimits.size >= MAX_RATE_LIMIT_ENTRIES) {
    return false; // refuse new entries when map is full
  }

  const now = Date.now();
  const timestamps = x402RateLimits.get(payerAddress) ?? [];
  const valid = timestamps.filter(t => now - t < X402_RATE_LIMIT_WINDOW_MS);

  if (valid.length >= X402_RATE_LIMIT_MAX) {
    return false;
  }

  valid.push(now);
  x402RateLimits.set(payerAddress, valid);
  return true;
}

// ─── Pool Type Detection ────────────────────────────────────────────

/**
 * Determine pool type from proxy request username or headers.
 * For x402 requests, the client can specify pool type via X-Pool-Type header
 * or default to "dc" (cheapest).
 */
function getPoolTypeFromRequest(req: http.IncomingMessage): "dc" | "residential" {
  const poolHeader = req.headers["x-pool-type"];
  if (poolHeader === "residential") return "residential";
  return "dc";
}

// ─── HTTP x402 Handler ──────────────────────────────────────────────

/**
 * Check if an HTTP request should be handled via x402.
 * Returns true if handled (caller should not proceed with normal auth flow).
 * Returns false if x402 is not applicable (caller should continue with normal auth).
 */
export async function handleX402Http(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (!isX402Enabled()) return false;

  const paymentHeader = req.headers["x-payment"] as string | undefined;

  // If there's no X-PAYMENT header, this isn't an x402 request.
  // The caller will continue with normal auth flow.
  if (!paymentHeader) return false;

  // IP-based rate limit BEFORE verify (prevent CPU waste on anonymous requests)
  const clientIp = (req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (clientIp && !checkX402RateLimit(`ip:${clientIp}`)) {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "X-DominusNode-Error": "X402_RATE_LIMITED",
      "Retry-After": "60",
    });
    res.end(JSON.stringify({
      error: "X402_RATE_LIMITED",
      message: "Too many x402 requests from this IP. Please wait.",
    }));
    return true;
  }

  const poolType = getPoolTypeFromRequest(req);
  const requirements = buildX402Requirements(poolType);

  // Verify the payment
  const verifyResult = await verifyX402Payment(paymentHeader, requirements);

  if (!verifyResult.valid) {
    log.warn("x402 payment verification failed", {
      facilitator: verifyResult.facilitator,
      error: verifyResult.error,
    });
    res.writeHead(402, {
      "Content-Type": "application/json",
      "X-DominusNode-Error": "X402_PAYMENT_INVALID",
    });
    res.end(JSON.stringify({
      error: "X402_PAYMENT_INVALID",
      message: verifyResult.error ?? "Payment verification failed",
      x402: requirements,
    }));
    return true;
  }

  // Rate limit by payer address (BEFORE settlement to avoid wasting payments)
  if (!checkX402RateLimit(`payer:${verifyResult.payer}`)) {
    // Release the claimed hash since we're rejecting before settlement
    const payHash = hashPaymentHeader(paymentHeader);
    await releasePaymentHash(payHash).catch(() => {});
    res.writeHead(429, {
      "Content-Type": "application/json",
      "X-DominusNode-Error": "X402_RATE_LIMITED",
      "Retry-After": "60",
    });
    res.end(JSON.stringify({
      error: "X402_RATE_LIMITED",
      message: "Too many x402 requests from this payer address. Please wait.",
    }));
    return true;
  }

  // C-2: Settle BEFORE proxying to prevent free service on settlement failure
  let settlement;
  try {
    settlement = await settleX402Payment(paymentHeader, verifyResult.facilitator);
  } catch (err) {
    log.error("x402 settlement failed — rejecting request", {
      payer: verifyResult.payer.slice(0, 10) + "...",
      facilitator: verifyResult.facilitator,
      error: err instanceof Error ? err.message : String(err),
    });
    // C-3: Release the pending hash so the payment can be retried
    const payHash = hashPaymentHeader(paymentHeader);
    await releasePaymentHash(payHash).catch(() => {});
    res.writeHead(402, {
      "Content-Type": "application/json",
      "X-DominusNode-Error": "X402_SETTLEMENT_FAILED",
    });
    res.end(JSON.stringify({
      error: "X402_SETTLEMENT_FAILED",
      message: "Payment settlement failed. Please try again.",
      x402: requirements,
    }));
    return true;
  }

  // C-2: Update the pending transaction (claimed during verify) with settlement result
  const payHash = hashPaymentHeader(paymentHeader);
  await updateX402Transaction(
    payHash, verifyResult.facilitator, verifyResult.payer, verifyResult.amountUsd,
    settlement.txHash, poolType, "unknown", "settled",
  ).catch(e => log.error("failed to update x402 tx", { error: e instanceof Error ? e.message : String(e) }));

  // Payment settled — store info on request for the proxy handler
  (req as any).__x402 = {
    verified: true,
    payer: verifyResult.payer,
    amountUsd: verifyResult.amountUsd,
    facilitator: verifyResult.facilitator,
    poolType,
    settled: true,
    maxResponseBytes: getX402MaxResponseBytes(),
  };

  log.info("x402 payment settled", {
    payer: verifyResult.payer.slice(0, 10) + "...",
    amountUsd: verifyResult.amountUsd,
    facilitator: verifyResult.facilitator,
    poolType,
    txHash: settlement.txHash.slice(0, 10) + "...",
  });

  return true; // req.__x402.verified = true means proceed with proxying
}

/**
 * Post-proxy hook for x402 HTTP requests.
 * C-2: Settlement now happens BEFORE proxying (in handleX402Http),
 * so this is a no-op. Kept for API compatibility.
 */
export async function settleX402HttpRequest(
  _req: http.IncomingMessage,
  _targetHost: string,
): Promise<void> {
  // Settlement already completed in handleX402Http (settle-before-proxy).
  // M-4: Payment header already cleared from request after settlement.
}

// ─── CONNECT x402 Handler ───────────────────────────────────────────

export interface X402ConnectResult {
  handled: boolean;
  verified: boolean;
  payer: string;
  facilitator: X402Facilitator;
  poolType: "dc" | "residential";
  paymentHeader: string;
  amountUsd: string;
  /** C-4: Max bytes for this x402 tunnel to prevent bandwidth theft */
  maxResponseBytes: number;
}

/**
 * Check if a CONNECT request should be handled via x402.
 */
export async function handleX402Connect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
): Promise<X402ConnectResult | null> {
  if (!isX402Enabled()) return null;

  const paymentHeader = req.headers["x-payment"] as string | undefined;
  if (!paymentHeader) return null;

  // IP-based rate limit BEFORE verify
  const clientIp = (req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (clientIp && !checkX402RateLimit(`ip:${clientIp}`)) {
    if (!clientSocket.destroyed) {
      clientSocket.write(
        "HTTP/1.1 429 Too Many Requests\r\nX-DominusNode-Error: X402_RATE_LIMITED\r\nRetry-After: 60\r\n\r\n",
      );
      clientSocket.end();
    }
    return { handled: true, verified: false, payer: "", facilitator: "coinbase" as X402Facilitator, poolType: "dc" as const, paymentHeader: "", amountUsd: "0", maxResponseBytes: 0 };
  }

  const poolType = getPoolTypeFromRequest(req);
  const requirements = buildX402Requirements(poolType);

  const verifyResult = await verifyX402Payment(paymentHeader, requirements);

  if (!verifyResult.valid) {
    log.warn("x402 CONNECT payment failed", {
      facilitator: verifyResult.facilitator,
      error: verifyResult.error,
    });
    // Return 402 with requirements
    const body = JSON.stringify({
      error: "X402_PAYMENT_INVALID",
      message: verifyResult.error ?? "Payment verification failed",
      x402: requirements,
    });
    if (!clientSocket.destroyed) {
      clientSocket.write(
        `HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-DominusNode-Error: X402_PAYMENT_INVALID\r\n\r\n${body}`,
      );
      clientSocket.end();
    }
    return { handled: true, verified: false, payer: "", facilitator: "coinbase", poolType, paymentHeader: "", amountUsd: "0", maxResponseBytes: 0 };
  }

  if (!checkX402RateLimit(`payer:${verifyResult.payer}`)) {
    // Release the claimed hash since we're rejecting before settlement
    const payHashRL = hashPaymentHeader(paymentHeader);
    await releasePaymentHash(payHashRL).catch(() => {});
    if (!clientSocket.destroyed) {
      clientSocket.write(
        "HTTP/1.1 429 Too Many Requests\r\nX-DominusNode-Error: X402_RATE_LIMITED\r\nRetry-After: 60\r\n\r\n",
      );
      clientSocket.end();
    }
    return { handled: true, verified: false, payer: "", facilitator: "coinbase", poolType, paymentHeader: "", amountUsd: "0", maxResponseBytes: 0 };
  }

  // C-2: Settle BEFORE establishing tunnel
  let settlement;
  try {
    settlement = await settleX402Payment(paymentHeader, verifyResult.facilitator);
  } catch (err) {
    log.error("x402 CONNECT settlement failed — rejecting", {
      payer: verifyResult.payer.slice(0, 10) + "...",
      facilitator: verifyResult.facilitator,
      error: err instanceof Error ? err.message : String(err),
    });
    // C-3: Release the pending hash so the payment can be retried
    const payHash = hashPaymentHeader(paymentHeader);
    await releasePaymentHash(payHash).catch(() => {});
    const errBody = JSON.stringify({
      error: "X402_SETTLEMENT_FAILED",
      message: "Payment settlement failed. Please try again.",
      x402: requirements,
    });
    if (!clientSocket.destroyed) {
      clientSocket.write(
        `HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(errBody)}\r\nX-DominusNode-Error: X402_SETTLEMENT_FAILED\r\n\r\n${errBody}`,
      );
      clientSocket.end();
    }
    return { handled: true, verified: false, payer: "", facilitator: "coinbase", poolType, paymentHeader: "", amountUsd: "0", maxResponseBytes: 0 };
  }

  // C-2: Update the pending transaction (claimed during verify) with settlement result
  const payHash = hashPaymentHeader(paymentHeader);
  await updateX402Transaction(
    payHash, verifyResult.facilitator, verifyResult.payer, verifyResult.amountUsd,
    settlement.txHash, poolType, "unknown", "settled",
  ).catch(e => log.error("failed to update x402 tx", { error: e instanceof Error ? e.message : String(e) }));

  log.info("x402 CONNECT payment settled", {
    payer: verifyResult.payer.slice(0, 10) + "...",
    amountUsd: verifyResult.amountUsd,
    facilitator: verifyResult.facilitator,
    poolType,
  });

  // Do not store full paymentHeader in result struct (settlement is done, no longer needed)
  return {
    handled: true,
    verified: true,
    payer: verifyResult.payer,
    facilitator: verifyResult.facilitator,
    poolType,
    paymentHeader: "",
    amountUsd: verifyResult.amountUsd,
    maxResponseBytes: getX402MaxResponseBytes(),
  };
}

/**
 * Post-CONNECT hook. C-2: Settlement now happens before tunnel establishment.
 * Kept for API compatibility.
 */
export async function settleX402ConnectRequest(
  _result: X402ConnectResult,
  _targetHost: string,
): Promise<void> {
  // Settlement already completed in handleX402Connect (settle-before-proxy).
}

// ─── 402 Response Builder ───────────────────────────────────────────

/**
 * Build a 402 response body that includes x402 payment requirements
 * when x402 is enabled. Used by the main proxy server when returning
 * INSUFFICIENT_BALANCE errors.
 */
export function build402ResponseBody(poolType?: "dc" | "residential"): string {
  if (!isX402Enabled()) {
    return "Insufficient balance. Top up your wallet at the Dominus Node dashboard.";
  }

  const requirements = buildX402Requirements(poolType ?? "dc");
  return JSON.stringify({
    error: "INSUFFICIENT_BALANCE",
    message: "Insufficient balance. Pay with x402 micropayment or top up your wallet.",
    x402: requirements,
  });
}

/**
 * Build a 402 CONNECT response with x402 requirements.
 */
export function build402ConnectResponse(poolType?: "dc" | "residential"): string {
  if (!isX402Enabled()) {
    return "HTTP/1.1 402 Payment Required\r\nX-DominusNode-Error: INSUFFICIENT_BALANCE\r\n\r\n";
  }

  const body = JSON.stringify({
    error: "INSUFFICIENT_BALANCE",
    message: "Insufficient balance. Pay with x402 micropayment or top up your wallet.",
    x402: buildX402Requirements(poolType ?? "dc"),
  });

  return `HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-DominusNode-Error: INSUFFICIENT_BALANCE\r\n\r\n${body}`;
}

/**
 * Check if a request has a verified x402 payment attached.
 */
export function isX402Verified(req: http.IncomingMessage): boolean {
  return (req as any).__x402?.verified === true;
}

/**
 * Get x402 data from a verified request.
 */
export function getX402Data(req: http.IncomingMessage): {
  payer: string;
  amountUsd: string;
  facilitator: X402Facilitator;
  poolType: "dc" | "residential";
  maxResponseBytes: number;
} | null {
  const data = (req as any).__x402;
  if (!data?.verified) return null;
  return {
    payer: data.payer,
    amountUsd: data.amountUsd,
    facilitator: data.facilitator,
    poolType: data.poolType,
    maxResponseBytes: data.maxResponseBytes ?? 10_485_760,
  };
}
