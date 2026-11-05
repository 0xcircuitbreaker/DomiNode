import { usageRepo, walletRepo, planRepo, teamRepo, policyRepo, tierRepo, relayChargeRepo, createLogger } from "@dominusnode/shared";
import type { Plan, NodeIpClass } from "@dominusnode/shared";
import { BYTES_PER_GB } from "@dominusnode/shared";
import { recordRequesterSpend } from "./policy-enforcer.js";
import { invalidateBalanceCache, invalidateTeamBalanceCache } from "./balance-check.js";
import { recordBytes, recordSessionStart } from "./stats.js";
import type { ByteCounter } from "./counting-stream.js";
import { getUserConnCount } from "./connection-tracker.js";

const log = createLogger("proxy:session");

const MUSD_PER_CENT = 10_000;

// Per-session byte cap (DESIGN.md §8). The reservation is sized to cover this
// cap at the locked relay price, capped at the available balance:
//   reserveCents = min(balance, ceil(price × byteCap))
// and the session may never carry more bytes than its reservation pays for.
const SESSION_BYTE_CAP = parseInt(process.env["RELAY_SESSION_BYTE_CAP"] ?? "1073741824", 10); // default 1 GiB (= BYTES_PER_GB)
if (isNaN(SESSION_BYTE_CAP) || SESSION_BYTE_CAP < 1024 * 1024 || SESSION_BYTE_CAP > 100 * 1024 * 1024 * 1024) {
  throw new Error("RELAY_SESSION_BYTE_CAP must be between 1MB and 100GB");
}

/** ceil(price × byteCap) in cents; at least 1 cent for a non-zero price. */
export function reservationCentsFor(pricePerGbMusd: bigint, byteCap: number = SESSION_BYTE_CAP): number {
  if (pricePerGbMusd <= 0n) return 0;
  const num = pricePerGbMusd * BigInt(byteCap);
  const den = BigInt(BYTES_PER_GB) * BigInt(MUSD_PER_CENT);
  const cents = (num + den - 1n) / den;
  return Number(cents > 0n ? cents : 1n);
}

/** Bytes a reservation pays for at the locked price (floor; no overrun headroom). */
export function maxBytesForReservation(reservedCents: number, pricePerGbMusd: bigint): number {
  if (pricePerGbMusd <= 0n || reservedCents <= 0) return 0;
  const b = (BigInt(reservedCents) * BigInt(MUSD_PER_CENT) * BigInt(BYTES_PER_GB)) / pricePerGbMusd;
  return Number(b > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : b);
}

/** Node binding for a relay session (DESIGN.md §8). */
export interface RelayBinding {
  nodeId: string;
  ipClass: NodeIpClass;
  nodeOwnerUserId: string;
  destPort: number;
  requesterWallet?: string | null;
  /** Node-reported byte total from its CLOSE frame, once received (null until then). */
  nodeBytes?: () => bigint | null;
}

type ChargeSnapshot = Awaited<ReturnType<typeof tierRepo.getChargeSnapshot>>;


interface ActiveSession {
  sessionId: string;
  userId: string;
  targetHost: string;
  startedAt: Date;
  counter: ByteCounter;
  reservedCents: number;
  connectLatencyMs: number;
  errorCount: number;
  pricePerGbCents: number; // Locked at session start to prevent plan-switch gaming
  proxyType: string; // Track provider pool type (dc/residential) for usage records
  teamId: string | null; // When set, billing goes to team wallet
  relay: RelayBinding;
  destHost: string; // Bare host for relay_abuse_log (metadata only)
  pricePerGbMusd: bigint; // network_pricing for the node class, locked at start
  snapshot: ChargeSnapshot; // owner tier share + split config, locked at start
  /** x402/mpp: paid up front; settled as gross = paidMusd, no wallet movement. */
  prepaid?: { rail: "x402" | "mpp"; paidMusd: bigint };
}

const activeSessions = new Map<string, ActiveSession>();

// Socket destroy callbacks registered per session for forced termination.
// When admin suspends a user, we call these to close the TCP connections.
const sessionDestroyCallbacks = new Map<string, () => void>();

