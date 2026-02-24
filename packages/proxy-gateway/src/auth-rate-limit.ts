import { createLogger } from "@dominusnode/shared";

const log = createLogger("proxy:auth-rate-limit");

interface AuthFailureEntry {
  count: number;
  firstFailure: number;
}

const authFailures = new Map<string, AuthFailureEntry>();
const MAX_FAILURES = parseInt(process.env["AUTH_FAIL_MAX"] ?? "5", 10);
if (isNaN(MAX_FAILURES) || MAX_FAILURES <= 0) {
  throw new Error("AUTH_FAIL_MAX must be a positive integer");
}
const WINDOW_MS = parseInt(process.env["AUTH_FAIL_WINDOW_MS"] ?? "60000", 10);
if (isNaN(WINDOW_MS) || WINDOW_MS < 1000) {
  throw new Error("AUTH_FAIL_WINDOW_MS must be >= 1000");
}
const MAX_MAP_SIZE = 100_000; // Cap to prevent memory exhaustion (H-7 fix)

/**
 * Check if an IP is rate-limited due to auth failures.
 * Returns true if the IP is BLOCKED (too many failures).
 */
export function checkAuthRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || now - entry.firstFailure > WINDOW_MS) {
    return false; // not blocked
  }
  return entry.count >= MAX_FAILURES; // blocked if at or over limit
}

/**
 * Record an auth failure for an IP.
 * Evicts oldest entries if map exceeds MAX_MAP_SIZE.
 */
export function recordAuthFailure(ip: string): void {
  const now = Date.now();

  // H-7 fix: Cap map size to prevent memory exhaustion
  if (authFailures.size >= MAX_MAP_SIZE) {
    // Evict oldest entries (Map iterates in insertion order)
    let toDelete = Math.floor(MAX_MAP_SIZE / 4);
    for (const key of authFailures.keys()) {
      if (toDelete <= 0) break;
      authFailures.delete(key);
      toDelete--;
    }
    log.warn("auth failure map eviction", { size: authFailures.size });
  }

  const entry = authFailures.get(ip);
  if (!entry || now - entry.firstFailure > WINDOW_MS) {
    authFailures.set(ip, { count: 1, firstFailure: now });
  } else {
    entry.count++;
  }
}

// Cleanup expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authFailures) {
    if (now - entry.firstFailure > WINDOW_MS) {
      authFailures.delete(ip);
    }
  }
}, 300_000).unref();
