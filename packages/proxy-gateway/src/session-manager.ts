import { usageRepo, walletRepo, planRepo, teamRepo, policyRepo, tierRepo, relayChargeRepo, relaySettleRetryRepo, createLogger } from "@dominusnode/shared";
import type { Plan, NodeIpClass } from "@dominusnode/shared";
import { RELAY_BYTES_PER_GB, isClassDowngrade } from "@dominusnode/shared";
import { recordRequesterSpend, reserveRequesterSpend, releaseRequesterSpend, reserveRequesterShared } from "./policy-enforcer.js";
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
const SESSION_BYTE_CAP = parseInt(process.env["RELAY_SESSION_BYTE_CAP"] ?? "1000000000", 10); // default 1 GB (decimal, = one priced GB)
if (isNaN(SESSION_BYTE_CAP) || SESSION_BYTE_CAP < 1024 * 1024 || SESSION_BYTE_CAP > 100 * 1024 * 1024 * 1024) {
  throw new Error("RELAY_SESSION_BYTE_CAP must be between 1MB and 100GB");
}

/** ceil(price × byteCap) in cents; at least 1 cent for a non-zero price. */
export function reservationCentsFor(pricePerGbMusd: bigint, byteCap: number = SESSION_BYTE_CAP): number {
  if (pricePerGbMusd <= 0n) return 0;
  const num = pricePerGbMusd * BigInt(byteCap);
  const den = BigInt(RELAY_BYTES_PER_GB) * BigInt(MUSD_PER_CENT);
  const cents = (num + den - 1n) / den;
  return Number(cents > 0n ? cents : 1n);
}

/** Bytes a reservation pays for at the locked price (floor; no overrun headroom). */
export function maxBytesForReservation(reservedCents: number, pricePerGbMusd: bigint): number {
  if (pricePerGbMusd <= 0n || reservedCents <= 0) return 0;
  const b = (BigInt(reservedCents) * BigInt(MUSD_PER_CENT) * BigInt(RELAY_BYTES_PER_GB)) / pricePerGbMusd;
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
  proxyType: string; // Track provider pool type (dc/residential) for usage records
  teamId: string | null; // When set, billing goes to team wallet
  relay: RelayBinding;
  destHost: string; // Bare host for relay_abuse_log (metadata only)
  pricePerGbMusd: bigint; // network_pricing for the node class, locked at start
  snapshot: ChargeSnapshot; // owner tier share + split config, locked at start
  /** x402/mpp: paid up front; settled as gross = paidMusd, no wallet movement. */
  prepaid?: { rail: "x402" | "mpp"; paidMusd: bigint };
  /** In-flight spend held against the daily cap until settle/abort. */
  inflightMusd?: bigint;
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

  // Plan supplies connection/session limits only. Relay price never comes
  // from the plan: every session is priced from network_pricing and paid
  // (there is no free relay rail; starter credits replace the free tier).
  // Use pre-fetched plan if available — eliminates TOCTOU from double getUserPlan
  let planSessionLimit: number | undefined;
  let planMaxConns: number | undefined;
  try {
    const plan = preloadedPlan ?? await planRepo.getUserPlan(userId);
    planSessionLimit = plan.maxSessionsPerMinute;
    planMaxConns = plan.maxConnections;

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
    // Node share (tier + genesis) from the node owner; buyer discount from the requester's own tier.
    const [ownerSnap, buyer] = await Promise.all([
      // Tier weight of the node's verified exit class is snapshotted with node share.
      tierRepo.getChargeSnapshot(relay.nodeOwnerUserId, relay.ipClass),
      tierRepo.getBuyerDiscount ? tierRepo.getBuyerDiscount(userId) : Promise.resolve(null),
    ]);
    snapshot = buyer ? { ...ownerSnap, ...buyer } : ownerSnap;
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

  let reservedCents = 0;

  // Daily spend cap: count this session's reservation as in-flight spend so
  // concurrent sessions cannot all start under the cap (see policy-enforcer).
  let inflightMusd = BigInt(reservationCentsFor(pricePerGbMusd)) * BigInt(MUSD_PER_CENT);
  if (!reserveRequesterSpend(userId, inflightMusd)) {
    throw new Error("Daily spend cap reached");
  }
  await reserveRequesterShared(userId, inflightMusd);

  let sessionId: string;
  try {
  if (teamId) {
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

  // Reconcile the in-flight hold to what was actually reserved.
  const reservedMusd = BigInt(reservedCents) * BigInt(MUSD_PER_CENT);
  if (reservedMusd !== inflightMusd) {
    releaseRequesterSpend(userId, inflightMusd);
    reserveRequesterSpend(userId, reservedMusd, false);
    inflightMusd = reservedMusd;
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
    throw err;
  }

  sessionId = dbSession.id;

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
    proxyType,
    teamId: teamId ?? null,
    relay,
    destHost: targetHost.includes(":") && !targetHost.startsWith("[") ? `[${targetHost}]` : (targetHost || "unknown"),
    pricePerGbMusd,
    snapshot,
    inflightMusd,
  });
  } catch (err) {
    releaseRequesterSpend(userId, inflightMusd);
    throw err;
  }

  // Set per-session byte limit to prevent unbounded usage beyond reservation
  // Paid sessions: cap at exactly what the reservation covers (no overrun headroom,
  // so settlement is never partial and the node is paid for every byte it carried)
  {
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
  const b = (paidMusd * BigInt(RELAY_BYTES_PER_GB)) / pricePerGbMusd;
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
    snapshot = await tierRepo.getChargeSnapshot(i.relay.nodeOwnerUserId, i.relay.ipClass);
  } catch {
    throw new Error("Unable to lock relay pricing. Please try again.");
  }
  if (activeSessions.size >= MAX_ACTIVE_SESSIONS) throw new Error("Server at capacity. Please try again later.");
  if (!reserveRequesterSpend(i.userId, i.paidMusd)) throw new Error("Daily spend cap reached");
  await reserveRequesterShared(i.userId, i.paidMusd);
  let dbSession;
  try {
    dbSession = await usageRepo.createRelaySession(i.userId, i.relay.nodeId, i.relay.destPort);
  } catch (err) {
    releaseRequesterSpend(i.userId, i.paidMusd);
    throw err;
  }
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
    proxyType: "relay",
    teamId: null,
    relay: i.relay,
    destHost: host.includes(":") && !host.startsWith("[") ? `[${host}]` : (host || "unknown"),
    pricePerGbMusd: i.quotedPricePerGbMusd,
    snapshot,
    prepaid: { rail: i.rail, paidMusd: i.paidMusd },
    inflightMusd: i.paidMusd,
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
 * Abort a prepaid session whose payment never settled or was refunded: no
 * relay charge, no node earnings; the DB session is closed as "error".
 */
export async function abortPrepaidSession(sessionId: string): Promise<boolean> {
  const session = activeSessions.get(sessionId);
  if (!session || !session.prepaid) return false;
  if (!activeSessions.delete(sessionId)) return false;
  sessionDestroyCallbacks.delete(sessionId);
  releaseRequesterSpend(session.userId, session.inflightMusd ?? 0n);
  try {
    await usageRepo.endSession(sessionId, 0, "error");
  } catch (err) {
    log.error("prepaid session abort failed", { sessionId, error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
  }
  return true;
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

/** Settlements started but not yet finished; graceful shutdown awaits them before closing the pool. */
const inFlightSettlements = new Set<Promise<void>>();

export function endSession(sessionId: string): Promise<void> {
  const p = settleSession(sessionId);
  inFlightSettlements.add(p);
  const done = (): void => { inFlightSettlements.delete(p); };
  p.then(done, done);
  return p;
}

export function getInFlightSettlementCount(): number {
  return inFlightSettlements.size;
}

/**
 * Wait for in-flight settlements (including ones started while waiting),
 * bounded by timeoutMs. Resolves true if all finished in time.
 */
export async function awaitInFlightSettlements(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (inFlightSettlements.size > 0) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), left); });
    const res = await Promise.race([Promise.allSettled([...inFlightSettlements]), timeout]);
    clearTimeout(timer);
    if (res === "timeout") return inFlightSettlements.size === 0;
  }
  return true;
}

