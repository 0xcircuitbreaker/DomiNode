import { Router } from "express";
import * as crypto from "node:crypto";
import {
  userRepo,
  walletRepo,
  walletChallengeRepo,
  refreshTokenRepo,
  createTokenPair,
  createLogger,
  sanitizeString,
  isValidEvmAddress,
  generateWalletNonce,
  buildSignMessage,
  walletToSyntheticEmail,
  isWalletEmail,
} from "@dominusnode/shared";
import { recoverSignerAddress } from "../helpers/verify-signature.js";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { setAuthCookies } from "../helpers/cookies.js";

const router = Router();
const log = createLogger("api:wallet-auth");

const DOMINUSNODE_DOMAIN = process.env["DOMINUSNODE_DOMAIN"] ?? "dominusnode.io";

// ─── In-memory rate limiting for challenge requests ──────────────────
const MAX_CHALLENGES_PER_IP = 5;
const CHALLENGE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CHALLENGE_MAP_SIZE = 50_000;
const challengeRateMap = new Map<string, { count: number; windowStart: number }>();

function checkChallengeRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = challengeRateMap.get(ip);
  if (!entry || now - entry.windowStart > CHALLENGE_WINDOW_MS) {
    if (challengeRateMap.size >= MAX_CHALLENGE_MAP_SIZE) {
      const firstKey = challengeRateMap.keys().next().value;
      if (firstKey) challengeRateMap.delete(firstKey);
    }
    challengeRateMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_CHALLENGES_PER_IP;
}

// ─── R18 H-1: In-memory rate limiting for /verify endpoint ──────────
const MAX_VERIFY_PER_IP = 10;
const VERIFY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_VERIFY_MAP_SIZE = 50_000;
const verifyRateMap = new Map<string, { count: number; windowStart: number }>();

function checkVerifyRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = verifyRateMap.get(ip);
  if (!entry || now - entry.windowStart > VERIFY_WINDOW_MS) {
    if (verifyRateMap.size >= MAX_VERIFY_MAP_SIZE) {
      const firstKey = verifyRateMap.keys().next().value;
      if (firstKey) verifyRateMap.delete(firstKey);
    }
    verifyRateMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_VERIFY_PER_IP;
}

// Periodic cleanup of expired rate limit entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of challengeRateMap) {
    if (now - entry.windowStart > CHALLENGE_WINDOW_MS) {
      challengeRateMap.delete(ip);
    }
  }
  for (const [ip, entry] of verifyRateMap) {
    if (now - entry.windowStart > VERIFY_WINDOW_MS) {
      verifyRateMap.delete(ip);
    }
  }
}, 300_000).unref();

// Periodic cleanup of expired wallet challenges (every 10 min)
const challengePurgeInterval = setInterval(async () => {
  try {
    const purged = await walletChallengeRepo.purgeExpiredChallenges();
    if (purged > 0) {
      log.info("purged expired wallet challenges", { count: purged });
    }
  } catch (err) {
    log.error("wallet challenge purge failed", { error: err instanceof Error ? err.message : String(err) });
  }
}, 600_000);
challengePurgeInterval.unref();

// Determine if the request is from the browser frontend
const ALLOWED_ORIGINS = (process.env["CORS_ORIGINS"] ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim());

function isBrowserClient(req: import("express").Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

// ─── POST /challenge ─────────────────────────────────────────────────
// Issue a nonce for the client to sign with their wallet
router.post("/challenge", async (req, res) => {
  try {
    const address = sanitizeString(req.body.address ?? "", 42).toLowerCase();

    if (!isValidEvmAddress(address)) {
      res.status(400).json({ error: "Invalid Ethereum address" });
      return;
    }

    const clientIp = req.ip ?? "unknown";

    // In-memory rate limit
    if (!checkChallengeRateLimit(clientIp)) {
      res.status(429).json({ error: "Too many challenge requests. Try again later." });
      return;
    }

    // DB-level defense in depth
    const activeCount = await walletChallengeRepo.countActiveChallengesForIp(clientIp);
    if (activeCount >= MAX_CHALLENGES_PER_IP) {
      res.status(429).json({ error: "Too many pending challenges. Try again later." });
      return;
    }

    const nonce = generateWalletNonce();
    const issuedAt = new Date();
    const message = buildSignMessage(DOMINUSNODE_DOMAIN, address, nonce, issuedAt);

    await walletChallengeRepo.createChallenge(address, nonce, clientIp);

    log.info("wallet challenge issued", { address: address.slice(0, 10) + "..." });

    res.json({ message, nonce });
  } catch (err) {
    log.error("wallet challenge failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Challenge generation failed" });
  }
});

