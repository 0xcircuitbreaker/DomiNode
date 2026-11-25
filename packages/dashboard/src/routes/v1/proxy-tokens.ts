import { Router } from "express";
import type { Request, Response } from "express";
import { createLogger, proxyTokenRepo } from "@dominusnode/shared";
import type { ProxyToken } from "@dominusnode/shared";
import { requireAgentPrincipal, type AgentRequest } from "../../middleware/agent.js";
import { createKeyedLimiter } from "./limiter.js";

/**
 * Scoped, revocable proxy tokens (AGENT_API.md "Proxy tokens"). A token is a
 * dn_proxy_ secret for the proxy password field with an expiry and optional
 * byte/spend caps, so agents need not put their dn_live_ key in proxy URLs.
 */
const log = createLogger("api:v1:proxy-tokens");
const router = Router();

export const MAX_ACTIVE_PROXY_TOKENS = proxyTokenRepo.DEFAULT_MAX_ACTIVE_PER_USER;
export const createLimiter = createKeyedLimiter(20, 60 * 60_000);
export const revokeLimiter = createKeyedLimiter(60, 60 * 60_000);
export const listLimiter = createKeyedLimiter(120, 60_000);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_RE = /^[1-9][0-9]{0,15}$/;

function agent(req: Request): AgentRequest["agent"] {
  return (req as AgentRequest).agent;
}

function limit(l: { hit(k: string): boolean }, req: Request, res: Response): boolean {
  if (!l.hit(agent(req).userId)) {
    res.status(429).json({ error: "Too many requests. Try again later.", code: "RATE_LIMITED" });
    return false;
  }
  return true;
}

/** Positive integer from a JSON number or digit string; undefined when absent; null when invalid. */
function parsePositive(v: unknown): bigint | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return BigInt(v);
  if (typeof v === "string" && INT_RE.test(v)) return BigInt(v);
  return null;
}

export function view(t: ProxyToken): Record<string, unknown> {
  return {
    id: t.id,
    label: t.label,
    status: proxyTokenRepo.tokenStatus(t),
    expiresAt: t.expiresAt.toISOString(),
    maxBytes: t.maxBytes === null ? null : t.maxBytes.toString(),
    maxSpendMusd: t.maxSpendMusd === null ? null : t.maxSpendMusd.toString(),
    bytesUsed: t.bytesUsed.toString(),
    spendUsedMusd: t.spendUsedMusd.toString(),
    revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
  };
}

router.use("/proxy-tokens", requireAgentPrincipal);

// POST /v1/proxy-tokens { label?, ttlSeconds?, maxBytes?, maxSpendMusd? }
router.post("/proxy-tokens", async (req: Request, res: Response) => {
  const a = agent(req);
  if (!a.verified) {
    res.status(403).json({ error: "Email verification required", code: "EMAIL_NOT_VERIFIED" });
    return;
  }
  if (!limit(createLimiter, req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const label = body["label"] ?? "";
  if (typeof label !== "string") {
    res.status(400).json({ error: "label must be a string" });
    return;
  }
  const ttl = parsePositive(body["ttlSeconds"]);
  const maxBytes = parsePositive(body["maxBytes"]);
  const maxSpendMusd = parsePositive(body["maxSpendMusd"]);
  if (ttl === null || maxBytes === null || maxSpendMusd === null) {
    res.status(400).json({ error: "ttlSeconds, maxBytes and maxSpendMusd must be positive integers" });
    return;
  }
  const ttlMs = ttl === undefined ? undefined : Number(ttl) * 1000;
  if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < proxyTokenRepo.MIN_TTL_MS || ttlMs > proxyTokenRepo.MAX_TTL_MS)) {
    res.status(400).json({ error: `ttlSeconds must be between ${proxyTokenRepo.MIN_TTL_MS / 1000} and ${proxyTokenRepo.MAX_TTL_MS / 1000}` });
    return;
  }
  try {
    const out = await proxyTokenRepo.createProxyToken(a.userId, { label, ttlMs, maxBytes: maxBytes ?? null, maxSpendMusd: maxSpendMusd ?? null }, MAX_ACTIVE_PROXY_TOKENS);
    if (!out) {
      res.status(409).json({ error: `At most ${MAX_ACTIVE_PROXY_TOKENS} active proxy tokens. Revoke one first.`, code: "PROXY_TOKEN_LIMIT" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({ ...view(out.record), token: out.token });
  } catch (err) {
    if (err instanceof proxyTokenRepo.ProxyTokenInputError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.error("proxy token create failed", { error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
    res.status(500).json({ error: "Failed to create proxy token" });
  }
});

// GET /v1/proxy-tokens (metadata only, never the secret)
router.get("/proxy-tokens", async (req: Request, res: Response) => {
  if (!limit(listLimiter, req, res)) return;
  try {
    const list = await proxyTokenRepo.listProxyTokens(agent(req).userId);
    res.json({ tokens: list.map(view), maxActive: MAX_ACTIVE_PROXY_TOKENS });
  } catch (err) {
    log.error("proxy token list failed", { error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
    res.status(500).json({ error: "Failed to list proxy tokens" });
  }
});

// DELETE /v1/proxy-tokens/:id (revoke; the gateway refuses it within seconds)
router.delete("/proxy-tokens/:id", async (req: Request, res: Response) => {
  if (!limit(revokeLimiter, req, res)) return;
  const id = req.params["id"];
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    res.status(400).json({ error: "Invalid token id" });
    return;
  }
  try {
    const ok = await proxyTokenRepo.revokeProxyToken(agent(req).userId, id);
    if (!ok) {
      res.status(404).json({ error: "Proxy token not found or already revoked" });
      return;
    }
    res.json({ id, revoked: true });
  } catch (err) {
    log.error("proxy token revoke failed", { error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
    res.status(500).json({ error: "Failed to revoke proxy token" });
  }
});

export default router;
