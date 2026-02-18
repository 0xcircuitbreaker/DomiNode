import { usageRepo, walletRepo, planRepo, createLogger } from "@dominusnode/shared";
import type { Plan } from "@dominusnode/shared";
import { computeCostCents, recordUsage } from "@dominusnode/metering";
import { BYTES_PER_GB } from "@dominusnode/shared";
import { invalidateBalanceCache } from "./balance-check.js";
import { recordBytes, recordSessionStart } from "./stats.js";
import type { ByteCounter } from "./counting-stream.js";

const log = createLogger("proxy:session");

// Minimum reservation per session: 50 cents (~100MB at $5/GB)
// Increased from 10c to limit financial exposure from concurrent sessions
const MIN_RESERVATION_CENTS = 50;

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
  proxyType: string; // R20 H-5: Track provider pool type (dc/residential) for usage records
}

const activeSessions = new Map<string, ActiveSession>();

// Socket destroy callbacks registered per session for forced termination.
// When admin suspends a user, we call these to close the TCP connections.
const sessionDestroyCallbacks = new Map<string, () => void>();

// Per-user session rate limiter: max new sessions per minute
const MAX_SESSIONS_PER_MINUTE = parseInt(process.env["MAX_SESSIONS_PER_MINUTE"] ?? "30", 10);
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
const BANDWIDTH_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_BANDWIDTH_MAP_SIZE = 50_000;
const MAX_RECORDS_PER_USER = 10_000; // R21 H-2: Cap per-user records to prevent OOM
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
  // R21 H-2: Evict oldest record when per-user cap is reached
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