// ─── POST /verify ────────────────────────────────────────────────────
// Verify signature, create/login account, return JWT
router.post("/verify", async (req, res) => {
  try {
    const clientIp = req.ip ?? "unknown";

    // R18 H-1: Rate limit signature verification per IP (CPU-intensive ecrecover)
    if (!checkVerifyRateLimit(clientIp)) {
      res.status(429).json({ error: "Too many verification attempts. Try again later." });
      return;
    }

    const address = sanitizeString(req.body.address ?? "", 42).toLowerCase();
    const signature = sanitizeString(req.body.signature ?? "", 200);

    if (!isValidEvmAddress(address)) {
      res.status(400).json({ error: "Invalid Ethereum address" });
      return;
    }

    if (!signature || signature.length < 130) {
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    // R18 H-4: Atomically consume the challenge, bound to originating IP
    const challenge = await walletChallengeRepo.consumeChallenge(address, clientIp);
    if (!challenge) {
      res.status(401).json({ error: "No valid challenge found. Request a new one." });
      return;
    }

    // Rebuild the message that was signed
    const message = buildSignMessage(DOMINUSNODE_DOMAIN, address, challenge.nonce, challenge.created_at);

    // Verify the EIP-191 signature
    const recoveredAddress = recoverSignerAddress(message, signature);
    if (!recoveredAddress || recoveredAddress !== address) {
      // R18 H-6: Audit log failed signature verification
      log.warn("wallet signature verification failed", { address: address.slice(0, 10) + "...", ip: clientIp });
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    // Check if user already exists with this wallet
    let user = await userRepo.findUserByWalletAddress(address);
    let isNewUser = false;

    if (!user) {
      // Create new user with synthetic email and unusable password
      const syntheticEmail = walletToSyntheticEmail(address);
      const unusablePassword = `$wallet$${crypto.randomBytes(32).toString("hex")}`;

      try {
        user = await userRepo.createWalletUser(address, syntheticEmail, unusablePassword);
        await walletRepo.createWallet(user.id);
        isNewUser = true;
        // R18 H-6: Audit log wallet user creation
        log.info("wallet user created", { userId: user.id, address: address.slice(0, 10) + "...", ip: clientIp });
      } catch (err) {
        // Unique constraint — user was created between our check and insert (race condition)
        if (err instanceof Error && (err.message.includes("duplicate") || err.message.includes("unique"))) {
          user = await userRepo.findUserByWalletAddress(address);
          if (!user) {
            res.status(500).json({ error: "Registration failed" });
            return;
          }
        } else {
          throw err;
        }
      }
    }

    if (user.status !== "active") {
      res.status(403).json({ error: "Account is suspended or disabled" });
      return;
    }

    // Issue tokens
    const tokens = createTokenPair({ userId: user.id, email: user.email, isAdmin: user.is_admin });
    const familyId = refreshTokenRepo.newFamilyId();
    const tokenHash = refreshTokenRepo.hashToken(tokens.refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await refreshTokenRepo.storeToken(user.id, tokenHash, familyId, expiresAt);

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

    const userPayload = {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      is_admin: user.is_admin ?? false,
      wallet_address: user.wallet_address,
      isNewUser,
    };

    if (isBrowserClient(req)) {
      res.status(isNewUser ? 201 : 200).json({ user: userPayload });
    } else {
      res.status(isNewUser ? 201 : 200).json({
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: userPayload,
      });
    }
  } catch (err) {
    log.error("wallet verify failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Verification failed" });
  }
});

// ─── POST /link ──────────────────────────────────────────────────────
// Link a wallet to an existing email-based account (requires JWT auth)
router.post("/link", requireAuth, async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;
    const address = sanitizeString(req.body.address ?? "", 42).toLowerCase();
    const signature = sanitizeString(req.body.signature ?? "", 200);

    if (!isValidEvmAddress(address)) {
      res.status(400).json({ error: "Invalid Ethereum address" });
      return;
    }

    if (!signature || signature.length < 130) {
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    // Check if wallet is already linked to another account
    const existingUser = await userRepo.findUserByWalletAddress(address);
    if (existingUser) {
      res.status(409).json({ error: "This wallet is already linked to an account" });
      return;
    }

    // R18 H-4: Consume challenge bound to originating IP
    const clientIp = req.ip ?? "unknown";
    const challenge = await walletChallengeRepo.consumeChallenge(address, clientIp);
    if (!challenge) {
      res.status(401).json({ error: "No valid challenge found. Request a new one." });
      return;
    }

    const message = buildSignMessage(DOMINUSNODE_DOMAIN, address, challenge.nonce, challenge.created_at);
    const recoveredAddress = recoverSignerAddress(message, signature);
    if (!recoveredAddress || recoveredAddress !== address) {
      log.warn("wallet link signature verification failed", { userId, address: address.slice(0, 10) + "...", ip: clientIp });
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    // Link wallet to user
    const linked = await userRepo.linkWalletAddress(userId, address);
    if (!linked) {
      res.status(409).json({ error: "Account already has a wallet linked" });
      return;
    }

    // R18 H-6: Audit log wallet link
    log.info("wallet linked to account", { userId, address: address.slice(0, 10) + "...", ip: clientIp });
    res.json({ linked: true, wallet_address: address });
  } catch (err) {
    log.error("wallet link failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Wallet link failed" });
  }
});

export default router;