async function settleSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  // Fix #8: Atomic check-and-remove to prevent TOCTOU race
  if (!activeSessions.delete(sessionId)) return;

  const { userId, counter, reservedCents, teamId, relay } = session;
  const totalBytes = counter.bytesIn + counter.bytesOut;

  // Record bandwidth for velocity tracking (prevents single user from monopolizing)
  if (totalBytes > 0) {
    recordBandwidthUsage(userId, totalBytes);
    recordBytes(counter.bytesIn, counter.bytesOut);
  }

  const rail = session.prepaid ? session.prepaid.rail : teamId ? "team" : "wallet";
  let settleInput: relayChargeRepo.SettleRelayChargeInput | null = null;

  try {
    // One transaction: requester settle, relay_charges, node earn, abuse log,
    // session end and usage record (DESIGN.md §6.3). Bytes are gateway-measured.
    const r = await relayChargeRepo.settleRelayCharge(settleInput = {
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

    // Durable retry: settleRelayCharge is idempotent on session_id, so the
    // retry job settles the reservation, charge and node earnings later.
    // The DB session stays 'active' so the retry can settle it.
    if (settleInput) {
      try {
        await relaySettleRetryRepo.enqueueSettleRetry(settleInput, err instanceof Error ? err.message : String(err));
        log.warn("session settlement queued for retry", { sessionId });
        return;
      } catch (qErr) {
        log.error("SETTLE RETRY ENQUEUE FAILED — reservation stays debited", {
          sessionId, error: qErr instanceof Error ? qErr.message.slice(0, 120) : "unknown",
        });
      }
    }

    // Last resort: reservation stays debited (safe default); mark session error.
    try {
      await usageRepo.endSession(sessionId, totalBytes, "error");
    } catch {
      // Best effort
    }
  } finally {
    // The real spend was recorded above (or the settle is queued): drop the hold.
    releaseRequesterSpend(userId, session.inflightMusd ?? 0n);
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
 * End a node's in-flight sessions whose locked class is above its new verified
 * class (a probe downgrade, ECONOMICS.md §1a "In-flight sessions"). Bytes
 * carried so far settle at the price locked at session start; the sockets are
 * then closed so no traffic flows at the old class's price or tier weight.
 */
export async function terminateNodeSessionsAbove(nodeId: string, cls: NodeIpClass): Promise<number> {
  const ids: string[] = [];
  for (const [id, s] of activeSessions) {
    if (s.relay.nodeId === nodeId && isClassDowngrade(s.relay.ipClass, cls)) ids.push(id);
  }
  let ended = 0;
  for (const sessionId of ids) {
    try {
      await endSession(sessionId);
      ended++;
    } catch (err) {
      log.error("downgrade session termination failed", { sessionId, error: err instanceof Error ? err.message : String(err) });
    }
    const destroyFn = sessionDestroyCallbacks.get(sessionId);
    if (destroyFn) {
      try { destroyFn(); } catch { /* best effort */ }
      sessionDestroyCallbacks.delete(sessionId);
    }
  }
  if (ended > 0) log.warn("ended in-flight sessions after egress downgrade", { nodeId, to: cls, ended });
  return ended;
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
