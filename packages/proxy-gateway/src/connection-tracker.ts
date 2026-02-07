import { createLogger } from "@dominode/shared";

const log = createLogger("proxy:connection-tracker");

const userConnectionCounts = new Map<string, number>();
const MAX_PER_USER = parseInt(process.env["PROXY_MAX_PER_USER"] ?? "100", 10);

// Validate config at module load
if (isNaN(MAX_PER_USER) || MAX_PER_USER <= 0) {
  throw new Error("PROXY_MAX_PER_USER must be a positive integer");
}

/**
 * Increment connection count for a user.
 * Returns false if the user is at the connection limit.
 */
export function incrementUserConns(userId: string): boolean {
  const current = userConnectionCounts.get(userId) ?? 0;
  if (current >= MAX_PER_USER) return false;
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
