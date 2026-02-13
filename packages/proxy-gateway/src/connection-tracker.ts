import { createLogger } from "@dominode/shared";

const log = createLogger("proxy:connection-tracker");

const userConnectionCounts = new Map<string, number>();
const MAX_PER_USER = parseInt(process.env["PROXY_MAX_PER_USER"] ?? "100", 10);
const MAX_TRACKED_USERS = 50_000; // Cap Map size to prevent OOM (R12 H-2)

// Validate config at module load
if (isNaN(MAX_PER_USER) || MAX_PER_USER <= 0) {
  throw new Error("PROXY_MAX_PER_USER must be a positive integer");
}

/**
 * Increment connection count for a user.
 * Returns false if the user is at the connection limit.
 * @param maxConns Optional per-plan connection limit (defaults to PROXY_MAX_PER_USER env var)
 */
export function incrementUserConns(userId: string, maxConns?: number): boolean {
  const limit = maxConns ?? MAX_PER_USER;
  const current = userConnectionCounts.get(userId) ?? 0;
  if (current >= limit) return false;
  // Reject new users if Map is at capacity (prevent OOM under heavy load)
  if (current === 0 && userConnectionCounts.size >= MAX_TRACKED_USERS) {
    log.warn("connection tracker at capacity, rejecting new user", { userId, size: userConnectionCounts.size });
    return false;
  }
  userConnectionCounts.set(userId, current + 1);
  return true;
}

/**
 * Decrement connection count for a user.
 * Cleans up the Map entry when count reaches zero.
 */
export function decrementUserConns(userId: string): void {
  const current = userConnectionCounts.get(userId) ?? 0;
  if (current <= 1) {
    userConnectionCounts.delete(userId);
  } else {
    userConnectionCounts.set(userId, current - 1);
  }
}

/**
 * Get current connection count for a user.
 */
export function getUserConnCount(userId: string): number {
  return userConnectionCounts.get(userId) ?? 0;
}