// Per-user session rate limiter: max new sessions per minute
const MAX_SESSIONS_PER_MINUTE = parseInt(process.env["MAX_SESSIONS_PER_MINUTE"] ?? "30", 10);
if (isNaN(MAX_SESSIONS_PER_MINUTE) || MAX_SESSIONS_PER_MINUTE <= 0) {
  throw new Error("MAX_SESSIONS_PER_MINUTE must be a positive integer");
}

// AI agents get higher session rate limits (default 10x)
const AGENT_RATE_LIMIT_MULTIPLIER = parseInt(process.env["AGENT_RATE_LIMIT_MULTIPLIER"] ?? "10", 10);
if (isNaN(AGENT_RATE_LIMIT_MULTIPLIER) || AGENT_RATE_LIMIT_MULTIPLIER < 1 || AGENT_RATE_LIMIT_MULTIPLIER > 100) {
  throw new Error("AGENT_RATE_LIMIT_MULTIPLIER must be between 1 and 100");
}
const MAX_RATE_LIMIT_MAP_SIZE = 50_000;
const sessionCreationLog = new Map<string, number[]>(); // userId -> timestamps

// ─── Per-user bandwidth velocity tracking ────────────────────────────
// Prevents a single user from monopolizing upstream bandwidth.
// Tracks bytes transferred per user over a rolling 1-hour window.
// Default: 10 GB/hour per user (configurable via MAX_BANDWIDTH_PER_HOUR_BYTES)
const MAX_BANDWIDTH_PER_HOUR_BYTES = parseInt(
  process.env["MAX_BANDWIDTH_PER_HOUR_BYTES"] ?? String(10 * 1024 * 1024 * 1024), // 10 GB
  10,
);
if (isNaN(MAX_BANDWIDTH_PER_HOUR_BYTES) || MAX_BANDWIDTH_PER_HOUR_BYTES <= 0) {
  throw new Error("MAX_BANDWIDTH_PER_HOUR_BYTES must be a positive integer");
}
const BANDWIDTH_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_BANDWIDTH_MAP_SIZE = 50_000;
const MAX_RECORDS_PER_USER = 10_000; // Cap per-user records to prevent OOM
const bandwidthLog = new Map<string, Array<{ timestamp: number; bytes: number }>>(); // userId -> records

export function recordBandwidthUsage(userId: string, bytes: number): void {
  let records = bandwidthLog.get(userId);
  if (!records) {
    if (bandwidthLog.size >= MAX_BANDWIDTH_MAP_SIZE) {
      const firstKey = bandwidthLog.keys().next().value;
      if (firstKey) bandwidthLog.delete(firstKey);
    }
    records = [];
    bandwidthLog.set(userId, records);
  }
  // Evict oldest record when per-user cap is reached
  if (records.length >= MAX_RECORDS_PER_USER) {
    records.shift();
  }
  records.push({ timestamp: Date.now(), bytes });
}

export function checkBandwidthVelocity(userId: string): { allowed: boolean; usedBytes: number; limitBytes: number } {
  const now = Date.now();
  const records = bandwidthLog.get(userId);
  if (!records) return { allowed: true, usedBytes: 0, limitBytes: MAX_BANDWIDTH_PER_HOUR_BYTES };

  // Trim old records
  while (records.length > 0 && records[0].timestamp < now - BANDWIDTH_WINDOW_MS) {
    records.shift();
  }
  if (records.length === 0) {
    bandwidthLog.delete(userId);
    return { allowed: true, usedBytes: 0, limitBytes: MAX_BANDWIDTH_PER_HOUR_BYTES };
  }

  const totalBytes = records.reduce((sum, r) => sum + r.bytes, 0);
  return {
    allowed: totalBytes < MAX_BANDWIDTH_PER_HOUR_BYTES,
    usedBytes: totalBytes,
    limitBytes: MAX_BANDWIDTH_PER_HOUR_BYTES,
  };
}

// Cleanup bandwidth log entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [userId, records] of bandwidthLog) {
    while (records.length > 0 && records[0].timestamp < now - BANDWIDTH_WINDOW_MS) {
      records.shift();
    }
    if (records.length === 0) bandwidthLog.delete(userId);
  }
}, 300_000).unref();

