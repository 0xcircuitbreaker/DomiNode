import * as crypto from "node:crypto";
import rateLimit, { type Options } from "express-rate-limit";
import { ipRateKey } from "./ip-key.js";
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
 * Constant-time comparison of a presented header secret against
 * MCP_AGENT_SECRET. Compares fixed-length SHA-256 digests so differing UTF-8
 * byte lengths (e.g. a latin1 byte decoded as a 2-byte char) can never make
 * timingSafeEqual throw, and the secret's length is not observable. Never throws.
 */
export function matchesGlobalAgentSecret(headerSecret: unknown, expected: string = MCP_AGENT_SECRET): boolean {
  try {
    if (expected.length === 0 || typeof headerSecret !== "string" || headerSecret.length === 0) return false;
    const a = crypto.createHash("sha256").update(headerSecret, "utf8").digest();
    const b = crypto.createHash("sha256").update(expected, "utf8").digest();
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Strict check for credential-guessing protections (login lockout, MFA,
 * verify-key, change-password, wallet verify). Only the global first-party
 * MCP_AGENT_SECRET may bypass them. Per-agent das_ secrets are issued to any
 * email-verified user and are not bound to the target account, so they must
 * NOT bypass brute-force protections.
 */
export function isGlobalVerifiedAgent(req: Request): boolean {
  if (req.headers["x-dominusnode-agent"] !== "mcp") return false;
  return matchesGlobalAgentSecret(req.headers["x-dominusnode-agent-secret"]);
}

/**
 * Timing-safe check: is this request from a verified MCP agent?
 * Checks global MCP_AGENT_SECRET only (synchronous).
 * Requires both X-DominusNode-Agent: mcp header AND valid secret.
 */
export function isVerifiedAgent(req: Request): boolean {
  if (req.headers["x-dominusnode-agent"] !== "mcp") return false;

  const rawSecret = req.headers["x-dominusnode-agent-secret"];
  const headerSecret = typeof rawSecret === "string" ? rawSecret : "";

  // Path 1: Global MCP_AGENT_SECRET (admin/first-party)
  if (matchesGlobalAgentSecret(headerSecret)) return true;

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

  const rawSecret = req.headers["x-dominusnode-agent-secret"];
  const headerSecret = typeof rawSecret === "string" ? rawSecret : "";

  // Path 1: Global MCP_AGENT_SECRET
  if (matchesGlobalAgentSecret(headerSecret)) return { verified: true };

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
    // IPv6 clients are keyed by /64 (express-rate-limit v7 keys the full /128).
    keyGenerator: (req: Request) => ipRateKey(req.ip ?? req.socket?.remoteAddress ?? ""),
    ...opts,
    max: (req: Request) => (isVerifiedAgent(req) ? baseMax * multiplier : baseMax),
  });
}
