import * as crypto from "node:crypto";
import rateLimit, { type Options } from "express-rate-limit";
import type { Request } from "express";
import { agentSecretRepo } from "@dominusnode/shared";

/**
 * Shared helper for MCP agent detection and rate-limit boosting.
 *
 * Verified MCP agents (swarms) get a configurable multiplier on rate limits
 * to prevent 429s during multi-agent operations. Security-sensitive limiters
 * (admin, account delete, wallet-auth, referrals) should NOT use this — they
 * keep their original limits regardless of agent status.
 *
 * Agent verification has two paths:
 * 1. Global MCP_AGENT_SECRET — for admin/first-party (existing)
 * 2. Per-agent secrets (das_ prefix) — for self-registered agents (new)
 */

// Cache env vars at module load — not re-read per request
const MCP_AGENT_SECRET = process.env["MCP_AGENT_SECRET"] ?? "";

// Per-agent secret cache: hash → userId, TTL 60s
const _agentSecretCache = new Map<string, { userId: string; expires: number }>();
const AGENT_SECRET_CACHE_TTL_MS = 60_000;
const MAX_AGENT_SECRET_CACHE_SIZE = 10_000;

// Periodic cleanup of expired agent secret cache entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _agentSecretCache) {
    if (v.expires <= now) _agentSecretCache.delete(k);
  }
}, 300_000).unref();

/**
 * Invalidate a specific agent secret from the cache (called on revocation).
 * Takes the raw secret, hashes it, and removes from cache.
 */
export function invalidateAgentSecretCache(secretHash: string): void {
  _agentSecretCache.delete(secretHash);
}

/**
 * Returns the configured agent rate-limit multiplier.
 * Defaults to 10, clamped to [1, 100], NaN-safe.
 */
export function getAgentMultiplier(): number {
  const raw = parseInt(process.env["AGENT_RATE_LIMIT_MULTIPLIER"] ?? "", 10);
  if (!Number.isFinite(raw) || raw < 1) return 10;
  if (raw > 100) return 100;
  return raw;
}

/**
 * Timing-safe check: is this request from a verified MCP agent?
 * Checks global MCP_AGENT_SECRET only (synchronous).
 * Requires both X-DominusNode-Agent: mcp header AND valid secret.
 */
export function isVerifiedAgent(req: Request): boolean {
  if (req.headers["x-dominusnode-agent"] !== "mcp") return false;

  const headerSecret = (req.headers["x-dominusnode-agent-secret"] ?? "") as string;

  // Path 1: Global MCP_AGENT_SECRET (admin/first-party)
  if (
    MCP_AGENT_SECRET.length > 0 &&
    headerSecret.length === MCP_AGENT_SECRET.length
  ) {
    if (
      crypto.timingSafeEqual(
        Buffer.from(headerSecret, "utf8"),
        Buffer.from(MCP_AGENT_SECRET, "utf8"),
      )
    ) {
      return true;
    }
  }

  // Path 2: Per-agent secret (das_ prefix) — check cache only (sync)
  if (headerSecret.startsWith("das_") && headerSecret.length === 68) {
    const hash = crypto.createHash("sha256").update(headerSecret).digest("hex");
    const cached = _agentSecretCache.get(hash);
    if (cached && cached.expires > Date.now()) {
      return true;
    }
  }

  return false;
}

/**
 * Async variant that also checks per-agent secrets via DB lookup.
 * Caches positive results for 60s to avoid per-request DB hits.
 * Returns the user_id of the agent owner if verified, null otherwise.
 */
export async function isVerifiedAgentAsync(
  req: Request,
): Promise<{ verified: boolean; agentUserId?: string }> {
  if (req.headers["x-dominusnode-agent"] !== "mcp") {
    return { verified: false };
  }

  const headerSecret = (req.headers["x-dominusnode-agent-secret"] ?? "") as string;

  // Path 1: Global MCP_AGENT_SECRET
  if (
    MCP_AGENT_SECRET.length > 0 &&
    headerSecret.length === MCP_AGENT_SECRET.length
  ) {
    if (
      crypto.timingSafeEqual(
        Buffer.from(headerSecret, "utf8"),
        Buffer.from(MCP_AGENT_SECRET, "utf8"),
      )
    ) {
      return { verified: true };
    }
  }

  // Path 2: Per-agent secret (das_ prefix)
  if (headerSecret.startsWith("das_") && headerSecret.length === 68) {
    const hash = crypto.createHash("sha256").update(headerSecret).digest("hex");

    // Check cache first
    const cached = _agentSecretCache.get(hash);
    if (cached && cached.expires > Date.now()) {
      return { verified: true, agentUserId: cached.userId };
    }

    // DB lookup — findUserBySecretHash also updates last_used
    const userId = await agentSecretRepo.findUserBySecretHash(hash);
    if (userId) {
      // Evict stale entries if cache is too large
      if (_agentSecretCache.size >= MAX_AGENT_SECRET_CACHE_SIZE) {
        const now = Date.now();
        for (const [k, v] of _agentSecretCache) {
          if (v.expires <= now) _agentSecretCache.delete(k);
        }
        // If still too large after purge, clear all
        if (_agentSecretCache.size >= MAX_AGENT_SECRET_CACHE_SIZE) {
          _agentSecretCache.clear();
        }
      }
      _agentSecretCache.set(hash, {
        userId,
        expires: Date.now() + AGENT_SECRET_CACHE_TTL_MS,
      });
      return { verified: true, agentUserId: userId };
    }
  }

  return { verified: false };
}

/**
 * Drop-in replacement for rateLimit() that boosts `max` for verified MCP agents.
 *
 * Usage:
 *   agentAwareRateLimit({ windowMs: 60_000, max: 100, ... })
 *
 * Regular users get `max`. Verified agents get `max * multiplier`.
 */
export function agentAwareRateLimit(
  opts: Partial<Options> & { max: number },
): ReturnType<typeof rateLimit> {
  const baseMax = opts.max;
  const multiplier = getAgentMultiplier();

  return rateLimit({
    ...opts,
    max: (req: Request) => (isVerifiedAgent(req) ? baseMax * multiplier : baseMax),
  });
}
