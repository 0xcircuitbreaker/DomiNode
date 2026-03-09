import { Router } from "express";
import {
  agentSecretRepo,
  userRepo,
  createLogger,
  sanitizeString,
} from "@dominusnode/shared";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { invalidateAgentSecretCache } from "../helpers/agent-rate-limit.js";

const router = Router();
const log = createLogger("api:agent-secret");

// All routes require authentication
router.use(requireAuth);

/**
 * POST /api/agent/secret — Generate a new per-agent secret.
 * Returns the raw secret (shown once, never stored) and metadata.
 * Per-user cap: 5 active secrets. Oldest revoked on overflow.
 * Requires email_verified to prevent verification bypass.
 */
router.post("/", async (req, res) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.userId;

    // email_verified required — agent secrets grant elevated privileges
    // (CAPTCHA bypass, auto-verify) that could bypass email verification
    const user = await userRepo.findUserById(userId);
    if (!user || !user.email_verified) {
      res.status(403).json({ error: "Email verification required to create agent secrets" });
      return;
    }

    const label = sanitizeString(req.body.label ?? "", 100);

    const { raw, hash } = agentSecretRepo.generateAgentSecret();
    const secret = await agentSecretRepo.createSecret(userId, hash, label);

    log.info("agent secret created", { userId, secretId: secret.id, label });

    res.status(201).json({
      id: secret.id,
      agentSecret: raw,
      label: secret.label,
      createdAt: secret.created_at,
      expiresAt: null, // Agent secrets don't expire (revoke manually)
    });
  } catch (err) {
    log.error("agent secret creation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Failed to create agent secret" });
  }
});

/**
 * GET /api/agent/secret — List active agent secrets.
 * Does NOT return the raw secret (only shown on creation).
 */
router.get("/", async (req, res) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const secrets = await agentSecretRepo.listSecrets(authReq.user.userId);

    res.json({
      secrets: secrets.map((s) => ({
        id: s.id,
        label: s.label,
        createdAt: s.created_at,
        lastUsed: s.last_used,
      })),
    });
  } catch (err) {
    log.error("list agent secrets failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Failed to list agent secrets" });
  }
});

/**
 * DELETE /api/agent/secret/:id — Revoke a specific agent secret.
 * Immediately invalidates the secret from the in-memory cache.
 */
router.delete("/:id", async (req, res) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const secretId = req.params.id as string;

    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secretId)) {
      res.status(400).json({ error: "Invalid secret ID format" });
      return;
    }

    const revokedHash = await agentSecretRepo.revokeSecret(authReq.user.userId, secretId);
    if (!revokedHash) {
      res.status(404).json({ error: "Secret not found or already revoked" });
      return;
    }

    // Invalidate from in-memory cache — immediate effect, no 60s stale window
    invalidateAgentSecretCache(revokedHash);

    log.info("agent secret revoked", { userId: authReq.user.userId, secretId });
    res.json({ revoked: true });
  } catch (err) {
    log.error("agent secret revocation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Failed to revoke agent secret" });
  }
});

export default router;