export function checkSessionRateLimit(userId: string, planLimit?: number, isAgent?: boolean): boolean {
  const baseLimit = planLimit ?? MAX_SESSIONS_PER_MINUTE;
  const limit = isAgent ? baseLimit * AGENT_RATE_LIMIT_MULTIPLIER : baseLimit;
  const now = Date.now();
  const windowMs = 60_000;
  let timestamps = sessionCreationLog.get(userId);
  if (!timestamps) {
    // Evict oldest entry if map is too large
    if (sessionCreationLog.size >= MAX_RATE_LIMIT_MAP_SIZE) {
      const firstKey = sessionCreationLog.keys().next().value;
      if (firstKey) sessionCreationLog.delete(firstKey);
    }
    timestamps = [];
    sessionCreationLog.set(userId, timestamps);
  }
  // Remove entries outside the window
  while (timestamps.length > 0 && timestamps[0] < now - windowMs) {
    timestamps.shift();
  }
  if (timestamps.length >= limit) {
    return false; // rate limited
  }
  timestamps.push(now);
  return true;
}

// Periodically clean up stale rate-limit entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of sessionCreationLog) {
    while (timestamps.length > 0 && timestamps[0] < now - 60_000) {
      timestamps.shift();
    }
    if (timestamps.length === 0) sessionCreationLog.delete(userId);
  }
}, 300_000).unref();

// ─── Free tier bandwidth reservation ─────────────────────────────
// Tracks in-flight bytes reserved per user for free-plan sessions.
// Prevents concurrent sessions from exceeding the monthly bandwidth limit.
const FREE_TIER_RESERVATION_BYTES = 50 * 1024 * 1024; // 50MB per session reservation
const MAX_FREE_RESERVATIONS = 100_000; // Size cap to prevent OOM
const freeReservations = new Map<string, number>(); // userId -> reserved bytes

function reserveFreeBandwidth(userId: string, planBandwidthBytes: number, currentUsage: number): boolean {
  const reserved = freeReservations.get(userId) ?? 0;
  if (currentUsage + reserved + FREE_TIER_RESERVATION_BYTES > planBandwidthBytes) {
    return false;
  }
  // Reject if map is at capacity and this is a new entry (existing users can still reserve)
  if (!freeReservations.has(userId) && freeReservations.size >= MAX_FREE_RESERVATIONS) {
    log.warn("freeReservations map at capacity, rejecting new entry", {
      userId,
      mapSize: freeReservations.size,
      cap: MAX_FREE_RESERVATIONS,
    });
    return false;
  }
  freeReservations.set(userId, reserved + FREE_TIER_RESERVATION_BYTES);
  return true;
}

function releaseFreeBandwidth(userId: string): void {
  const reserved = freeReservations.get(userId) ?? 0;
  const newReserved = reserved - FREE_TIER_RESERVATION_BYTES;
  if (newReserved <= 0) {
    freeReservations.delete(userId);
  } else {
    freeReservations.set(userId, newReserved);
  }
}

// Parse MAX_ACTIVE_SESSIONS once at module level (was parsed on every startSession call)
const MAX_ACTIVE_SESSIONS = parseInt(process.env["MAX_ACTIVE_SESSIONS"] ?? "100000", 10);
if (isNaN(MAX_ACTIVE_SESSIONS) || MAX_ACTIVE_SESSIONS <= 0) {
  throw new Error("MAX_ACTIVE_SESSIONS must be a positive integer");
}

const STALE_CLEANUP_INTERVAL_MS = parseInt(process.env["PROXY_STALE_CLEANUP_INTERVAL_MS"] ?? "60000", 10);
const SESSION_MAX_AGE_MS = parseInt(process.env["PROXY_SESSION_MAX_AGE_MS"] ?? "3600000", 10);

if (isNaN(STALE_CLEANUP_INTERVAL_MS) || STALE_CLEANUP_INTERVAL_MS < 1000) {
  throw new Error("PROXY_STALE_CLEANUP_INTERVAL_MS must be a number >= 1000");
}
if (isNaN(SESSION_MAX_AGE_MS) || SESSION_MAX_AGE_MS < 60000) {
  throw new Error("PROXY_SESSION_MAX_AGE_MS must be a number >= 60000");
}