export function checkSessionRateLimit(userId: string, planLimit?: number): boolean {
  const limit = planLimit ?? MAX_SESSIONS_PER_MINUTE;
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
const freeReservations = new Map<string, number>(); // userId -> reserved bytes

function reserveFreeBandwidth(userId: string, planBandwidthBytes: number, currentUsage: number): boolean {
  const reserved = freeReservations.get(userId) ?? 0;
  if (currentUsage + reserved + FREE_TIER_RESERVATION_BYTES > planBandwidthBytes) {
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
      endSession(id).catch((err) => {
        log.error("stale session cleanup failed", {
          sessionId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
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
  requestedProxyType: string = "residential", // R20 H-5: Provider pool type from server.ts/socks5.ts
  preloadedPlan?: Plan, // R29 C-2: Accept pre-fetched plan to prevent TOCTOU double-fetch
): Promise<string> {
  let proxyType = requestedProxyType;
  // Per-user bandwidth velocity check: prevent monopolizing upstream
  const velocity = checkBandwidthVelocity(userId);
  if (!velocity.allowed) {
    const usedGB = (velocity.usedBytes / (1024 * 1024 * 1024)).toFixed(2);
    const limitGB = (velocity.limitBytes / (1024 * 1024 * 1024)).toFixed(0);
    throw new Error(`Bandwidth velocity limit exceeded: ${usedGB}GB used in last hour (limit: ${limitGB}GB/hour)`);
  }

  // R29 C-2: Use pre-fetched plan if available — eliminates TOCTOU from double getUserPlan
  let pricePerGbCents = 500; // default PAYG rate
  let planSessionLimit: number | undefined;
  let planMonthlyBandwidthBytes = 0; // Hoisted for reuse in free-tier block below
  let monthlyUsage = 0; // R21 C-1: Hoisted — single fetch, reused in free-tier reservation block
  try {
    const plan = preloadedPlan ?? await planRepo.getUserPlan(userId);
    pricePerGbCents = plan.pricePerGbCents;
    planSessionLimit = plan.maxSessionsPerMinute;
    planMonthlyBandwidthBytes = plan.monthlyBandwidthBytes;

    // Enforce pool restriction from plan (Beta free-tier restructure)
    if (plan.allowedProxyTypes) {
      // Determine the requested pool from proxyType prefix
      const requestedPool = proxyType.startsWith("dc") ? "dc"
        : proxyType.startsWith("residential") ? "residential"
        : null; // "auto" or unrecognized

      if (requestedPool && requestedPool !== plan.allowedProxyTypes) {
        throw new Error(`Your plan only allows ${plan.allowedProxyTypes} proxies`);
      }

      // For "auto" prefix, force to the allowed pool
      if (!requestedPool || proxyType === "auto") {
        proxyType = plan.allowedProxyTypes;
      }
    }

    // Check plan bandwidth limit before allowing session
    if (plan.monthlyBandwidthBytes > 0) {
      monthlyUsage = await planRepo.getMonthlyUsage(userId);
      if (monthlyUsage >= plan.monthlyBandwidthBytes) {
        throw new Error("Monthly bandwidth limit exceeded");
      }
    }
  } catch (err) {
    if (err instanceof Error && (err.message.includes("bandwidth limit") || err.message.includes("only allows"))) {
      throw err;
    }
    // R22 H-2: FAIL CLOSED — do not allow sessions when plan cannot be determined
    // Falling through with default pricing bypasses bandwidth limits and rate limits
    log.error("failed to check plan, rejecting session", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error("Unable to verify plan. Please try again.");
  }

  // R18: Per-user session rate limiting — uses plan-specific limit when available
  if (!checkSessionRateLimit(userId, planSessionLimit)) {
    throw new Error("Session rate limit exceeded");
  }

  // R17: Free plan needs in-memory bandwidth reservation to prevent concurrent session abuse
  const isFreePlan = pricePerGbCents === 0;
  let reservedCents = 0;
  let freeReserved = false;

  if (isFreePlan) {
    // R24 H-5: Free plan MUST have a bandwidth limit — 0 = unlimited = abuse vector
    if (planMonthlyBandwidthBytes <= 0) {
      throw new Error("Free plan must have a bandwidth limit configured");
    }
    // R20 C-1: Reuse planMonthlyBandwidthBytes from the single fetch above (no second getUserPlan call)
    // R21 C-1: Reuse monthlyUsage from the single fetch above (no second getMonthlyUsage call)
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
  } else {
    // C1 fix: Reserve balance BEFORE creating session — no free proxy usage
    const walletId = await walletRepo.reserveBalance(userId, MIN_RESERVATION_CENTS);
    if (!walletId) {
      // R30 C-3: Invalidate stale balance cache so next request re-checks DB
      invalidateBalanceCache(userId);
      throw new Error("Insufficient balance for reservation");
    }
    reservedCents = MIN_RESERVATION_CENTS;
    invalidateBalanceCache(userId);
  }

  let dbSession;
  try {
    dbSession = await usageRepo.createSession(userId, "webshare");
  } catch (err) {
    // If DB session creation fails, release the reservation
    if (reservedCents > 0) {
      await walletRepo.releaseReservation(userId, reservedCents);
      invalidateBalanceCache(userId);
    }
    if (freeReserved) {
      releaseFreeBandwidth(userId);
    }
    throw err;
  }

  const sessionId = dbSession.id;

  activeSessions.set(sessionId, {
    sessionId,
    userId,
    targetHost,
    startedAt: new Date(),
    counter,
    reservedCents,
    connectLatencyMs,
    errorCount: 0,
    pricePerGbCents,
    proxyType,
  });

  // Set per-session byte limit to prevent unbounded usage beyond reservation
  // Paid sessions: cap at what the reservation covers (with 10% headroom for settlement)
  // Free sessions: cap at remaining plan bandwidth
  if (!isFreePlan && pricePerGbCents > 0) {
    const maxBytesForReservation = Math.floor((reservedCents / pricePerGbCents) * BYTES_PER_GB * 1.1);
    counter.maxBytes = Math.max(maxBytesForReservation, 1024 * 1024); // at least 1MB
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
    // R29 M-3: Don't give 1MB floor when bandwidth is exhausted — reject at session start instead
    const remainingBytes = Math.max(0, planMonthlyBandwidthBytes - monthlyUsage);
    counter.maxBytes = Math.max(remainingBytes, 1024); // at least 1KB (for small API responses)
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

/**
 * End a proxy session: settle reservation vs actual cost.
 * If actual < reserved, refunds the difference.
 * If actual > reserved, charges the difference (may partially fail).
 */
export async function endSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  // Fix #8: Atomic check-and-remove to prevent TOCTOU race
  if (!activeSessions.delete(sessionId)) return;

  const { userId, counter, targetHost, reservedCents, connectLatencyMs, pricePerGbCents, proxyType } = session;
  const totalBytes = counter.bytesIn + counter.bytesOut;

  // Record bandwidth for velocity tracking (prevents single user from monopolizing)
  if (totalBytes > 0) {
    recordBandwidthUsage(userId, totalBytes);
    recordBytes(counter.bytesIn, counter.bytesOut);
  }

  // R17: Release free tier bandwidth reservation on session end
  if (pricePerGbCents === 0) {
    releaseFreeBandwidth(userId);
  }

  const actualCostCents = computeCostCents(totalBytes, pricePerGbCents);

  try {
    // Record usage in DB (even for free plan — tracks bandwidth)
    await recordUsage(userId, sessionId, counter.bytesIn, counter.bytesOut, targetHost, pricePerGbCents, connectLatencyMs, proxyType);

    // Free plan: no wallet settlement needed (no reservation, no cost)
    if (reservedCents === 0 && actualCostCents === 0) {
      await usageRepo.endSession(sessionId, totalBytes, "completed");
      log.info("session ended (free)", { sessionId, userId, totalBytes });
      return;
    }

    // C1 fix: Settle — adjust from reserved amount to actual cost
    const settled = await walletRepo.settleSession(userId, reservedCents, actualCostCents, sessionId);
    invalidateBalanceCache(userId);

    if (!settled) {
      // Partial payment — user ran out of balance during overage
      log.error("session settlement partial — unpaid usage", {
        sessionId,
        userId,
        totalBytes,
        actualCostCents,
        reservedCents,
      });
      await usageRepo.endSession(sessionId, totalBytes, "error");
      return;
    }

    await usageRepo.endSession(sessionId, totalBytes, "completed");
    log.info("session ended", { sessionId, userId, totalBytes, actualCostCents, reservedCents });
  } catch (err) {
    log.error("session end failed", {
      sessionId,
      userId,
      totalBytes,
      actualCostCents,
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
    // R23 H-3: Redact full target hostname — only expose TLD+1 to protect user browsing privacy
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
    // Destroy the socket connections first
    const destroyFn = sessionDestroyCallbacks.get(sessionId);
    if (destroyFn) {
      try {
        destroyFn();
      } catch {
        // Best effort socket destruction
      }
    }
    // Settle billing for the session
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
  }

  if (terminated > 0) {
    log.info("terminated user sessions", { userId, terminated, total: userSessions.length });
  }
  return terminated;
}
