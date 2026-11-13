import { Router } from "express";
import * as crypto from "node:crypto";
import {
  userRepo,
  waitlistRepo,
  walletChallengeRepo,
  refreshTokenRepo,
  mfaRepo,
  createTokenPair,
  signMfaChallengeToken,
  hashPassword,
  createLogger,
  sanitizeString,
  isValidEvmAddress,
  generateWalletNonce,
  buildSignMessage,
  walletToSyntheticEmail,
  getPool,
  WALLET_CHALLENGE_TTL_MS,
  referralRepo,
  starterCreditRepo,
  createProxySessionToken,
} from "@dominusnode/shared";
import { recoverSignerAddress } from "../helpers/verify-signature.js";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { setAuthCookies } from "../helpers/cookies.js";

import { isVerifiedAgent, isGlobalVerifiedAgent, isVerifiedAgentAsync, getAgentMultiplier } from "../helpers/agent-rate-limit.js";
import { ipRateKey } from "../helpers/ip-key.js";

const router = Router();
const log = createLogger("api:wallet-auth");

const AGENT_RATE_LIMIT_MULTIPLIER = getAgentMultiplier();

// Validate domain format at startup to prevent cross-site signature replay
const DOMINUSNODE_DOMAIN = process.env["DOMINUSNODE_DOMAIN"] ?? "dominusnode.com";
if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(DOMINUSNODE_DOMAIN)) {
  throw new Error(`Invalid DOMINUSNODE_DOMAIN: "${DOMINUSNODE_DOMAIN}". Must be a valid domain name.`);
}

// ─── Global registration cap (Alpha: 2500, 0 = unlimited) ───
// Guard against NaN — NaN <= 0 = false, NaN < X = false → blocks all registrations silently
const _parsedMaxUsers = parseInt(process.env["MAX_REGISTERED_USERS"] ?? "2500", 10);
const MAX_REGISTERED_USERS = Number.isFinite(_parsedMaxUsers) ? _parsedMaxUsers : 2500;

async function checkGlobalRegistrationCap(): Promise<boolean> {
  if (MAX_REGISTERED_USERS <= 0) return true; // 0 = unlimited (production)
  const currentCount = await userRepo.countActiveUsers();
  return currentCount < MAX_REGISTERED_USERS;
}

// ─── In-memory rate limiting for challenge requests ──────────────────
const MAX_CHALLENGES_PER_IP = 5;
const CHALLENGE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CHALLENGE_MAP_SIZE = 50_000;
const challengeRateMap = new Map<string, { count: number; windowStart: number }>();

function checkChallengeRateLimit(rawIp: string, isAgent: boolean = false): boolean {
  const ip = ipRateKey(rawIp);
  const now = Date.now();
  const limit = isAgent ? MAX_CHALLENGES_PER_IP * AGENT_RATE_LIMIT_MULTIPLIER : MAX_CHALLENGES_PER_IP;
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
  return entry.count <= limit;
}

// ─── In-memory rate limiting for /verify endpoint ───────────────────
const MAX_VERIFY_PER_IP = 10;
const VERIFY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_VERIFY_MAP_SIZE = 50_000;
const verifyRateMap = new Map<string, { count: number; windowStart: number }>();

function checkVerifyRateLimit(rawIp: string, isAgent: boolean = false): boolean {
  const ip = ipRateKey(rawIp);
  const now = Date.now();
  const limit = isAgent ? MAX_VERIFY_PER_IP * AGENT_RATE_LIMIT_MULTIPLIER : MAX_VERIFY_PER_IP;
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
  return entry.count <= limit;
}

// ─── In-memory rate limiting for /link endpoint ─────────────────────
const MAX_LINK_PER_IP = 10;
const LINK_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_LINK_MAP_SIZE = 50_000;
const linkRateMap = new Map<string, { count: number; windowStart: number }>();

