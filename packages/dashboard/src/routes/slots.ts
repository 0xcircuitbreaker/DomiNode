import { Router } from "express";
import { userRepo, createLogger } from "@dominusnode/shared";

const router = Router();
const log = createLogger("api:slots");

const MAX_REGISTERED_USERS = parseInt(process.env["MAX_REGISTERED_USERS"] ?? "250", 10);

// 10-second in-memory cache to prevent DB hammering from polling
let cachedCount: number | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 10_000;

async function getCachedActiveUsers(): Promise<number> {
  const now = Date.now();
  if (cachedCount !== null && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedCount;
  }
  cachedCount = await userRepo.countActiveUsers();
  cacheTimestamp = now;
  return cachedCount;
}

// GET /api/slots — public, no auth required
router.get("/", async (_req, res) => {
  try {
    if (MAX_REGISTERED_USERS <= 0) {
      res.json({ total: 0, used: 0, remaining: 0, unlimited: true });
      return;
    }
    const used = await getCachedActiveUsers();
    const remaining = Math.max(0, MAX_REGISTERED_USERS - used);
    res.json({
      total: MAX_REGISTERED_USERS,
      used,
      remaining,
      unlimited: false,
    });
  } catch (err) {
    log.error("slots endpoint failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to retrieve slot information" });
  }
});

export default router;
