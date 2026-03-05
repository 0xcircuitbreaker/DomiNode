import * as crypto from "node:crypto";
import rateLimit, { type Options } from "express-rate-limit";
import type { Request } from "express";

/**
 * Shared helper for MCP agent detection and rate-limit boosting.
 *
 * Verified MCP agents (swarms) get a configurable multiplier on rate limits
 * to prevent 429s during multi-agent operations. Security-sensitive limiters
 * (admin, account delete, wallet-auth, referrals) should NOT use this — they
 * keep their original limits regardless of agent status.
 */

// Cache env vars at module load — not re-read per request
const MCP_AGENT_SECRET = process.env["MCP_AGENT_SECRET"] ?? "";

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
 * Requires both X-DominusNode-Agent: mcp header AND valid secret.
 */
export function isVerifiedAgent(req: Request): boolean {
  if (MCP_AGENT_SECRET.length === 0) return false;
  if (req.headers["x-dominusnode-agent"] !== "mcp") return false;

  const headerSecret = (req.headers["x-dominusnode-agent-secret"] ?? "") as string;
  if (headerSecret.length !== MCP_AGENT_SECRET.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(headerSecret, "utf8"),
    Buffer.from(MCP_AGENT_SECRET, "utf8"),
  );
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