function checkLinkRateLimit(rawIp: string, isAgent: boolean = false): boolean {
  const ip = ipRateKey(rawIp);
  const now = Date.now();
  const limit = isAgent ? MAX_LINK_PER_IP * AGENT_RATE_LIMIT_MULTIPLIER : MAX_LINK_PER_IP;
  const entry = linkRateMap.get(ip);
  if (!entry || now - entry.windowStart > LINK_WINDOW_MS) {
    if (linkRateMap.size >= MAX_LINK_MAP_SIZE) {
      const firstKey = linkRateMap.keys().next().value;
      if (firstKey) linkRateMap.delete(firstKey);
    }
    linkRateMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= limit;
}

// Per-IP registration rate limit for wallet auth (matches email registration limit)
const MAX_WALLET_REGISTRATIONS_PER_IP = 3;
const WALLET_REG_WINDOW_MS = 60 * 60 * 1000;
const MAX_WALLET_REG_MAP_SIZE = 50_000;
const walletRegistrationLog = new Map<string, number[]>();

function checkWalletRegistrationRateLimit(rawIp: string, isAgent: boolean = false): boolean {
  const ip = ipRateKey(rawIp);
  const now = Date.now();
  const limit = isAgent ? MAX_WALLET_REGISTRATIONS_PER_IP * AGENT_RATE_LIMIT_MULTIPLIER : MAX_WALLET_REGISTRATIONS_PER_IP;
  let timestamps = walletRegistrationLog.get(ip);
  if (!timestamps) {
    if (walletRegistrationLog.size >= MAX_WALLET_REG_MAP_SIZE) {
      const firstKey = walletRegistrationLog.keys().next().value;
      if (firstKey) walletRegistrationLog.delete(firstKey);
    }
    timestamps = [];
    walletRegistrationLog.set(ip, timestamps);
  }
  while (timestamps.length > 0 && timestamps[0]! < now - WALLET_REG_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= limit) return false;
  timestamps.push(now);
  return true;
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
  for (const [ip, entry] of linkRateMap) {
    if (now - entry.windowStart > LINK_WINDOW_MS) {
      linkRateMap.delete(ip);
    }
  }
  // Cleanup expired wallet registration rate limit entries
  for (const [ip, timestamps] of walletRegistrationLog) {
    while (timestamps.length > 0 && timestamps[0]! < now - WALLET_REG_WINDOW_MS) {
      timestamps.shift();
    }
    if (timestamps.length === 0) walletRegistrationLog.delete(ip);
  }
  // Cleanup expired proxy session rate limit entries
  for (const [ip, entry] of proxySessionRateMap) {
    if (now - entry.windowStart > PROXY_SESSION_WINDOW_MS) {
      proxySessionRateMap.delete(ip);
    }
  }
  for (const [uid, entry] of proxySessionUserRateMap) {
    if (now - entry.windowStart > PROXY_SESSION_USER_WINDOW_MS) {
      proxySessionUserRateMap.delete(uid);
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

    // Reject if IP cannot be determined (don't fall back to "unknown")
    const clientIp = req.ip;
    if (!clientIp) {
      res.status(400).json({ error: "Unable to determine client IP" });
      return;
    }

    // In-memory rate limit — verified MCP agents (global secret or per-agent das_) skip
    const { verified: isAgentChallenge } = await isVerifiedAgentAsync(req);
    if (!isAgentChallenge && !checkChallengeRateLimit(clientIp)) {
      res.status(429).json({ error: "Too many challenge requests. Try again later." });
      return;
    }

    // DB-level defense in depth: per-IP limit — agents skip
    if (!isAgentChallenge) {
      const activeCount = await walletChallengeRepo.countActiveChallengesForIp(clientIp);
      if (activeCount >= MAX_CHALLENGES_PER_IP) {
        res.status(429).json({ error: "Too many pending challenges. Try again later." });
        return;
      }
    }

    // Per-address rate limit to prevent address-targeted challenge exhaustion
    const addressCount = await walletChallengeRepo.countActiveChallengesForAddress(address);
    if (addressCount >= 10) {
      res.status(429).json({ error: "Too many pending challenges for this address. Try again later." });
      return;
    }

    const nonce = generateWalletNonce();
    const issuedAt = new Date();
    const message = buildSignMessage(DOMINUSNODE_DOMAIN, address, nonce, issuedAt);

    await walletChallengeRepo.createChallenge(address, nonce, clientIp);

    log.info("wallet challenge issued", { address: address.slice(0, 10) + "..." });

    // Return both legacy fields (message/nonce) and SDK-expected fields (challenge/expiresAt)
    const expiresAt = new Date(issuedAt.getTime() + WALLET_CHALLENGE_TTL_MS).toISOString();
    res.json({ message, nonce, challenge: message, expiresAt });
  } catch (err) {
    log.error("wallet challenge failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Challenge generation failed" });
  }
});

