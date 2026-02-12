import { usageRepo, walletRepo, planRepo, createLogger } from "@dominode/shared";
import { computeCostCents, recordUsage } from "@dominode/metering";
import { invalidateBalanceCache } from "./balance-check.js";
import type { ByteCounter } from "./counting-stream.js";

const log = createLogger("proxy:session");

// Minimum reservation per session: 10 cents (~20MB at $5/GB)
// Small enough not to inconvenience users, large enough to prevent abuse
const MIN_RESERVATION_CENTS = 10;

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
}

const activeSessions = new Map<string, ActiveSession>();

// Socket destroy callbacks registered per session for forced termination.
// When admin suspends a user, we call these to close the TCP connections.
const sessionDestroyCallbacks = new Map<string, () => void>();

// Per-user session rate limiter: max new sessions per minute
const MAX_SESSIONS_PER_MINUTE = parseInt(process.env["MAX_SESSIONS_PER_MINUTE"] ?? "30", 10);
const MAX_RATE_LIMIT_MAP_SIZE = 50_000;
const sessionCreationLog = new Map<string, number[]>(); // userId -> timestamps

export function checkSessionRateLimit(userId: string): boolean {
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
  if (timestamps.length >= MAX_SESSIONS_PER_MINUTE) {
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
): Promise<string> {
  // Per-user session rate limiting
  if (!checkSessionRateLimit(userId)) {
    throw new Error("Session rate limit exceeded");
  }

  // Fetch plan once for both bandwidth check and pricing lock (R13 H-2: eliminates TOCTOU)
  let pricePerGbCents = 500; // default PAYG rate
  try {
    const plan = await planRepo.getUserPlan(userId);
    pricePerGbCents = plan.pricePerGbCents;

    // Check plan bandwidth limit before allowing session
    if (plan.monthlyBandwidthBytes > 0) {
      const monthlyUsage = await planRepo.getMonthlyUsage(userId);
      if (monthlyUsage >= plan.monthlyBandwidthBytes) {
        throw new Error("Monthly bandwidth limit exceeded");
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("bandwidth limit")) {
      throw err;
    }
    log.warn("failed to check plan, using default pricing", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // C1 fix: Reserve balance BEFORE creating session — no free proxy usage
  const walletId = await walletRepo.reserveBalance(userId, MIN_RESERVATION_CENTS);
  if (!walletId) {
    throw new Error("Insufficient balance for reservation");
  }

  invalidateBalanceCache(userId);

  let dbSession;
  try {
    dbSession = await usageRepo.createSession(userId, "packetstream");
  } catch (err) {
    // If DB session creation fails, release the reservation
    await walletRepo.releaseReservation(userId, MIN_RESERVATION_CENTS);
    invalidateBalanceCache(userId);
    throw err;
  }

  const sessionId = dbSession.id;

  activeSessions.set(sessionId, {
    sessionId,
    userId,
    targetHost,
    startedAt: new Date(),
    counter,
    reservedCents: MIN_RESERVATION_CENTS,
    connectLatencyMs,
    errorCount: 0,
    pricePerGbCents,
  });

  // Redact full hostname from logs to protect user privacy
  const redactedHost = targetHost.split(".").slice(-2).join(".");
  log.info("session started", { sessionId, userId, targetHost: redactedHost, reservedCents: MIN_RESERVATION_CENTS });
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

  const { userId, counter, targetHost, reservedCents, connectLatencyMs, pricePerGbCents } = session;
  const totalBytes = counter.bytesIn + counter.bytesOut;

  const actualCostCents = computeCostCents(totalBytes, pricePerGbCents);

  try {
    // Record usage in DB
    await recordUsage(userId, sessionId, counter.bytesIn, counter.bytesOut, targetHost, pricePerGbCents, connectLatencyMs);

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
    results.push({
      sessionId: session.sessionId,
      userId: session.userId,
      targetHost: session.targetHost,
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