// Cleanup stale sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activeSessions) {
    if (now - session.startedAt.getTime() > SESSION_MAX_AGE_MS) {
      log.warn("cleaning up stale session", { sessionId: id });
      // Close the sockets too: billing settles now, so any traffic after the
      // sweep would otherwise flow unbilled up to counter.maxBytes.
      const destroyFn = sessionDestroyCallbacks.get(id);
      endSession(id).catch((err) => {
        log.error("stale session cleanup failed", {
          sessionId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      if (destroyFn) {
        try { destroyFn(); } catch { /* best effort */ }
      }
    }
  }
}, STALE_CLEANUP_INTERVAL_MS).unref();

/**
 * Start a proxy session with upfront balance reservation.
 * Throws if insufficient balance (caller should return 402).
 */
export async function startSession(
  userId: string,
  targetHost: string,
  counter: ByteCounter,
  connectLatencyMs: number = 0,
  relay: RelayBinding, // Selected node; price + tier share are locked from it
  preloadedPlan?: Plan, // Accept pre-fetched plan to prevent TOCTOU double-fetch
  logTargetHosts: boolean = false, // Privacy-first: only store targetHost when user opts in
  teamId?: string | null, // When set, billing goes to team wallet
  isAgent?: boolean, // AI agents get higher rate limits via AGENT_RATE_LIMIT_MULTIPLIER
): Promise<string> {
  const proxyType = "relay";
  // Per-user bandwidth velocity check: prevent monopolizing upstream
  const velocity = checkBandwidthVelocity(userId);
  if (!velocity.allowed) {
    const usedGB = (velocity.usedBytes / (1024 * 1024 * 1024)).toFixed(2);
    const limitGB = (velocity.limitBytes / (1024 * 1024 * 1024)).toFixed(0);
    throw new Error(`Bandwidth velocity limit exceeded: ${usedGB}GB used in last hour (limit: ${limitGB}GB/hour)`);
  }

  // Use pre-fetched plan if available — eliminates TOCTOU from double getUserPlan
  let pricePerGbCents = 500; // default PAYG rate
  let planSessionLimit: number | undefined;
  let planMaxConns: number | undefined;
  let planMonthlyBandwidthBytes = 0; // Hoisted for reuse in free-tier block below
  let monthlyUsage = 0; // Hoisted — single fetch, reused in free-tier reservation block
  try {
    const plan = preloadedPlan ?? await planRepo.getUserPlan(userId);
    pricePerGbCents = plan.pricePerGbCents;
    planSessionLimit = plan.maxSessionsPerMinute;
    planMaxConns = plan.maxConnections;
    planMonthlyBandwidthBytes = plan.monthlyBandwidthBytes;

    // Check plan bandwidth limit before allowing session
    if (plan.monthlyBandwidthBytes > 0) {
      monthlyUsage = await planRepo.getMonthlyUsage(userId);
      if (monthlyUsage >= plan.monthlyBandwidthBytes) {
        throw new Error("Monthly bandwidth limit exceeded");
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("bandwidth limit")) {
      throw err;
    }
    // FAIL CLOSED — do not allow sessions when plan cannot be determined
    // Falling through with default pricing bypasses bandwidth limits and rate limits
    log.error("failed to check plan, rejecting session", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error("Unable to verify plan. Please try again.");
  }

  // Lock relay price (per node class) and owner tier share at session start.
  // FAIL CLOSED: no session without a price and a split snapshot.
  let pricePerGbMusd: bigint;
  let snapshot: ChargeSnapshot;
  try {
    pricePerGbMusd = await policyRepo.getPricing(relay.ipClass === "unknown" ? "any" : relay.ipClass);
    snapshot = await tierRepo.getChargeSnapshot(relay.nodeOwnerUserId);
  } catch (err) {
    log.error("failed to lock relay pricing, rejecting session", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error("Unable to lock relay pricing. Please try again.");
  }

  // Per-user session rate limiting — uses plan-specific limit when available
  // AI agents (agentic wallet users) get higher limits via AGENT_RATE_LIMIT_MULTIPLIER
  if (!checkSessionRateLimit(userId, planSessionLimit, isAgent)) {
    throw new Error("Session rate limit exceeded");
  }

  // Defense-in-depth: verify active connection count is within plan limit.
  // Primary enforcement is in server.ts/socks5.ts via incrementUserConns().
  // This guard prevents bypass if startSession() is called without that check.
  if (planMaxConns != null && planMaxConns > 0) {
    if (getUserConnCount(userId) > planMaxConns) {
      throw new Error("Too many concurrent connections");
    }
  }

  // Free plan needs in-memory bandwidth reservation to prevent concurrent session abuse
  const isFreePlan = pricePerGbCents === 0;
  let reservedCents = 0;
  let freeReserved = false;

  if (isFreePlan) {
    // Free plan MUST have a bandwidth limit — 0 = unlimited = abuse vector
    if (planMonthlyBandwidthBytes <= 0) {
      throw new Error("Free plan must have a bandwidth limit configured");
    }
    // Reuse planMonthlyBandwidthBytes from the single fetch above (no second getUserPlan call)
    // Reuse monthlyUsage from the single fetch above (no second getMonthlyUsage call)
    try {
      if (planMonthlyBandwidthBytes > 0) {
        if (!reserveFreeBandwidth(userId, planMonthlyBandwidthBytes, monthlyUsage)) {
          throw new Error("Monthly bandwidth limit exceeded (including active sessions)");
        }
        freeReserved = true;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("bandwidth limit")) throw err;
      throw err;
    }
  } else if (teamId) {
    // Team billing: reserve from team wallet instead of personal wallet
    const balance = await teamRepo.getTeamBalance(teamId);
    const want = Math.min(balance, reservationCentsFor(pricePerGbMusd));
    const teamWalletId = want > 0 ? await teamRepo.reserveTeamBalance(teamId, want) : null;
    if (!teamWalletId) {
      invalidateTeamBalanceCache(teamId);
      throw new Error("Insufficient balance for reservation");
    }
    reservedCents = want;
    invalidateTeamBalanceCache(teamId);
  } else {
    // C1 fix: Reserve balance BEFORE creating session — no free proxy usage
    const balance = await walletRepo.getBalance(userId);
    const want = Math.min(balance, reservationCentsFor(pricePerGbMusd));
    const walletId = want > 0 ? await walletRepo.reserveBalance(userId, want) : null;
    if (!walletId) {
      // Invalidate stale balance cache so next request re-checks DB
      invalidateBalanceCache(userId);
      throw new Error("Insufficient balance for reservation");
    }
    reservedCents = want;
    invalidateBalanceCache(userId);
  }

  let dbSession;
  try {
    dbSession = await usageRepo.createRelaySession(userId, relay.nodeId, relay.destPort);
  } catch (err) {
    // If DB session creation fails, release the reservation
    if (reservedCents > 0) {
      if (teamId) {
        await teamRepo.releaseTeamReservation(teamId, reservedCents);
        invalidateTeamBalanceCache(teamId);
      } else {
        await walletRepo.releaseReservation(userId, reservedCents);
        invalidateBalanceCache(userId);
      }
    }
    if (freeReserved) {
      releaseFreeBandwidth(userId);
    }
    throw err;
  }

  const sessionId = dbSession.id;

  // Privacy-first: only store actual targetHost when user has opted in
  const storedTargetHost = logTargetHosts ? targetHost : "";

  // Cap active sessions to prevent OOM from session accumulation
  // MAX_ACTIVE_SESSIONS hoisted to module-level constant
  if (activeSessions.size >= MAX_ACTIVE_SESSIONS) {
    // Release reservation before rejecting
    if (reservedCents > 0) {
      if (teamId) {
        await teamRepo.releaseTeamReservation(teamId, reservedCents);
        invalidateTeamBalanceCache(teamId);
      } else {
        await walletRepo.releaseReservation(userId, reservedCents);
        invalidateBalanceCache(userId);
      }
    }
    if (freeReserved) releaseFreeBandwidth(userId);
    throw new Error("Server at capacity. Please try again later.");
  }

  activeSessions.set(sessionId, {
    sessionId,
    userId,
    targetHost: storedTargetHost,
    startedAt: new Date(),
    counter,
    reservedCents,
    connectLatencyMs,
    errorCount: 0,
    pricePerGbCents,
    proxyType,
    teamId: teamId ?? null,
    relay,
    destHost: targetHost.includes(":") && !targetHost.startsWith("[") ? `[${targetHost}]` : (targetHost || "unknown"),
    pricePerGbMusd,
    snapshot,
  });

  // Set per-session byte limit to prevent unbounded usage beyond reservation
  // Paid sessions: cap at exactly what the reservation covers (no overrun headroom,
  // so settlement is never partial and the node is paid for every byte it carried)
  // Free sessions: cap at remaining plan bandwidth
  if (!isFreePlan && pricePerGbCents > 0) {
    counter.maxBytes = Math.max(maxBytesForReservation(reservedCents, pricePerGbMusd), 1); // 0 would mean unlimited
    counter.onLimitExceeded = () => {
      log.warn("session byte limit exceeded, terminating", { sessionId, userId, maxBytes: counter.maxBytes });
      endSession(sessionId).catch(() => {});
      // The socket destroy callback will close the connection
      const destroyFn = sessionDestroyCallbacks.get(sessionId);
      if (destroyFn) {
        try { destroyFn(); } catch { /* best effort */ }
      }
    };
  } else if (isFreePlan && planMonthlyBandwidthBytes > 0) {
    // Free plan: cap session at remaining bandwidth
    // Don't give 1MB floor when bandwidth is exhausted — reject at session start instead
    // Cap at this session's reservation so concurrent sessions cannot each
    // consume the whole remaining quota.
    const remainingBytes = Math.max(0, planMonthlyBandwidthBytes - monthlyUsage);
    counter.maxBytes = Math.max(Math.min(remainingBytes, FREE_TIER_RESERVATION_BYTES), 1024); // at least 1KB (for small API responses)
    counter.onLimitExceeded = () => {
      log.warn("free plan byte limit exceeded, terminating", { sessionId, userId, maxBytes: counter.maxBytes });
      endSession(sessionId).catch(() => {});
      const destroyFn = sessionDestroyCallbacks.get(sessionId);
      if (destroyFn) {
        try { destroyFn(); } catch { /* best effort */ }
      }
    };
  }

  recordSessionStart();

  // Redact full hostname from logs to protect user privacy
  const redactedHost = targetHost.split(".").slice(-2).join(".");
  log.info("session started", { sessionId, userId, targetHost: redactedHost, reservedCents });
  return sessionId;
}

/** Bytes a prepaid amount buys at the locked price (floor). */
export function maxBytesForPrepaid(paidMusd: bigint, pricePerGbMusd: bigint): number {
  if (pricePerGbMusd <= 0n || paidMusd <= 0n) return 0;
  const b = (paidMusd * BigInt(BYTES_PER_GB)) / pricePerGbMusd;
  return Number(b > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : b);
}

export interface PrepaidSessionInput {
  userId: string;
  targetHost: string;
  counter: ByteCounter;
  connectLatencyMs: number;
  relay: RelayBinding;
  rail: "x402" | "mpp";
  paidMusd: bigint;
  /** Price the payment was quoted at; the session byte cap is derived from it. */
  quotedPricePerGbMusd: bigint;
  /** Additional hard byte cap (e.g. X402_MAX_RESPONSE_BYTES). */
  maxBytes: number;
}

/**
 * Start a relay session that was paid per request (x402/mpp). No balance is
 * reserved; relay_charges records gross = paid µUSD (DESIGN.md §7) and the
 * session may carry at most the bytes the payment bought.
 */
export async function startPrepaidSession(i: PrepaidSessionInput): Promise<string> {
  if (typeof i.paidMusd !== "bigint" || i.paidMusd < 1n) throw new Error("Invalid prepaid amount");
  let snapshot: ChargeSnapshot;
  try {
    snapshot = await tierRepo.getChargeSnapshot(i.relay.nodeOwnerUserId);
  } catch {
    throw new Error("Unable to lock relay pricing. Please try again.");
  }
  if (activeSessions.size >= MAX_ACTIVE_SESSIONS) throw new Error("Server at capacity. Please try again later.");
  const dbSession = await usageRepo.createRelaySession(i.userId, i.relay.nodeId, i.relay.destPort);
  const sessionId = dbSession.id;
  const host = i.targetHost;
  activeSessions.set(sessionId, {
    sessionId,
    userId: i.userId,
    targetHost: "", // x402 identities never opt in to host logging
    startedAt: new Date(),
    counter: i.counter,
    reservedCents: 0,
    connectLatencyMs: i.connectLatencyMs,
    errorCount: 0,
    pricePerGbCents: 1, // non-free marker
    proxyType: "relay",
    teamId: null,
    relay: i.relay,
    destHost: host.includes(":") && !host.startsWith("[") ? `[${host}]` : (host || "unknown"),
    pricePerGbMusd: i.quotedPricePerGbMusd,
    snapshot,
    prepaid: { rail: i.rail, paidMusd: i.paidMusd },
  });
  const paidBytes = maxBytesForPrepaid(i.paidMusd, i.quotedPricePerGbMusd);
  i.counter.maxBytes = Math.max(1, Math.min(paidBytes, i.maxBytes)); // 0 would mean unlimited
  i.counter.onLimitExceeded = () => {
    log.warn("prepaid session byte cap reached", { sessionId, maxBytes: i.counter.maxBytes });
    endSession(sessionId).catch(() => {});
    const destroyFn = sessionDestroyCallbacks.get(sessionId);
    if (destroyFn) {
      try { destroyFn(); } catch { /* best effort */ }
    }
  };
  recordSessionStart();
  log.info("prepaid session started", { sessionId, rail: i.rail, paidMusd: i.paidMusd.toString() });
  return sessionId;
}

/**
 * End a proxy session: settle reservation vs actual cost.
 * If actual < reserved, refunds the difference.
 * If actual > reserved, charges the difference (may partially fail).
 */
function readNodeBytes(relay: RelayBinding): bigint | null {
  try {
    const v = relay.nodeBytes?.() ?? null;
    return v != null && v >= 0n && v <= 1_099_511_627_776n ? v : null;
  } catch {
    return null;
  }
}

export async function endSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  // Fix #8: Atomic check-and-remove to prevent TOCTOU race
  if (!activeSessions.delete(sessionId)) return;

  const { userId, counter, reservedCents, pricePerGbCents, teamId, relay } = session;
  const totalBytes = counter.bytesIn + counter.bytesOut;

  // Record bandwidth for velocity tracking (prevents single user from monopolizing)
  if (totalBytes > 0) {
    recordBandwidthUsage(userId, totalBytes);
    recordBytes(counter.bytesIn, counter.bytesOut);
  }

  // Release free tier bandwidth reservation on session end
  if (pricePerGbCents === 0) {
    releaseFreeBandwidth(userId);
  }

  const rail = session.prepaid ? session.prepaid.rail : pricePerGbCents === 0 ? "free" : teamId ? "team" : "wallet";

  try {
    // One transaction: requester settle, relay_charges, node earn, abuse log,
    // session end and usage record (DESIGN.md §6.3). Bytes are gateway-measured.
    const r = await relayChargeRepo.settleRelayCharge({
      sessionId,
      requesterUserId: userId,
      requesterWallet: relay.requesterWallet ?? null,
      requesterTeamId: teamId,
      rail,
      reservedCents,
      nodeId: relay.nodeId,
      bytesGateway: BigInt(totalBytes),
      bytesNode: readNodeBytes(relay),
      bytesIn: counter.bytesIn,
      bytesOut: counter.bytesOut,
      pricePerGbMusd: session.pricePerGbMusd,
      snapshot: session.snapshot,
      destHost: session.destHost,
      destPort: relay.destPort,
      usageTargetHost: session.targetHost, // "" unless logTargetHosts (privacy-first)
      ...(session.prepaid ? { prepaidGrossMusd: session.prepaid.paidMusd } : {}),
    });
    if (session.prepaid) { /* no wallet movement */ }
    else if (teamId) invalidateTeamBalanceCache(teamId);
    else invalidateBalanceCache(userId);
    recordRequesterSpend(userId, r.grossMusd);

    if (!r.paidInFull) {
      log.error("session settlement partial — unpaid usage", { sessionId, userId, totalBytes, debitCents: r.debitCents, reservedCents });
      return;
    }
    log.info("session ended", { sessionId, userId, totalBytes, debitCents: r.debitCents, reservedCents, rail });
  } catch (err) {
    log.error("session end failed", {
      sessionId,
      userId,
      totalBytes,
      reservedCents,
      error: err instanceof Error ? err.message : String(err),
    });

    // On unexpected error, reservation stays debited (safe default for business).
    // Mark session as error in DB.
    try {
      await usageRepo.endSession(sessionId, totalBytes, "error");
    } catch {
      // Best effort
    }
  }
}

export function getActiveSessionCount(): number {
  return activeSessions.size;
}

export function getActiveSessions(userId?: string): Array<{
  sessionId: string;
  userId: string;
  targetHost: string;
  startedAt: Date;
  bytesIn: number;
  bytesOut: number;
  connectLatencyMs: number;
  errorCount: number;
}> {
  const results: Array<{
    sessionId: string;
    userId: string;
    targetHost: string;
    startedAt: Date;
    bytesIn: number;
    bytesOut: number;
    connectLatencyMs: number;
    errorCount: number;
  }> = [];

  for (const session of activeSessions.values()) {
    if (userId && session.userId !== userId) continue;
    // Redact full target hostname — only expose TLD+1 to protect user browsing privacy
    const hostParts = session.targetHost.split(".");
    const redactedHost = hostParts.length > 2 ? hostParts.slice(-2).join(".") : session.targetHost;
    results.push({
      sessionId: session.sessionId,
      userId: session.userId,
      targetHost: redactedHost,
      startedAt: session.startedAt,
      bytesIn: session.counter.bytesIn,
      bytesOut: session.counter.bytesOut,
      connectLatencyMs: session.connectLatencyMs,
      errorCount: session.errorCount,
    });
  }

  return results;
}

/**
 * Register a destroy callback for a session.
 * Called by server.ts / socks5.ts when setting up a tunnel,
 * so that terminateUserSessions can forcibly close the sockets.
 */
export function registerSessionDestroy(sessionId: string, destroyFn: () => void): void {
  sessionDestroyCallbacks.set(sessionId, destroyFn);
}

/**
 * Unregister a destroy callback (called when session ends normally).
 */
export function unregisterSessionDestroy(sessionId: string): void {
  sessionDestroyCallbacks.delete(sessionId);
}

/**
 * Forcibly terminate all active sessions for a user.
 * Used by admin suspend to immediately cut off proxy access.
 * Returns the number of sessions terminated.
 */
export async function terminateUserSessions(userId: string): Promise<number> {
  const userSessions: string[] = [];
  for (const [id, session] of activeSessions) {
    if (session.userId === userId) {
      userSessions.push(id);
    }
  }

  let terminated = 0;
  for (const sessionId of userSessions) {
    // Settle billing FIRST, then destroy sockets.
    // This ensures endSession() sees the session in activeSessions before the
    // close-event handler (triggered by socket.destroy()) races to call it.
    try {
      await endSession(sessionId);
      terminated++;
    } catch (err) {
      log.error("forced session termination failed", {
        sessionId,
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Destroy the socket connections AFTER billing settlement
    const destroyFn = sessionDestroyCallbacks.get(sessionId);
    if (destroyFn) {
      try {
        destroyFn();
      } catch {
        // Best effort socket destruction — socket.destroy() is synchronous
        // and may throw if the socket is already in a bad state
      }
      sessionDestroyCallbacks.delete(sessionId);
    }
  }

  if (terminated > 0) {
    log.info("terminated user sessions", { userId, terminated, total: userSessions.length });
  }
  return terminated;
}