// ─── POST /verify ────────────────────────────────────────────────────
// Verify signature, create/login account, return JWT
router.post("/verify", async (req, res) => {
  try {
    // Reject if IP cannot be determined (don't fall back to "unknown")
    const clientIp = req.ip;
    if (!clientIp) {
      res.status(400).json({ error: "Unable to determine client IP" });
      return;
    }

    // Rate limit signature verification per IP — verified MCP agents skip
    const isAgentVerify = isGlobalVerifiedAgent(req);
    if (!isAgentVerify && !checkVerifyRateLimit(clientIp)) {
      res.status(429).json({ error: "Too many verification attempts. Try again later." });
      return;
    }

    const address = sanitizeString(req.body.address ?? "", 42).toLowerCase();
    const signature = sanitizeString(req.body.signature ?? "", 200);

    if (!isValidEvmAddress(address)) {
      res.status(400).json({ error: "Invalid Ethereum address" });
      return;
    }

    // Validate signature is hex-encoded EIP-191 format (0x + 130 hex chars = 65 bytes)
    if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      res.status(400).json({ error: "Invalid signature format" });
      return;
    }

    // Atomically consume the challenge, bound to originating IP
    const challenge = await walletChallengeRepo.consumeChallenge(address, clientIp);
    if (!challenge) {
      res.status(401).json({ error: "No valid challenge found. Request a new one." });
      return;
    }

    // Use challenge.address (DB truth) not request body address for message rebuild
    const message = buildSignMessage(DOMINUSNODE_DOMAIN, challenge.address, challenge.nonce, challenge.created_at);

    // Verify the EIP-191 signature
    const recoveredAddress = recoverSignerAddress(message, signature);
    // Timing-safe comparison to prevent address-guessing side-channel
    if (!recoveredAddress || recoveredAddress.length !== challenge.address.length
        || !crypto.timingSafeEqual(Buffer.from(recoveredAddress), Buffer.from(challenge.address))) {
      // Audit log failed signature verification
      log.warn("wallet signature verification failed", { address: address.slice(0, 10) + "...", ip: clientIp });
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    // Check if user already exists with this wallet
    let user = await userRepo.findUserByWalletAddress(address);
    let isNewUser = false;

    if (!user) {
      // Per-IP registration rate limit for wallet auth — verified agents skip
      if (!isAgentVerify && !checkWalletRegistrationRateLimit(clientIp)) {
        res.status(429).json({ error: "Too many new accounts from this IP. Try again later." });
        return;
      }

      // Global registration cap (Alpha: 250 slots)
      if (!(await checkGlobalRegistrationCap())) {
        log.warn("wallet registration rejected: global cap reached", { ip: clientIp, cap: MAX_REGISTERED_USERS });
        res.status(403).json({ error: `Registration is currently closed. All ${MAX_REGISTERED_USERS} alpha slots are filled.` });
        return;
      }

      // Create new user with synthetic email and unusable password
      // Hash through bcrypt so password_hash column is indistinguishable from real hashes.
      // The random value is discarded — nobody can ever log in with this password.
      const syntheticEmail = walletToSyntheticEmail(address);
      const unusablePassword = await hashPassword(crypto.randomBytes(64).toString("hex"));

      // Wrap user creation + wallet creation in a transaction to prevent
      // partial state (user exists without wallet) on intermediate failure.
      // Note: createWalletUser INSERT already sets email_verified=true, no separate call needed.
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const userResult = await client.query(
          `INSERT INTO users (email, password_hash, wallet_address, email_verified)
           VALUES ($1, $2, $3, true)
           RETURNING id, email, created_at, status, password_changed_at, is_admin, admin_role, wallet_address, log_target_hosts, email_verified`,
          [syntheticEmail, unusablePassword, address.toLowerCase()],
        );
        const newUser = userResult.rows[0];
        await client.query(
          `INSERT INTO wallets (user_id, balance_cents) VALUES ($1, 0)`,
          [newUser.id],
        );
        await client.query("COMMIT");
        user = { ...newUser, password_hash: "", wallet_address: newUser.wallet_address ?? null, log_target_hosts: newUser.log_target_hosts ?? false, email_verified: newUser.email_verified ?? false };
        isNewUser = true;
        // Audit log wallet user creation
        log.info("wallet user created", { userId: newUser.id, address: address.slice(0, 10) + "...", ip: clientIp });
        // Starter credit (LAUNCH_PLAN §5.2): once per new principal, capped; never blocks sign-in.
        try {
          const g = await starterCreditRepo.grantStarterCredit({ userId: newUser.id, fundingSource: address.toLowerCase(), clientIp: clientIp ?? null });
          log.info("starter credit decision", { userId: newUser.id, granted: g.granted, reason: g.granted ? null : g.reason });
        } catch (scErr) {
          log.warn("starter credit grant failed (non-blocking)", { userId: newUser.id, error: scErr instanceof Error ? scErr.message : String(scErr) });
        }
        // Mark waitlist entry as registered (non-blocking, best-effort)
        waitlistRepo.markRegistered(syntheticEmail).catch(() => {});
        // Referral code processing (non-blocking)
        const referralCode = typeof req.body?.referralCode === "string" ? req.body.referralCode.trim().toUpperCase() : "";
        if (referralCode && /^[A-Za-z0-9]{4,20}$/.test(referralCode)) {
          const refHash = crypto.createHash("sha256").update(referralCode).digest("hex");
          referralRepo.redeemReferralCode(refHash, newUser.id).catch((refErr) => {
            log.warn("wallet-auth referral code redemption failed (non-blocking)", {
              userId: newUser.id,
              error: refErr instanceof Error ? refErr.message : String(refErr),
            });
          });
        }
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
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
      } finally {
        client.release();
      }
    }

    // TypeScript can't track that user is always non-null after the try/catch above
    if (!user) {
      res.status(500).json({ error: "Registration failed" });
      return;
    }

    if (user.status !== "active") {
      res.status(403).json({ error: "Account is suspended or disabled" });
      return;
    }

    // Check if MFA is enabled for existing wallet users — wallet key compromise
    // must not bypass MFA. New users can't have MFA yet, so skip for them.
    if (!isNewUser) {
      const mfaConfig = await mfaRepo.findMfaConfigByUserId(user.id);
      if (mfaConfig?.enabled) {
        const challengeToken = signMfaChallengeToken({ userId: user.id, email: user.email });
        log.info("MFA challenge issued for wallet auth", { userId: user.id });

        if (isBrowserClient(req)) {
          res.cookie("dominusnode_mfa_challenge", challengeToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            maxAge: 5 * 60 * 1000,
            path: "/api/auth/mfa",
          });
          res.json({ mfaRequired: true });
        } else {
          res.json({ mfaRequired: true, mfaChallengeToken: challengeToken });
        }
        return;
      }
    }

    // Issue tokens
    const tokens = createTokenPair({ userId: user.id, email: user.email, isAdmin: user.is_admin, adminRole: user.admin_role ?? "none" });
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
      admin_role: user.admin_role ?? "none",
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
    // Rate limit /link endpoint (CPU-intensive ecrecover)
    // Reject if IP cannot be determined (don't fall back to "unknown")
    const clientIp = req.ip;
    if (!clientIp) {
      res.status(400).json({ error: "Unable to determine client IP" });
      return;
    }
    const isAgentLink = isVerifiedAgent(req);
    if (!isAgentLink && !checkLinkRateLimit(clientIp)) {
      res.status(429).json({ error: "Too many verification attempts. Try again later." });
      return;
    }

    const { userId } = (req as AuthenticatedRequest).user;
    const address = sanitizeString(req.body.address ?? "", 42).toLowerCase();
    const signature = sanitizeString(req.body.signature ?? "", 200);

    if (!isValidEvmAddress(address)) {
      res.status(400).json({ error: "Invalid Ethereum address" });
      return;
    }

    // Validate signature is hex-encoded EIP-191 format
    if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      res.status(400).json({ error: "Invalid signature format" });
      return;
    }

    // Check if wallet is already linked to another account
    const existingUser = await userRepo.findUserByWalletAddress(address);
    if (existingUser) {
      res.status(409).json({ error: "This wallet is already linked to an account" });
      return;
    }

    // Consume challenge bound to originating IP
    const challenge = await walletChallengeRepo.consumeChallenge(address, clientIp);
    if (!challenge) {
      res.status(401).json({ error: "No valid challenge found. Request a new one." });
      return;
    }

    // Use challenge.address (DB truth) not request body address
    const message = buildSignMessage(DOMINUSNODE_DOMAIN, challenge.address, challenge.nonce, challenge.created_at);
    const recoveredAddress = recoverSignerAddress(message, signature);
    // Timing-safe comparison to prevent address-guessing side-channel
    if (!recoveredAddress || recoveredAddress.length !== challenge.address.length
        || !crypto.timingSafeEqual(Buffer.from(recoveredAddress), Buffer.from(challenge.address))) {
      log.warn("wallet link signature verification failed", { userId, address: address.slice(0, 10) + "...", ip: clientIp });
      res.status(401).json({ error: "Signature verification failed" });
      return;
    }

    // Link wallet to user — catch unique constraint violations (TOCTOU race)
    let linked: boolean;
    try {
      linked = await userRepo.linkWalletAddress(userId, address);
    } catch (err) {
      if (err instanceof Error && (err.message.includes("duplicate") || err.message.includes("unique"))) {
        res.status(409).json({ error: "This wallet is already linked to an account" });
        return;
      }
      throw err;
    }
    if (!linked) {
      res.status(409).json({ error: "Account already has a wallet linked" });
      return;
    }

    // Audit log wallet link
    log.info("wallet linked to account", { userId, address: address.slice(0, 10) + "...", ip: clientIp });
    // Return both legacy fields (linked/wallet_address) and SDK-expected fields (success/walletAddress)
    res.json({ linked: true, wallet_address: address, success: true, walletAddress: address });
  } catch (err) {
    log.error("wallet link failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Wallet link failed" });
  }
});

