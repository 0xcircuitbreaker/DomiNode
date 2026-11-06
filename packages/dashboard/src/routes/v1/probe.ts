import { Router } from "express";
import { createKeyedLimiter } from "./limiter.js";

/**
 * GET /v1/probe/echo?nonce=<16..64 [A-Za-z0-9_-]> (DESIGN.md §13 commit 26).
 * Canary target for the gateway probe job: echoes the caller's IP (the node's
 * egress when reached through a relay node) and the nonce. Never cached.
 */
const router = Router();
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const limiter = createKeyedLimiter(120, 60_000);

export function normalizeIp(raw: string | undefined): string {
  let ip = (raw ?? "").trim();
  if (ip.startsWith("::ffff:") && ip.includes(".")) ip = ip.slice(7);
  const z = ip.indexOf("%");
  return z >= 0 ? ip.slice(0, z) : ip;
}

router.get("/probe/echo", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const ip = normalizeIp(req.ip ?? req.socket.remoteAddress);
  if (!ip || !limiter.hit(ip)) {
    res.status(429).json({ error: "Too many probe requests" });
    return;
  }
  const nonce = req.query["nonce"];
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
    res.status(400).json({ error: "nonce must be 16-64 characters of [A-Za-z0-9_-]" });
    return;
  }
  res.json({ ip, nonce });
});

export function _resetProbeLimiter(): void {
  limiter.reset();
}

export default router;
