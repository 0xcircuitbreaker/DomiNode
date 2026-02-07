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
}

const activeSessions = new Map<string, ActiveSession>();

// Cleanup stale sessions every 60 seconds
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  for (const [id, session] of activeSessions) {
    if (now - session.startedAt.getTime() > oneHour) {
      log.warn("cleaning up stale session", { sessionId: id });
      endSession(id).catch((err) => {
        log.error("stale session cleanup failed", {
          sessionId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}, 60_000).unref();

/**
 * Start a proxy session with upfront balance reservation.
 * Throws if insufficient balance (caller should return 402).
 */
export async function startSession(
  userId: string,
  targetHost: string,
  counter: ByteCounter,
): Promise<string> {
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
  });

  log.info("session started", { sessionId, userId, targetHost, reservedCents: MIN_RESERVATION_CENTS });
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

  const { userId, counter, targetHost, reservedCents } = session;
  const totalBytes = counter.bytesIn + counter.bytesOut;

  // Look up user's plan for pricing
  let pricePerGbCents = 500; // default PAYG rate
  try {
    const plan = await planRepo.getUserPlan(userId);
    pricePerGbCents = plan.pricePerGbCents;
  } catch (err) {
    log.warn("failed to fetch user plan, using default pricing", {
      sessionId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const actualCostCents = computeCostCents(totalBytes, pricePerGbCents);

  try {
    // Record usage in DB
    await recordUsage(userId, sessionId, counter.bytesIn, counter.bytesOut, targetHost, pricePerGbCents);

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
}> {
  const results: Array<{
    sessionId: string;
    userId: string;
    targetHost: string;
    startedAt: Date;
    bytesIn: number;
    bytesOut: number;
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
    });
  }

  return results;
}