// ─── POST /proxy-session ─────────────────────────────────────────────
// Issue an HMAC-based proxy session token for wallet users.
// This lets wallet users authenticate to the proxy without API keys.
// The token is verified via HMAC (~3-5μs), same speed as API key hash.

// Rate limit: max 10 proxy session tokens per IP per 15 minutes + max 20 per user per hour
const MAX_PROXY_SESSIONS_PER_IP = 10;
const MAX_PROXY_SESSIONS_PER_USER = 20;
const PROXY_SESSION_WINDOW_MS = 15 * 60 * 1000;
const PROXY_SESSION_USER_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PROXY_SESSION_MAP_SIZE = 50_000;
const proxySessionRateMap = new Map<string, { count: number; windowStart: number }>();
const proxySessionUserRateMap = new Map<string, { count: number; windowStart: number }>();

function checkProxySessionRateLimit(rawIp: string): boolean {
  const ip = ipRateKey(rawIp);
  const now = Date.now();
  const entry = proxySessionRateMap.get(ip);
  if (!entry || now - entry.windowStart > PROXY_SESSION_WINDOW_MS) {
    if (proxySessionRateMap.size >= MAX_PROXY_SESSION_MAP_SIZE) {
      let toDelete = Math.floor(MAX_PROXY_SESSION_MAP_SIZE / 2);
      for (const key of proxySessionRateMap.keys()) {
        if (toDelete <= 0) break;
        proxySessionRateMap.delete(key);
        toDelete--;
      }
    }
    proxySessionRateMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= MAX_PROXY_SESSIONS_PER_IP) return false;
  entry.count++;
  return true;
}

function checkProxySessionUserRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = proxySessionUserRateMap.get(userId);
  if (!entry || now - entry.windowStart > PROXY_SESSION_USER_WINDOW_MS) {
    if (proxySessionUserRateMap.size >= MAX_PROXY_SESSION_MAP_SIZE) {
      let toDelete = Math.floor(MAX_PROXY_SESSION_MAP_SIZE / 2);
      for (const key of proxySessionUserRateMap.keys()) {
        if (toDelete <= 0) break;
        proxySessionUserRateMap.delete(key);
        toDelete--;
      }
    }
    proxySessionUserRateMap.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= MAX_PROXY_SESSIONS_PER_USER) return false;
  entry.count++;
  return true;
}

router.post("/proxy-session", requireAuth, async (req, res) => {
  try {
    const clientIp = req.ip;
    if (!clientIp) {
      res.status(400).json({ error: "Unable to determine client IP" });
      return;
    }
    if (!checkProxySessionRateLimit(clientIp)) {
      res.status(429).json({ error: "Too many proxy session requests. Try again later." });
      return;
    }

    const { userId } = (req as AuthenticatedRequest).user;

    // Per-user rate limit (max 20 tokens per hour)
    if (!checkProxySessionUserRateLimit(userId)) {
      res.status(429).json({ error: "Too many proxy session tokens generated. Try again later." });
      return;
    }

    // Look up user to get wallet address
    const user = await userRepo.findUserById(userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (user.status !== "active") {
      res.status(403).json({ error: "Account is not active" });
      return;
    }
    if (!user.email_verified) {
      res.status(403).json({ error: "Email verification required", code: "EMAIL_NOT_VERIFIED" });
      return;
    }
    if (!user.wallet_address) {
      res.status(400).json({ error: "No wallet linked to this account. Link a wallet first." });
      return;
    }

    // Optional TTL in minutes (default 60, max 1440 = 24h)
    const rawTtlMinutes = parseInt(String(req.body.ttlMinutes ?? "60"), 10);
    const ttlMinutes = Number.isFinite(rawTtlMinutes) && rawTtlMinutes > 0
      ? Math.min(rawTtlMinutes, 1440) : 60;
    const ttlMs = ttlMinutes * 60 * 1000;

    const { token, expiresAt } = createProxySessionToken(user.id, user.wallet_address, ttlMs);

    log.info("proxy session token issued", {
      userId: user.id,
      walletPrefix: user.wallet_address.slice(0, 10) + "...",
      ttlMinutes,
      ip: clientIp,
    });

    // Usage example shows truncated token — full token only in proxyToken field
    const tokenPreview = token.slice(0, 20) + "...";
    res.json({
      proxyToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      ttlMinutes,
      usage: `curl -x http://country-US:${tokenPreview}@proxy:8080 https://httpbin.org/ip`,
    });
  } catch (err) {
    log.error("proxy session creation failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to create proxy session" });
  }
});

export default router;
