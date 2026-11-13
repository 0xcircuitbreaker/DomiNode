import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createKeyedLimiter } from "./limiter.js";

/**
 * GET /v1/probe/echo?nonce=<16..64 [A-Za-z0-9_-]> (DESIGN.md §13 commit 26).
 * Canary target for the gateway probe job: echoes the caller's IP (the node's
 * egress when reached through a relay node) and the nonce. Never cached.
 */
const router = Router();
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const limiter = createKeyedLimiter(120, 60_000);
// Gateway canary probes carry X-DN-Probe-Auth = hex HMAC-SHA256(PROBE_AUTH_SECRET,
// nonce) and use their own budget, so a public flood of this unauthenticated
// endpoint cannot starve node verification.
const gatewayLimiter = createKeyedLimiter(6000, 60_000, 10);

export function isGatewayProbe(nonce: string, header: unknown, secret = process.env["PROBE_AUTH_SECRET"]): boolean {
  if (!secret || secret.length < 32 || typeof header !== "string" || !/^[0-9a-f]{64}$/.test(header)) return false;
  const want = createHmac("sha256", secret).update(nonce).digest();
  return timingSafeEqual(want, Buffer.from(header, "hex"));
}

export function normalizeIp(raw: string | undefined): string {
  let ip = (raw ?? "").trim();
  if (ip.startsWith("::ffff:") && ip.includes(".")) ip = ip.slice(7);
  const z = ip.indexOf("%");
  return z >= 0 ? ip.slice(0, z) : ip;
}

router.get("/probe/echo", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const ip = normalizeIp(req.ip ?? req.socket.remoteAddress);
  const nonce = req.query["nonce"];
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
    res.status(400).json({ error: "nonce must be 16-64 characters of [A-Za-z0-9_-]" });
    return;
  }
  const allowed = isGatewayProbe(nonce, req.headers["x-dn-probe-auth"]) ? gatewayLimiter.hit("gateway") : limiter.hit(ip);
  if (!ip || !allowed) {
    res.status(429).json({ error: "Too many probe requests" });
    return;
  }
  res.json({ ip, nonce });
});

export function _resetProbeLimiter(): void {
  limiter.reset();
  gatewayLimiter.reset();
}

export default router;
