import { Router } from "express";
import {
  waitlistRepo,
  isValidEmail,
  isDisposableEmail,
  sanitizeString,
  createLogger,
} from "@dominusnode/shared";

const router = Router();
const log = createLogger("api:waitlist");

// ─── Per-IP rate limiting for waitlist join (3 per IP per hour) ──────
const MAX_WAITLIST_PER_IP = 3;
const WAITLIST_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_WAITLIST_MAP_SIZE = 50_000;
const waitlistRateMap = new Map<string, { count: number; windowStart: number }>();

function checkWaitlistRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = waitlistRateMap.get(ip);
  if (!entry || now - entry.windowStart > WAITLIST_WINDOW_MS) {
    if (waitlistRateMap.size >= MAX_WAITLIST_MAP_SIZE) {
      const firstKey = waitlistRateMap.keys().next().value;
      if (firstKey) waitlistRateMap.delete(firstKey);
    }
    waitlistRateMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_WAITLIST_PER_IP;
}

// Periodic cleanup every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of waitlistRateMap) {
    if (now - entry.windowStart > WAITLIST_WINDOW_MS) {
      waitlistRateMap.delete(ip);
    }
  }
}, 300_000).unref();

// POST /api/waitlist/join — public, no auth
router.post("/join", async (req, res) => {
  try {
    const email = sanitizeString(req.body.email ?? "", 254).toLowerCase();

    if (!isValidEmail(email)) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }

    if (isDisposableEmail(email)) {
      res.status(400).json({ error: "Disposable email addresses are not allowed." });
      return;
    }

    const clientIp = req.ip ?? "unknown";
    if (!checkWaitlistRateLimit(clientIp)) {
      res.status(429).json({ error: "Too many requests. Please try again later." });
      return;
    }

    // Anti-enumeration: same success response whether new, duplicate, or existing user
    try {
      await waitlistRepo.addToWaitlist(email, clientIp);
      log.info("waitlist entry added", { email: email.slice(0, 3) + "***" });
    } catch (err) {
      // UNIQUE constraint violation (duplicate email) — still return success
      if (err instanceof Error && (err.message.includes("duplicate") || err.message.includes("unique"))) {
        // Silently succeed for anti-enumeration
      } else {
        throw err;
      }
    }

    res.json({ message: "You're on the list! We'll email you when a slot opens." });
  } catch (err) {
    log.error("waitlist join failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to join waitlist" });
  }
});

// GET /api/waitlist/count — public
router.get("/count", async (_req, res) => {
  try {
    const pending = await waitlistRepo.countPending();
    res.json({ pending });
  } catch (err) {
    log.error("waitlist count failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to get waitlist count" });
  }
});

export default router;
