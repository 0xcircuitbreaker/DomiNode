import { Router } from "express";
import { usageRepo, createLogger } from "@dominode/shared";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();
const log = createLogger("api:sessions");

router.use(requireAuth);

// GET /api/sessions/active
router.get("/active", async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;

    const sessions = await usageRepo.getActiveSessions(userId);

    res.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        startedAt: s.startedAt,
        proxyIp: s.proxyIp,
        status: s.status,
      })),
    });
  } catch (err) {
    log.error("active sessions query failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Failed to fetch active sessions" });
  }
});

export default router;
