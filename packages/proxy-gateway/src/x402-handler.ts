import * as http from "node:http";
import * as net from "node:net";
import { parseProxyOptions } from "./auth.js";
import { createLogger, userRepo, policyRepo, walletRepo, RELAY_BYTES_PER_GB } from "@dominusnode/shared";
import {
  isX402Enabled,
  buildX402Requirements,
  verifyX402Payment,
  settleX402Payment,
  updateX402Transaction,
  releasePaymentHash,
  hashPaymentHeader,
  getX402MaxResponseBytes,
  usdStringToMusd,
  mppRailFromEnv,
} from "@dominusnode/billing";
import type { X402Facilitator, MppRail, VerifyResult } from "@dominusnode/billing";
import { screenPayer } from "./payer-screening.js";

const log = createLogger("proxy:x402");

// ─── Rate Limiting ──────────────────────────────────────────────────

// C-3: Validate NaN + range on rate limit config
const parsedRateMax = parseInt(process.env["X402_RATE_LIMIT_MAX"] ?? "60", 10);
if (isNaN(parsedRateMax) || parsedRateMax < 1 || parsedRateMax > 10_000) {
  throw new Error("X402_RATE_LIMIT_MAX must be an integer between 1 and 10000");
}

// All x402 traffic is AI agent traffic — apply multiplier to give agents higher throughput
const AGENT_MULTIPLIER = parseInt(process.env["AGENT_RATE_LIMIT_MULTIPLIER"] ?? "10", 10);
if (isNaN(AGENT_MULTIPLIER) || AGENT_MULTIPLIER < 1 || AGENT_MULTIPLIER > 100) {
  throw new Error("AGENT_RATE_LIMIT_MULTIPLIER must be between 1 and 100");
}
const X402_RATE_LIMIT_MAX = parsedRateMax * AGENT_MULTIPLIER;
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

  if (!x402RateLimits.has(payerAddress) && x402RateLimits.size >= MAX_RATE_LIMIT_ENTRIES) {
    lastCleanup = 0; // prune expired entries before refusing
    cleanupRateLimits();
    if (x402RateLimits.size >= MAX_RATE_LIMIT_ENTRIES) return false; // refuse only NEW keys when full
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

/** Test hooks for the in-memory x402 rate limiter. */
export function checkX402RateLimitForTest(key: string): boolean {
  return checkX402RateLimit(key);
}
export function resetX402RateLimitsForTest(): void {
  x402RateLimits.clear();
}

// ─── Pool Type Detection ────────────────────────────────────────────

/**
 * Exit class an x402/MPP payment is quoted for. "any" = no class requested:
 * quoted at the HIGHEST configured price (never undercharges) and any node
 * may serve it. A named class is quoted at that class's price and the
 * selected node must be of that class.
 */
export type X402Class = "residential" | "dc" | "mobile" | "any";

/** Concrete class for node selection; "any" means unconstrained. */
export function selectClassFor(c: X402Class): "residential" | "dc" | "mobile" | undefined {
  return c === "any" ? undefined : c;
}

/** True when a node of nodeClass may carry traffic quoted for quoted. */
export function nodeMatchesQuotedClass(quoted: X402Class, nodeClass: string): boolean {
  return quoted === "any" || nodeClass === quoted;
}

/** Map a node/requested class onto an x402 quote class (unknown -> any). */
export function toX402Class(c: string | undefined | null): X402Class {
  return c === "residential" || c === "dc" || c === "mobile" ? c : "any";
}

/**
 * Exit class for an x402/MPP request. Same username flags as API-key auth
 * (class-residential|dc|mobile, legacy dc-/residential- prefix) from a Basic
 * Proxy-Authorization username; else the legacy X-Pool-Type header; else "any".
 */
export function getPoolTypeFromRequest(req: http.IncomingMessage): X402Class {
  const pa = req.headers["proxy-authorization"];
  if (typeof pa === "string" && /^basic\s+/i.test(pa)) {
    try {
      const decoded = Buffer.from(pa.replace(/^basic\s+/i, "").trim(), "base64").toString("utf8");
      const user = decoded.split(":")[0] ?? "";
      if (user.length <= 256) {
        const o = parseProxyOptions(user);
        if (o.ipClass) return o.ipClass;
      }
    } catch { /* fall through */ }
  }
  const h = req.headers["x-pool-type"];
  const v = Array.isArray(h) ? h[0] : h;
  return toX402Class(typeof v === "string" ? v.trim().toLowerCase() : undefined);
}

// ─── Relay pricing (DESIGN.md §7) ───────────────────────────────────

/** Bytes one x402 payment buys: price_per_gb × X402_BYTES_PER_REQUEST (default 10 MB). */
const X402_BYTES_PER_REQUEST = parseInt(process.env["X402_BYTES_PER_REQUEST"] ?? "10485760", 10);
if (isNaN(X402_BYTES_PER_REQUEST) || X402_BYTES_PER_REQUEST < 65_536 || X402_BYTES_PER_REQUEST > 1_073_741_824) {
  throw new Error("X402_BYTES_PER_REQUEST must be between 65536 and 1073741824");
}

/** ceil(price × bytes / GB) in µUSD, at least 1. */
export function x402AmountMusd(pricePerGbMusd: bigint, bytes: number = X402_BYTES_PER_REQUEST): bigint {
  const gb = BigInt(RELAY_BYTES_PER_GB);
  const v = (pricePerGbMusd * BigInt(bytes) + gb - 1n) / gb;
  return v > 0n ? v : 1n;
}

interface X402Quote {
  poolType: X402Class;
  pricePerGbMusd: bigint;
  amountMusd: bigint;
}

const lastQuote = new Map<X402Class, X402Quote>(); // ≤4 entries

async function quote(poolType: X402Class): Promise<X402Quote> {
  const pricePerGbMusd = await policyRepo.getPricing(poolType);
  const q = { poolType, pricePerGbMusd, amountMusd: x402AmountMusd(pricePerGbMusd) };
  lastQuote.set(poolType, q);
  return q;
}

/** Requirements for a 402 advertisement: relay quote when known (refreshed in the background). */
function advertisedRequirements(poolType: X402Class) {
  quote(poolType).catch(() => undefined);
  const q = lastQuote.get(poolType);
  return q ? buildX402Requirements({ amountMusd: q.amountMusd }) : buildX402Requirements(poolType === "dc" ? "dc" : "residential");
}

/** Bytes this payment may carry: min(X402_MAX_RESPONSE_BYTES, bytes the paid amount buys). */
function paidByteCap(q: X402Quote, paidMusd: bigint = q.amountMusd): number {
  const bought = (paidMusd * BigInt(RELAY_BYTES_PER_GB)) / q.pricePerGbMusd;
  return Math.max(1, Math.min(getX402MaxResponseBytes(), Number(bought > 2_000_000_000_000n ? 2_000_000_000_000n : bought)));
}

type PayerResolution = { ok: true; userId: string } | { ok: false; status: number; code: string; message: string };

/**
 * Map a verified x402 payer to its wallet-identity user (create or reuse).
 * Must run BEFORE settlement so a suspended/unsupported payer is never charged.
 */
async function resolvePayer(payer: string): Promise<PayerResolution> {
  // OFAC SDN screening of the payer wallet, before any identity is created or payment settled.
  const screen = await screenPayer(payer);
  if (screen === "blocked") {
    log.warn("x402/mpp payer refused by sanctions screening", { payer: payer.slice(0, 10) + "..." });
    return { ok: false, status: 403, code: "PAYER_SANCTIONED", message: "This payer wallet cannot use the network" };
  }
  if (screen === "unavailable") {
    log.error("payer sanctions list unavailable: refusing paid request");
    return { ok: false, status: 503, code: "PAYER_SCREENING_UNAVAILABLE", message: "Payment screening temporarily unavailable" };
  }
  try {
    const u = await userRepo.findOrCreateX402User(payer);
    if (u.status !== "active") return { ok: false, status: 403, code: "ACCOUNT_SUSPENDED", message: "Payer account is not active" };
    return { ok: true, userId: u.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("EVM address")) {
      return { ok: false, status: 402, code: "X402_PAYER_UNSUPPORTED", message: "The relay network accepts payments from EVM or Solana payers only" };
    }
    log.error("x402 payer mapping failed", { error: msg.slice(0, 120) });
    return { ok: false, status: 503, code: "SERVICE_UNAVAILABLE", message: "Payment identity temporarily unavailable" };
  }
}

/** Paid amount from the facilitator, never less than the quote. */
function paidAtLeastQuote(amountUsd: string, q: X402Quote): boolean {
  const paid = usdStringToMusd(amountUsd);
  return paid !== null && paid >= q.amountMusd && paid <= maxPaidMusd(q);
}

/**
 * Sanity cap on a single x402 payment: X402_MAX_OVERPAY_FACTOR × quote (default
 * 100×). Payments above it are rejected before settlement; within it, the full
 * paid amount is recorded as gross (cash collected == gross).
 */
const X402_MAX_OVERPAY_FACTOR = parseInt(process.env["X402_MAX_OVERPAY_FACTOR"] ?? "100", 10);
if (isNaN(X402_MAX_OVERPAY_FACTOR) || X402_MAX_OVERPAY_FACTOR < 1 || X402_MAX_OVERPAY_FACTOR > 10_000) {
  throw new Error("X402_MAX_OVERPAY_FACTOR must be an integer between 1 and 10000");
}
function maxPaidMusd(q: X402Quote): bigint {
  return q.amountMusd * BigInt(X402_MAX_OVERPAY_FACTOR);
}

// ─── Pending (verified, unsettled) payments ─────────────────────────

export interface X402Pending {
  /** Per-request rail that took the payment (relay_charges.payment_rail). */
  rail: "x402" | "mpp";
  /** Raw header; needed to settle. Cleared once settled or released. */
  paymentHeader: string;
  payHash: string;
  /** x402 only. */
  facilitator?: X402Facilitator;
  /** x402 only. */
  requirements?: ReturnType<typeof buildX402Requirements>;
  /** MPP only: the verified result handed to the rail's settle(). */
  mppVerified?: VerifyResult;
  payer: string;
  amountUsd: string;
  poolType: X402Class;
  userId: string;
  paidMusd: bigint;
  state: "verified" | "settled" | "released" | "refunded";
}

function makePending(
  paymentHeader: string,
  v: { facilitator: X402Facilitator; payer: string; amountUsd: string },
  requirements: ReturnType<typeof buildX402Requirements>,
  poolType: X402Class,
  userId: string,
  paidMusd: bigint,
): X402Pending {
  return {
    rail: "x402", paymentHeader, payHash: hashPaymentHeader(paymentHeader), facilitator: v.facilitator, requirements,
    payer: v.payer, amountUsd: v.amountUsd, poolType, userId, paidMusd, state: "verified",
  };
}

/** Reject before settlement: release the claimed hash so the payer can retry. */
export async function releaseX402Pending(p: X402Pending | undefined): Promise<void> {
  if (!p || p.state !== "verified") return;
  p.state = "released";
  p.paymentHeader = "";
  if (p.rail === "mpp") await getMppRail().release(p.payHash).catch(() => {});
  else await releasePaymentHash(p.payHash).catch(() => {});
}

/**
 * Settle on-chain. Call only once the request can be served (node selected,
 * snapshot locked, stream open). Returns false (hash released) on failure.
 */
export async function settleX402Pending(p: X402Pending): Promise<boolean> {
  if (p.state !== "verified") return p.state === "settled";
  if (p.rail === "mpp") return settleMppPending(p);
  let settlement: { txHash: string };
  try {
    settlement = await settleX402Payment(p.paymentHeader, p.facilitator!, p.requirements!);
  } catch (err) {
    log.error("x402 settlement failed — rejecting request", {
      payer: p.payer.slice(0, 10) + "...",
      facilitator: p.facilitator,
      error: err instanceof Error ? err.message : String(err),
    });
    await releaseX402Pending(p);
    return false;
  }
  p.state = "settled";
  p.paymentHeader = "";
  await updateX402Transaction(
    p.payHash, p.facilitator!, p.payer, p.amountUsd, settlement.txHash, p.poolType, "unknown", "settled",
  ).catch(e => log.error("failed to update x402 tx", { error: e instanceof Error ? e.message : String(e) }));
  log.info("x402 payment settled", {
    payer: p.payer.slice(0, 10) + "...", amountUsd: p.amountUsd, facilitator: p.facilitator, poolType: p.poolType,
    txHash: settlement.txHash.slice(0, 10) + "...",
  });
  return true;
}

/**
 * A settled payment whose request could not be served: credit the payer's
 * wallet-identity user wallet (FLOOR to whole cents; one recorded transaction).
 * Never refunds more than was paid: the sub-cent remainder stays with the
 * platform (logged as unrefunded), and a sub-cent payment refunds nothing.
 */
export async function refundX402Payer(p: X402Pending, reason: string): Promise<boolean> {
  if (p.state !== "settled") return false;
  p.state = "refunded";
  const cents = Number(p.paidMusd / 10_000n);
  const unrefundedMusd = p.paidMusd - BigInt(cents) * 10_000n;
  if (cents <= 0) {
    log.warn("x402 refund below one cent — nothing credited", {
      payer: p.payer.slice(0, 10) + "...", payHash: p.payHash.slice(0, 16), unrefundedMusd: unrefundedMusd.toString(), reason,
    });
    return true;
  }
  try {
    if (!(await walletRepo.getWallet(p.userId))) {
      await walletRepo.createWallet(p.userId).catch(() => undefined); // raced create is fine
    }
    await walletRepo.creditWallet(
      p.userId, cents, p.rail, `${p.rail}-refund:${p.payHash}`,
      `${p.rail} refund: ${reason.slice(0, 80)}`,
    );
    log.warn("x402 payment refunded to wallet", {
      payer: p.payer.slice(0, 10) + "...", cents, unrefundedMusd: unrefundedMusd.toString(), reason,
    });
    return true;
  } catch (err) {
    log.error("x402 REFUND FAILED — manual reconciliation required", {
      payer: p.payer.slice(0, 10) + "...", payHash: p.payHash.slice(0, 16), paidMusd: p.paidMusd.toString(), reason,
      error: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
    return false;
  }
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
  if (!req.headers["x-payment"] && hasMppCredential(req.headers)) return handleMppHttp(req, res);
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
  let q: X402Quote;
  try {
    q = await quote(poolType);
  } catch {
    res.writeHead(503, { "Content-Type": "application/json", "X-DominusNode-Error": "SERVICE_UNAVAILABLE", "Retry-After": "30" });
    res.end(JSON.stringify({ error: "SERVICE_UNAVAILABLE", message: "Pricing temporarily unavailable" }));
    return true;
  }
  const requirements = buildX402Requirements({ amountMusd: q.amountMusd });

  // Verify the payment (claims the payment hash first: replays are rejected)
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

  // Payer → wallet-identity user, and amount check, BEFORE settlement
  const amountOk = paidAtLeastQuote(verifyResult.amountUsd, q);
  const who = amountOk ? await resolvePayer(verifyResult.payer) : null;
  if (!amountOk || !who || !who.ok) {
    await releasePaymentHash(hashPaymentHeader(paymentHeader)).catch(() => {});
    const e = !amountOk || !who
      ? { status: 402, code: "X402_PAYMENT_INVALID", message: "Payment amount insufficient" }
      : (who as Extract<PayerResolution, { ok: false }>);
    res.writeHead(e.status, { "Content-Type": "application/json", "X-DominusNode-Error": e.code });
    res.end(JSON.stringify({ error: e.code, message: e.message }));
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

  // Verified only. Settlement happens in the proxy handler AFTER a node is
  // selected, the price/tier snapshot is locked and the stream is open
  // (settleX402Pending), so a payer is never charged for a request that
  // cannot be served.
  const paidMusd = usdStringToMusd(verifyResult.amountUsd)!;
  (req as any).__x402 = {
    verified: true,
    rail: "x402",
    payer: verifyResult.payer,
    userId: who.userId,
    amountUsd: verifyResult.amountUsd,
    amountMusd: paidMusd,
    pricePerGbMusd: q.pricePerGbMusd,
    facilitator: verifyResult.facilitator,
    poolType,
    settled: false,
    maxResponseBytes: paidByteCap(q, paidMusd),
    pending: makePending(paymentHeader, verifyResult, requirements, poolType, who.userId, paidMusd),
  };

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
  /** Rail that verified the payment; absent means x402. */
  rail?: "x402" | "mpp";
  handled: boolean;
  verified: boolean;
  payer: string;
  facilitator: X402Facilitator;
  poolType: X402Class;
  paymentHeader: string;
  amountUsd: string;
  /** C-4: Max bytes for this x402 tunnel to prevent bandwidth theft */
  maxResponseBytes: number;
  /** Wallet-identity user of the payer (relay_charges.requester_user_id). */
  userId?: string;
  amountMusd?: bigint;
  pricePerGbMusd?: bigint;
  /** Verified, not yet settled payment (settle with settleX402Pending). */
  pending?: X402Pending;
}

/**
 * Check if a CONNECT request should be handled via x402.
 */
export async function handleX402Connect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
): Promise<X402ConnectResult | null> {
  if (!req.headers["x-payment"] && hasMppCredential(req.headers)) return handleMppConnect(req, clientSocket);
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
    return { handled: true, verified: false, payer: "", facilitator: "coinbase" as X402Facilitator, poolType: "any" as X402Class, paymentHeader: "", amountUsd: "0", maxResponseBytes: 0 };
  }

  const poolType = getPoolTypeFromRequest(req);
  const fail = (line: string): X402ConnectResult => {
    if (!clientSocket.destroyed) {
      clientSocket.write(line);
      clientSocket.end();
    }
    return { handled: true, verified: false, payer: "", facilitator: "coinbase", poolType, paymentHeader: "", amountUsd: "0", maxResponseBytes: 0 };
  };
  let q: X402Quote;
  try {
    q = await quote(poolType);
  } catch {
    return fail("HTTP/1.1 503 Service Unavailable\r\nX-DominusNode-Error: SERVICE_UNAVAILABLE\r\nRetry-After: 30\r\n\r\n");
  }
  const requirements = buildX402Requirements({ amountMusd: q.amountMusd });

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

  const connAmountOk = paidAtLeastQuote(verifyResult.amountUsd, q);
  const connWho = connAmountOk ? await resolvePayer(verifyResult.payer) : null;
  if (!connAmountOk || !connWho || !connWho.ok) {
    await releasePaymentHash(hashPaymentHeader(paymentHeader)).catch(() => {});
    const e = !connAmountOk || !connWho
      ? { status: 402, code: "X402_PAYMENT_INVALID" }
      : (connWho as Extract<PayerResolution, { ok: false }>);
    return fail(`HTTP/1.1 ${e.status} ${http.STATUS_CODES[e.status] ?? "Error"}\r\nX-DominusNode-Error: ${e.code}\r\n\r\n`);
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

  // Verified only: the tunnel handler settles once the relay stream is open.
  const connPaidMusd = usdStringToMusd(verifyResult.amountUsd)!;
  return {
    rail: "x402",
    handled: true,
    verified: true,
    payer: verifyResult.payer,
    facilitator: verifyResult.facilitator,
    poolType,
    paymentHeader: "",
    amountUsd: verifyResult.amountUsd,
    maxResponseBytes: paidByteCap(q, connPaidMusd),
    userId: connWho.userId,
    amountMusd: connPaidMusd,
    pricePerGbMusd: q.pricePerGbMusd,
    pending: makePending(paymentHeader, verifyResult, requirements, poolType, connWho.userId, connPaidMusd),
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
export function build402ResponseBody(poolType?: X402Class): string {
  const mpp = advertisedMppChallenge(poolType ?? "any");
  if (!isX402Enabled() && !mpp) {
    return "Insufficient balance. Top up your wallet at the Dominus Node dashboard.";
  }
  return JSON.stringify({
    error: "INSUFFICIENT_BALANCE",
    message: "Insufficient balance. Pay per request (x402 or MPP) or top up your wallet.",
    ...(isX402Enabled() ? { x402: advertisedRequirements(poolType ?? "any") } : {}),
    ...(mpp ? { mpp: { method: mpp.method, intent: mpp.intent, realm: mpp.realm, expires: mpp.expires, wwwAuthenticate: mpp.header } } : {}),
  });
}

/**
 * Extra headers for a 402: the MPP `WWW-Authenticate: Payment` challenge when
 * MPP is configured (draft-ryan-httpauth-payment §5.1; 402s carry no-store).
 */
export function paymentChallengeHeaders(poolType?: X402Class): Record<string, string> {
  const mpp = advertisedMppChallenge(poolType ?? "any");
  return mpp ? { "WWW-Authenticate": mpp.header, "Cache-Control": "no-store" } : {};
}

function challengeHeaderLines(h: Record<string, string>): string {
  return Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join("");
}

/**
 * Build a 402 CONNECT response with x402 requirements.
 */
export function build402ConnectResponse(poolType?: X402Class): string {
  if (!isX402Enabled() && !getMppRail().enabled()) {
    return "HTTP/1.1 402 Payment Required\r\nX-DominusNode-Error: INSUFFICIENT_BALANCE\r\n\r\n";
  }

  const body = build402ResponseBody(poolType);
  const extra = challengeHeaderLines(paymentChallengeHeaders(poolType));
  return `HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}X-DominusNode-Error: INSUFFICIENT_BALANCE\r\n\r\n${body}`;
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
  rail: "x402" | "mpp";
  payer: string;
  amountUsd: string;
  facilitator: X402Facilitator;
  poolType: X402Class;
  maxResponseBytes: number;
  userId: string;
  amountMusd: bigint;
  pricePerGbMusd: bigint;
  pending?: X402Pending;
} | null {
  const data = (req as any).__x402;
  if (!data?.verified) return null;
  return {
    rail: data.rail === "mpp" ? "mpp" : "x402",
    payer: data.payer,
    amountUsd: data.amountUsd,
    facilitator: data.facilitator,
    poolType: data.poolType,
    maxResponseBytes: data.maxResponseBytes ?? 10_485_760,
    userId: data.userId,
    amountMusd: data.amountMusd,
    pricePerGbMusd: data.pricePerGbMusd,
    pending: data.pending,
  };
}

// ─── MPP (Machine Payments Protocol, Tempo charge) ──────────────────
//
// Same ordering as x402: verify (claims the on-chain proof) → payer identity →
// [caller: select node / lock snapshot / open stream] → settle → relay.
// A post-settle failure refunds the payer's wallet-identity user.

let mppRail: MppRail | null = null;
/** Lazily built from env (MPP_* vars); disabled unless fully configured. */
export function getMppRail(): MppRail {
  return (mppRail ??= mppRailFromEnv());
}
/** Test hook. */
export function setMppRailForTest(r: MppRail | null): void {
  mppRail = r;
}

export function hasMppCredential(h: http.IncomingHttpHeaders): boolean {
  const r = getMppRail();
  return r.enabled() && r.parseHeader(h) !== null;
}

/** Lowercase EVM payers; keep case-sensitive (Solana base58) payers as-is. */
export function normalizePayer(p: string): string {
  return /^0x/i.test(p) ? p.toLowerCase() : p;
}

function advertisedMppChallenge(poolType: X402Class) {
  const r = getMppRail();
  if (!r.enabled()) return null;
  quote(poolType).catch(() => undefined);
  const q = lastQuote.get(poolType);
  return q ? r.challenge(q.amountMusd) : null;
}

function musdToUsd(m: bigint): string {
  return `${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, "0")}`;
}

type MppOutcome =
  | { ok: false; status: number; code: string; message: string; challenge?: string }
  | { ok: true; q: X402Quote; pending: X402Pending };

async function verifyMppRequest(req: http.IncomingMessage): Promise<MppOutcome> {
  const rail = getMppRail();
  const cred = rail.parseHeader(req.headers);
  if (!cred) return { ok: false, status: 402, code: "MPP_PAYMENT_INVALID", message: "malformed-credential" };
  const clientIp = (req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (clientIp && !checkX402RateLimit(`ip:${clientIp}`)) {
    return { ok: false, status: 429, code: "X402_RATE_LIMITED", message: "Too many paid requests from this IP. Please wait." };
  }
  const poolType = getPoolTypeFromRequest(req);
  let q: X402Quote;
  try {
    q = await quote(poolType);
  } catch {
    return { ok: false, status: 503, code: "SERVICE_UNAVAILABLE", message: "Pricing temporarily unavailable" };
  }
  const fresh = () => rail.challenge(q.amountMusd)?.header;
  const v = await rail.verify(cred, { amountMusd: q.amountMusd, resource: "relay" });
  if (!v.ok || !v.payer || v.amountMusd === undefined) {
    log.warn("mpp payment verification failed", { reason: (v.reason ?? "").slice(0, 80) });
    return { ok: false, status: 402, code: "MPP_PAYMENT_INVALID", message: v.reason ?? "verification-failed", challenge: fresh() };
  }
  const release = () => rail.release(v.paymentHash).catch(() => {});
  if (v.amountMusd < q.amountMusd || v.amountMusd > maxPaidMusd(q)) {
    await release();
    return { ok: false, status: 402, code: "MPP_PAYMENT_INVALID", message: "payment-insufficient", challenge: fresh() };
  }
  const who = await resolvePayer(v.payer);
  if (!who.ok) {
    await release();
    return { ok: false, status: who.status, code: who.code, message: who.message };
  }
  if (!checkX402RateLimit(`payer:${v.payer}`)) {
    await release();
    return { ok: false, status: 429, code: "X402_RATE_LIMITED", message: "Too many paid requests from this payer. Please wait." };
  }
  const pending: X402Pending = {
    rail: "mpp", paymentHeader: "", payHash: v.paymentHash, mppVerified: v, payer: v.payer,
    amountUsd: musdToUsd(v.amountMusd), poolType, userId: who.userId, paidMusd: v.amountMusd, state: "verified",
  };
  return { ok: true, q, pending };
}

async function settleMppPending(p: X402Pending): Promise<boolean> {
  const rail = getMppRail();
  let r: { ok: boolean; txRef?: string };
  try {
    r = await rail.settle("", { amountMusd: p.paidMusd, resource: "relay" }, p.mppVerified ?? { ok: false, paymentHash: p.payHash });
  } catch {
    r = { ok: false };
  }
  if (!r.ok) {
    log.error("mpp settlement failed — rejecting request", { payer: p.payer.slice(0, 10) + "..." });
    await releaseX402Pending(p);
    return false;
  }
  p.state = "settled";
  log.info("mpp payment settled", { payer: p.payer.slice(0, 10) + "...", amountUsd: p.amountUsd, poolType: p.poolType });
  return true;
}

async function handleMppHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const o = await verifyMppRequest(req);
  if (!o.ok) {
    const h: Record<string, string> = { "Content-Type": "application/json", "X-DominusNode-Error": o.code };
    if (o.status === 402) h["Cache-Control"] = "no-store";
    if (o.challenge) h["WWW-Authenticate"] = o.challenge;
    if (o.status === 429 || o.status === 503) h["Retry-After"] = o.status === 429 ? "60" : "30";
    res.writeHead(o.status, h);
    res.end(JSON.stringify({ error: o.code, message: o.message }));
    return true;
  }
  const p = o.pending;
  (req as any).__x402 = {
    verified: true, rail: "mpp", payer: p.payer, userId: p.userId, amountUsd: p.amountUsd, amountMusd: p.paidMusd,
    pricePerGbMusd: o.q.pricePerGbMusd, facilitator: undefined, poolType: p.poolType, settled: false,
    maxResponseBytes: paidByteCap(o.q, p.paidMusd), pending: p,
  };
  return true;
}

async function handleMppConnect(req: http.IncomingMessage, clientSocket: net.Socket): Promise<X402ConnectResult> {
  const o = await verifyMppRequest(req);
  if (!o.ok) {
    const lines = [`HTTP/1.1 ${o.status} ${http.STATUS_CODES[o.status] ?? "Error"}`, `X-DominusNode-Error: ${o.code}`];
    if (o.status === 402) lines.push("Cache-Control: no-store");
    if (o.challenge) lines.push(`WWW-Authenticate: ${o.challenge}`);
    if (o.status === 429) lines.push("Retry-After: 60");
    if (!clientSocket.destroyed) {
      clientSocket.write(lines.join("\r\n") + "\r\n\r\n");
      clientSocket.end();
    }
    return { rail: "mpp", handled: true, verified: false, payer: "", facilitator: "coinbase", poolType: "any", paymentHeader: "", amountUsd: "0", maxResponseBytes: 0 };
  }
  const p = o.pending;
  return {
    rail: "mpp", handled: true, verified: true, payer: p.payer, facilitator: "coinbase", poolType: p.poolType, paymentHeader: "",
    amountUsd: p.amountUsd, maxResponseBytes: paidByteCap(o.q, p.paidMusd), userId: p.userId, amountMusd: p.paidMusd,
    pricePerGbMusd: o.q.pricePerGbMusd, pending: p,
  };
}
