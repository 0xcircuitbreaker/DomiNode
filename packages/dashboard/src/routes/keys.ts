import { Router } from "express";
import { userRepo, generateApiKey, sanitizeString, createLogger } from "@dominusnode/shared";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();
const log = createLogger("api:keys");

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireAuth);

// POST /api/keys — create new API key
router.post("/", async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;

    // R19 C-1: Check user is still active (JWT may outlive suspend by up to 15min)
    const currentUser = await userRepo.findUserById(userId);
    if (!currentUser || currentUser.status !== "active") {
      res.status(403).json({ error: "Account is suspended or disabled" });
      return;
    }

    // Enforce max API key limit per user
    const activeKeyCount = await userRepo.countActiveKeys(userId);
    if (activeKeyCount >= 50) {
      res.status(400).json({ error: "Maximum 50 active API keys allowed" });
      return;
    }

    const label = sanitizeString(req.body.label ?? "Default", 100);

    const { raw, hash, prefix } = generateApiKey();
    const apiKey = await userRepo.createApiKey(userId, hash, prefix, label);

    log.info("API key created", { userId, keyId: apiKey.id, prefix });

    // Return the raw key — this is the ONLY time the user sees it
    res.status(201).json({
      key: raw,
      id: apiKey.id,
      prefix: apiKey.key_prefix,
      label: apiKey.label,
      created_at: apiKey.created_at,
    });
  } catch (err) {
    log.error("key creation failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to create API key" });
  }
});

// GET /api/keys — list API keys
router.get("/", async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;
    const keys = await userRepo.listApiKeys(userId);

    res.json({
      keys: keys.map((k) => ({
        id: k.id,
        prefix: k.key_prefix,
        label: k.label,
        created_at: k.created_at,
        revoked_at: k.revoked_at,
      })),
    });
  } catch (err) {
    log.error("key listing failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to list API keys" });
  }
});

// DELETE /api/keys/:id — revoke API key
router.delete("/:id", async (req, res) => {
  const keyId = req.params.id;
  if (!UUID_REGEX.test(keyId)) {
    res.status(400).json({ error: "Invalid API key ID format" });
    return;
  }
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;

    const revoked = await userRepo.revokeApiKey(keyId, userId);
    if (!revoked) {
      res.status(404).json({ error: "API key not found or already revoked" });
      return;
    }

    log.info("API key revoked", { userId, keyId });
    res.status(204).end();
  } catch (err) {
    log.error("key revocation failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to revoke API key" });
  }
});

export default router;
