import { Router, type Request as ExpressRequest } from "express";
import * as crypto from "node:crypto";
import {
  userRepo,
  waitlistRepo,
  walletRepo,
  refreshTokenRepo,
  mfaRepo,
  powChallengeRepo,
  hashPassword,
  verifyPassword,
  createTokenPair,
  verifyRefreshToken,
  signJwt,
  signMfaChallengeToken,
  verifyMfaChallengeToken,
  hashApiKey,
  isValidEmail,
  isDisposableEmail,
  validatePassword,
  sanitizeString,
  isWalletEmail,
  createLogger,
  generateTotpSecret,
  encryptTotpSecret,
  decryptTotpSecret,
  verifyTotpCode,
  buildTotpUri,
  generateBackupCodes,
  hashBackupCode,
  sendVerificationEmail,
  sendPasswordResetEmail,
  referralRepo,
} from "@dominusnode/shared";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { setAuthCookies, clearAuthCookies, getRefreshCookieName } from "../helpers/cookies.js";
import { isVerifiedAgent, isVerifiedAgentAsync, getAgentMultiplier } from "../helpers/agent-rate-limit.js";

const router = Router();
const log = createLogger("api:auth");

const AGENT_RATE_LIMIT_MULTIPLIER = getAgentMultiplier();

// Determine if the request is from the browser frontend (uses cookies, no tokens needed in body)
const ALLOWED_ORIGINS = (process.env["CORS_ORIGINS"] ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim());

// Simplified — only trust origins explicitly listed in ALLOWED_ORIGINS
function isBrowserClient(req: ExpressRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

// ─── Account lockout after failed logins ──────────────────────────
// Keyed on IP+email to prevent DoS (attacker can't lock arbitrary accounts)
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LOCKOUT_MAP_SIZE = 50_000; // Cap memory usage
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

// Per-IP global login limit across ALL emails — prevents credential stuffing
const MAX_LOGIN_ATTEMPTS_PER_IP = 20; // 20 total login attempts per IP per 15 min
const ipLoginAttempts = new Map<string, { count: number; windowStart: number }>();

function checkIpLoginLimit(ip: string, isAgent: boolean = false): string | null {
  const now = Date.now();
  const entry = ipLoginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOCKOUT_DURATION_MS) {
    return null; // window expired or new IP
  }
  const limit = isAgent ? MAX_LOGIN_ATTEMPTS_PER_IP * AGENT_RATE_LIMIT_MULTIPLIER : MAX_LOGIN_ATTEMPTS_PER_IP;
  if (entry.count >= limit) {
    const remainSec = Math.ceil((entry.windowStart + LOCKOUT_DURATION_MS - now) / 1000);
    return `Too many login attempts from this IP. Try again in ${remainSec} seconds.`;
  }
  return null;
}

function recordIpLoginAttempt(ip: string): void {
  const now = Date.now();
  if (ipLoginAttempts.size >= MAX_LOCKOUT_MAP_SIZE) {
    const firstKey = ipLoginAttempts.keys().next().value;
    if (firstKey) ipLoginAttempts.delete(firstKey);
  }
  const entry = ipLoginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOCKOUT_DURATION_MS) {
    ipLoginAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

// Per-IP verify-key rate limiting — prevents API key brute force / oracle
const MAX_VERIFY_KEY_PER_IP = 10; // 10 attempts per IP per 5-min window
const VERIFY_KEY_WINDOW_MS = 5 * 60 * 1000;
const verifyKeyAttempts = new Map<string, { count: number; windowStart: number }>();

function checkVerifyKeyRateLimit(ip: string, isAgent: boolean = false): boolean {
  const now = Date.now();
  const limit = isAgent ? MAX_VERIFY_KEY_PER_IP * AGENT_RATE_LIMIT_MULTIPLIER : MAX_VERIFY_KEY_PER_IP;
  const entry = verifyKeyAttempts.get(ip);
  if (!entry || now - entry.windowStart > VERIFY_KEY_WINDOW_MS) {
    if (verifyKeyAttempts.size >= MAX_LOCKOUT_MAP_SIZE) {
      const firstKey = verifyKeyAttempts.keys().next().value;
      if (firstKey) verifyKeyAttempts.delete(firstKey);
    }
    verifyKeyAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= limit;
}

// Periodic cleanup of expired IP login attempt entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipLoginAttempts) {
    if (now - entry.windowStart > LOCKOUT_DURATION_MS) {
      ipLoginAttempts.delete(ip);
    }
  }
}, 300_000).unref();

// Periodic cleanup of expired verify-key attempt entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of verifyKeyAttempts) {
    if (now - entry.windowStart > VERIFY_KEY_WINDOW_MS) {
      verifyKeyAttempts.delete(ip);
    }
  }
}, 300_000).unref();

function lockoutKey(ip: string, email: string): string {
  return `${ip}:${email}`;
}

function checkLoginLockout(ip: string, email: string, isAgent: boolean = false): string | null {
  const key = lockoutKey(ip, email);
  const entry = loginAttempts.get(key);
  if (!entry) return null;
  const limit = isAgent ? MAX_LOGIN_ATTEMPTS * AGENT_RATE_LIMIT_MULTIPLIER : MAX_LOGIN_ATTEMPTS;
  if (entry.lockedUntil > Date.now()) {
    const remainSec = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    return `Account temporarily locked. Try again in ${remainSec} seconds.`;
  }
  if (entry.lockedUntil <= Date.now() && entry.count >= limit) {
    loginAttempts.delete(key);
  }
  return null;
}

function recordLoginFailure(ip: string, email: string, isAgent: boolean = false): void {
  const key = lockoutKey(ip, email);
  // Evict oldest entries if map is too large
  if (loginAttempts.size >= MAX_LOCKOUT_MAP_SIZE) {
    const firstKey = loginAttempts.keys().next().value;
    if (firstKey) loginAttempts.delete(firstKey);
  }
  const limit = isAgent ? MAX_LOGIN_ATTEMPTS * AGENT_RATE_LIMIT_MULTIPLIER : MAX_LOGIN_ATTEMPTS;
  const entry = loginAttempts.get(key) ?? { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= limit) {
    entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    log.warn("login locked due to failed attempts", { email, count: entry.count });
  }
  loginAttempts.set(key, entry);
}

function resetLoginAttempts(ip: string, email: string): void {
  loginAttempts.delete(lockoutKey(ip, email));
}

// Periodic cleanup of expired lockout entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (entry.lockedUntil > 0 && entry.lockedUntil <= now) {
      loginAttempts.delete(key);
    }
  }
}, 300_000).unref();

// ─── reCAPTCHA verification ──────────────────────────────────────
const RECAPTCHA_SECRET_KEY = process.env["RECAPTCHA_SECRET_KEY"] ?? "";

// reCAPTCHA v3 score threshold — 0.5 is Google's recommended default.
// Scores range 0.0 (bot) to 1.0 (human). Adjust if needed.
// Guard against NaN — parseFloat("abc") = NaN, NaN < 0.5 = false → silently disables check
const _parsedThreshold = parseFloat(process.env["RECAPTCHA_SCORE_THRESHOLD"] ?? "0.5");
const RECAPTCHA_SCORE_THRESHOLD = Number.isFinite(_parsedThreshold) ? _parsedThreshold : 0.5;

async function verifyRecaptcha(token: string, remoteIp: string, expectedAction?: string): Promise<boolean> {
  if (!RECAPTCHA_SECRET_KEY) return true; // Skip if not configured (dev mode)
  try {
    const resp = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `secret=${encodeURIComponent(RECAPTCHA_SECRET_KEY)}&response=${encodeURIComponent(token)}&remoteip=${encodeURIComponent(remoteIp)}`,
      signal: AbortSignal.timeout(5000),
    });
    const data = (await resp.json()) as { success: boolean; score?: number; action?: string };
    if (!data.success) return false;
    // v3: check score threshold (if score is present)
    if (typeof data.score === "number" && data.score < RECAPTCHA_SCORE_THRESHOLD) {
      log.warn("reCAPTCHA v3 score too low", { score: data.score, action: data.action, ip: remoteIp });
      return false;
    }
    // v3: verify action matches expected (prevents token reuse across endpoints)
    if (expectedAction && data.action && data.action !== expectedAction) {
      log.warn("reCAPTCHA v3 action mismatch", { expected: expectedAction, got: data.action, ip: remoteIp });
      return false;
    }
    return true;
  } catch (err) {
    log.error("reCAPTCHA verification failed", { error: err instanceof Error ? err.message : String(err) });
    return false; // Fail closed — reject if reCAPTCHA service is unreachable
  }
}

// ─── Global registration cap (Alpha: 2500, 0 = unlimited) ───
// Guard against NaN — parseInt("abc") = NaN → comparison always false → blocks all registrations
const _parsedMaxUsersAuth = parseInt(process.env["MAX_REGISTERED_USERS"] ?? "2500", 10);
const MAX_REGISTERED_USERS = Number.isFinite(_parsedMaxUsersAuth) ? _parsedMaxUsersAuth : 2500;

async function checkGlobalRegistrationCap(): Promise<boolean> {
  if (MAX_REGISTERED_USERS <= 0) return true; // 0 = unlimited (production)
  const currentCount = await userRepo.countActiveUsers();
  return currentCount < MAX_REGISTERED_USERS;
}

// ─── Per-IP registration rate limiter (prevents mass signup abuse) ───
const MAX_REGISTRATIONS_PER_IP = 3; // 3 accounts per IP per hour
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_REG_RATE_MAP_SIZE = 50_000;
const registrationLog = new Map<string, number[]>(); // IP -> timestamps

function checkRegistrationRateLimit(ip: string, isAgent: boolean = false): boolean {
  const now = Date.now();
  const limit = isAgent ? MAX_REGISTRATIONS_PER_IP * AGENT_RATE_LIMIT_MULTIPLIER : MAX_REGISTRATIONS_PER_IP;
  let timestamps = registrationLog.get(ip);
  if (!timestamps) {
    if (registrationLog.size >= MAX_REG_RATE_MAP_SIZE) {
      const firstKey = registrationLog.keys().next().value;
      if (firstKey) registrationLog.delete(firstKey);
    }
    timestamps = [];
    registrationLog.set(ip, timestamps);
  }
  while (timestamps.length > 0 && timestamps[0] < now - REGISTRATION_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= limit) {
    return false;
  }
  timestamps.push(now);
  return true;
}

// Cleanup registration rate limit entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of registrationLog) {
    while (timestamps.length > 0 && timestamps[0] < now - REGISTRATION_WINDOW_MS) {
      timestamps.shift();
    }
    if (timestamps.length === 0) registrationLog.delete(ip);
  }
}, 300_000).unref();

// ─── Proof-of-Work challenge ─────────────────────────────────────
// AI agents can solve PoW instead of CAPTCHA for autonomous registration.
// Default difficulty 20 = ~1M hashes = ~2-5 seconds on a modern CPU.
const _parsedPowDifficulty = parseInt(process.env["POW_DIFFICULTY"] ?? "20", 10);
const POW_DIFFICULTY = Number.isFinite(_parsedPowDifficulty) && _parsedPowDifficulty >= 10 && _parsedPowDifficulty <= 32
  ? _parsedPowDifficulty : 20;

// Per-IP PoW challenge rate limit: 10 per minute
const MAX_POW_CHALLENGES_PER_IP = 10;
const POW_CHALLENGE_WINDOW_MS = 60_000;
const MAX_POW_MAP_SIZE = 50_000;
const powChallengeRateMap = new Map<string, number[]>();

function checkPowChallengeRateLimit(ip: string): boolean {
  const now = Date.now();
  let timestamps = powChallengeRateMap.get(ip);
  if (!timestamps) {
    if (powChallengeRateMap.size >= MAX_POW_MAP_SIZE) {
      const firstKey = powChallengeRateMap.keys().next().value;
      if (firstKey) powChallengeRateMap.delete(firstKey);
    }
    timestamps = [];
    powChallengeRateMap.set(ip, timestamps);
  }
  while (timestamps.length > 0 && timestamps[0] < now - POW_CHALLENGE_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= MAX_POW_CHALLENGES_PER_IP) return false;
  timestamps.push(now);
  return true;
}

// Cleanup PoW rate limit map every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of powChallengeRateMap) {
    while (ts.length > 0 && ts[0] < now - POW_CHALLENGE_WINDOW_MS) ts.shift();
    if (ts.length === 0) powChallengeRateMap.delete(ip);
  }
}, 300_000).unref();

/** Count the number of leading zero bits in a buffer */
function countLeadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      bits += 8;
    } else {
      // Count leading zeros of this byte
      let byte = buf[i];
      for (let b = 7; b >= 0; b--) {
        if ((byte & (1 << b)) === 0) {
          bits++;
        } else {
          return bits;
        }
      }
      return bits;
    }
  }
  return bits;
}

// POST /api/auth/pow/challenge — request a PoW puzzle for registration
router.post("/pow/challenge", async (req, res) => {
  try {
    const clientIp = req.ip;
    if (!clientIp) {
      res.status(400).json({ error: "Unable to determine client IP" });
      return;
    }
    if (!checkPowChallengeRateLimit(clientIp)) {
      res.status(429).json({ error: "Too many challenge requests. Try again later." });
      return;
    }

    // DB-level defense in depth: cap active challenges per IP (matches wallet-auth pattern)
    const activeCount = await powChallengeRepo.countActiveChallengesForIp(clientIp);
    if (activeCount >= 5) {
      res.status(429).json({ error: "Too many pending challenges. Try again later." });
      return;
    }

    const prefix = crypto.randomBytes(16).toString("hex"); // 32 hex chars
    const difficulty = POW_DIFFICULTY;

    const challenge = await powChallengeRepo.createChallenge(prefix, difficulty, clientIp);
    const expiresAt = new Date(challenge.created_at.getTime() + powChallengeRepo.POW_CHALLENGE_TTL_MS);

    res.json({
      challengeId: challenge.id,
      prefix: challenge.prefix,
      difficulty: challenge.difficulty,
      algorithm: "sha256",
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    log.error("PoW challenge creation failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to create challenge" });
  }
});

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const email = sanitizeString(req.body.email ?? "", 254).toLowerCase();
    const password = req.body.password ?? "";

    if (!isValidEmail(email)) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }

    // Cap password length to prevent bcrypt DoS (O(n) cost on input length)
    if (password.length > 128) {
      res.status(400).json({ error: "Password exceeds maximum length" });
      return;
    }

    // MCP agent detection: skip reCAPTCHA for authenticated MCP agents
    // Supports both global MCP_AGENT_SECRET and per-agent secrets (das_)
    const agentResult = await isVerifiedAgentAsync(req);
    const isMcpAgentReg = agentResult.verified;

    // Proof-of-Work: AI agents can solve PoW instead of CAPTCHA
    let isPowVerified = false;
    const powChallengeId = typeof req.body?.pow?.challengeId === "string" ? req.body.pow.challengeId : "";
    const powNonce = req.body?.pow?.nonce != null ? String(req.body.pow.nonce) : "";
    if (powChallengeId && powNonce) {
      // Validate UUID format before DB query
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(powChallengeId)) {
        res.status(400).json({ error: "Invalid PoW challenge ID" });
        return;
      }
      // Validate nonce length to prevent abuse
      if (powNonce.length > 32) {
        res.status(400).json({ error: "PoW nonce too long" });
        return;
      }
      const clientIp = req.ip;
      if (!clientIp) {
        res.status(400).json({ error: "Unable to determine client IP" });
        return;
      }
      const challenge = await powChallengeRepo.consumeChallenge(powChallengeId, clientIp);
      if (!challenge) {
        res.status(400).json({ error: "Invalid or expired PoW challenge" });
        return;
      }
      const hash = crypto.createHash("sha256")
        .update(challenge.prefix + powNonce)
        .digest();
      const zeroBits = countLeadingZeroBits(hash);
      if (zeroBits < challenge.difficulty) {
        res.status(400).json({ error: "PoW solution invalid" });
        return;
      }
      isPowVerified = true;
      log.info("PoW verified for registration", { difficulty: challenge.difficulty, ip: clientIp });
    }

    // reCAPTCHA v3 verification (anti-bot) — skip if MCP agent or PoW verified
    const captchaToken = req.body.captchaToken ?? "";
    if (RECAPTCHA_SECRET_KEY && !captchaToken && !isMcpAgentReg && !isPowVerified) {
      res.status(400).json({ error: "CAPTCHA verification required" });
      return;
    }
    if (RECAPTCHA_SECRET_KEY && !isMcpAgentReg && !isPowVerified) {
      const captchaValid = await verifyRecaptcha(captchaToken, req.ip ?? "", "register");
      if (!captchaValid) {
        res.status(400).json({ error: "CAPTCHA verification failed. Please try again." });
        return;
      }
    }

    // Block disposable/temporary email domains (mass signup abuse prevention)
    if (isDisposableEmail(email)) {
      res.status(400).json({ error: "Disposable email addresses are not allowed. Please use a permanent email." });
      return;
    }

    // Block synthetic wallet emails to prevent pre-registration attacks
    if (isWalletEmail(email)) {
      res.status(400).json({ error: "This email domain is reserved. Use wallet authentication instead." });
      return;
    }

    // Per-IP registration rate limit: 3 accounts per IP per hour
    // PoW-verified and MCP agents get elevated limits (3 * multiplier), not unlimited
    const clientIp = req.ip ?? "unknown";
    if (!checkRegistrationRateLimit(clientIp, isMcpAgentReg || isPowVerified)) {
      res.status(429).json({ error: "Too many registrations from this IP. Please try again later." });
      return;
    }

    // Global registration cap (Alpha: 250 slots)
    if (!(await checkGlobalRegistrationCap())) {
      log.warn("registration rejected: global cap reached", { ip: clientIp, cap: MAX_REGISTERED_USERS });
      res.status(403).json({ error: `Registration is currently closed. All ${MAX_REGISTERED_USERS} alpha slots are filled.` });
      return;
    }

    const pwError = validatePassword(password, email);
    if (pwError) {
      res.status(400).json({ error: pwError });
      return;
    }

    const passwordHash = await hashPassword(password);

    let user;
    try {
      user = await userRepo.createUser(email, passwordHash);
    } catch (err) {
      // Unique constraint violation → don't reveal whether email exists
      if (err instanceof Error && (err.message.includes("duplicate") || err.message.includes("unique"))) {
        res.status(409).json({ error: "Registration failed. Please try a different email." });
        return;
      }
      throw err;
    }

    // Verify the newly created user has active status before issuing tokens
    if (user.status !== "active") {
      log.warn("registration created non-active user", { userId: user.id, status: user.status });
      res.status(403).json({ error: "Account is not active. Please contact support." });
      return;
    }

    await walletRepo.createWallet(user.id);

    // Referral code processing (non-blocking: referral failure must NOT prevent registration)
    const referralCode = typeof req.body?.referralCode === "string" ? req.body.referralCode.trim().toUpperCase() : "";
    if (referralCode && /^[A-Za-z0-9]{4,20}$/.test(referralCode)) {
      const refHash = crypto.createHash("sha256").update(referralCode).digest("hex");
      referralRepo.redeemReferralCode(refHash, user.id).catch((err) => {
        log.warn("referral code redemption failed (non-blocking)", {
          userId: user.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    const tokens = createTokenPair({ userId: user.id, email: user.email, isAdmin: user.is_admin, adminRole: user.admin_role ?? "none" });

    // Store refresh token in DB for rotation tracking
    const familyId = refreshTokenRepo.newFamilyId();
    const tokenHash = refreshTokenRepo.hashToken(tokens.refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    await refreshTokenRepo.storeToken(user.id, tokenHash, familyId, expiresAt);

    log.info("user registered", { userId: user.id });

    // Mark waitlist entry as registered (non-blocking, best-effort)
    waitlistRepo.markRegistered(email).catch((err) => {
      log.error("failed to mark waitlist registered", { error: err instanceof Error ? err.message : String(err) });
    });

    // AI agent auto-verification: auto-verify email for MCP agents and PoW-verified
    // registrations so AI agents can immediately use payment features.
    // This is agent-only — general SDK/API users must verify via email link.
    // Mass signups are still blocked by reCAPTCHA + rate limits + alpha cap.
    const isMcpAgent = isMcpAgentReg || isPowVerified;
    if (isMcpAgent) {
      await userRepo.markEmailVerified(user.id);
      log.info("auto-verified email for MCP agent", { userId: user.id });
    } else {
      // Send email verification for non-MCP clients
      const verificationToken = generateSecureToken();
      const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
      userRepo.createEmailVerificationToken(user.id, verificationToken.hash, verifyExpiresAt)
        .then(() => sendVerificationEmail(email, verificationToken.raw))
        .catch((err) => {
          log.error("failed to send verification email", { userId: user.id, error: err instanceof Error ? err.message : String(err) });
        });
    }

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

    const userPayload = {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      is_admin: user.is_admin ?? false,
      admin_role: user.admin_role ?? "none",
    };

    // Browser clients get tokens via httpOnly cookies only (XSS-safe).
    // Extension/API clients need tokens in the response body.
    if (isBrowserClient(req)) {
      res.status(201).json({ user: userPayload });
    } else {
      res.status(201).json({
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: userPayload,
      });
    }
  } catch (err) {
    log.error("registration failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const email = sanitizeString(req.body.email ?? "", 254).toLowerCase();
    const password = req.body.password ?? "";
    const clientIp = (req.ip ?? req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");

    // Cap password length to prevent bcrypt DoS (O(n) cost on input length)
    if (password.length > 128) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    // MCP agent detection: skip reCAPTCHA for authenticated MCP agents
    const isMcpAgentLogin = isVerifiedAgent(req);

    // reCAPTCHA v3 verification (anti-bot on login)
    const captchaToken = req.body.captchaToken ?? "";
    if (RECAPTCHA_SECRET_KEY && !captchaToken && !isMcpAgentLogin) {
      res.status(400).json({ error: "CAPTCHA verification required" });
      return;
    }
    if (RECAPTCHA_SECRET_KEY && !isMcpAgentLogin) {
      const captchaValid = await verifyRecaptcha(captchaToken, clientIp, "login");
      if (!captchaValid) {
        res.status(400).json({ error: "CAPTCHA verification failed. Please try again." });
        return;
      }
    }

    // Per-IP global login limit (prevents credential stuffing across emails)
    // Verified MCP agents skip — authenticated by shared secret
    if (!isMcpAgentLogin) {
      const ipLimitMsg = checkIpLoginLimit(clientIp);
      if (ipLimitMsg) {
        res.status(429).json({ error: ipLimitMsg });
        return;
      }
    }

    // Check account lockout (keyed on IP+email to prevent DoS)
    // Verified MCP agents skip — authenticated by shared secret
    if (!isMcpAgentLogin) {
      const lockoutMsg = checkLoginLockout(clientIp, email);
      if (lockoutMsg) {
        res.status(429).json({ error: lockoutMsg });
        return;
      }
    }

    const user = await userRepo.findUserForAuth(email);
    if (!user) {
      if (!isMcpAgentLogin) { recordLoginFailure(clientIp, email); recordIpLoginAttempt(clientIp); }
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    // Check password BEFORE revealing account status (prevents enumeration)
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      if (!isMcpAgentLogin) { recordLoginFailure(clientIp, email); recordIpLoginAttempt(clientIp); }
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (user.status !== "active") {
      res.status(403).json({ error: "Account is suspended or disabled" });
      return;
    }

    // Successful login — clear lockout for this IP+email combo only
    resetLoginAttempts(clientIp, email);
    // Do NOT clear IP-global counter on single success — attacker on shared IP
    // could use one valid login to reset the counter, then resume credential stuffing.
    // The IP-global counter expires naturally after its time window.

    // Check if MFA is enabled for this user
    const mfaConfig = await mfaRepo.findMfaConfigByUserId(user.id);
    if (mfaConfig?.enabled) {
      // MFA required: issue a short-lived challenge token instead of real tokens
      const challengeToken = signMfaChallengeToken({ userId: user.id, email: user.email });
      log.info("MFA challenge issued", { userId: user.id });

      if (isBrowserClient(req)) {
        // Set challenge token as cookie for browser clients
        res.cookie("dominusnode_mfa_challenge", challengeToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 5 * 60 * 1000, // 5 minutes
          path: "/api/auth/mfa", // restrict to MFA verification path
        });
        res.json({ mfaRequired: true });
      } else {
        // Extension/API clients get the challenge token in body
        res.json({ mfaRequired: true, mfaChallengeToken: challengeToken });
      }
      return;
    }

    const tokens = createTokenPair({ userId: user.id, email: user.email, isAdmin: user.is_admin, adminRole: user.admin_role ?? "none" });

    // Store refresh token in DB for rotation tracking
    const familyId = refreshTokenRepo.newFamilyId();
    const tokenHash = refreshTokenRepo.hashToken(tokens.refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await refreshTokenRepo.storeToken(user.id, tokenHash, familyId, expiresAt);

    log.info("user logged in", { userId: user.id });

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

    const userPayload = {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      is_admin: user.is_admin ?? false,
      admin_role: user.admin_role ?? "none",
    };

    if (isBrowserClient(req)) {
      res.json({ user: userPayload });
    } else {
      // Extension/API clients need tokens + user info in body
      res.json({
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        userId: user.id,
        email: user.email,
        user: userPayload,
      });
    }
  } catch (err) {
    log.error("login failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Login failed" });
  }
});

// POST /api/auth/refresh — exchange refresh token for new token pair (rotation)
router.post("/refresh", async (req, res) => {
  try {
    // Read refresh token from cookie first, then body (extension compatibility)
    const fromCookie = !!req.cookies?.[getRefreshCookieName()];
    const refreshToken = fromCookie ? req.cookies[getRefreshCookieName()] : (req.body.refreshToken ?? "");
    if (!refreshToken) {
      res.status(400).json({ error: "Refresh token required" });
      return;
    }

    const payload = verifyRefreshToken(refreshToken);
    if (!payload) {
      res.status(401).json({ error: "Invalid or expired refresh token" });
      return;
    }

    // Check the token against the DB
    const incomingHash = refreshTokenRepo.hashToken(refreshToken);
    const storedToken = await refreshTokenRepo.findTokenByHash(incomingHash);

    if (!storedToken) {
      // Token not in DB at all — reject
      res.status(401).json({ error: "Invalid refresh token" });
      return;
    }

    // Verify token has not expired in DB (defense-in-depth beyond JWT expiry)
    if (storedToken.expires_at && new Date(storedToken.expires_at) < new Date()) {
      res.status(401).json({ error: "Refresh token expired" });
      return;
    }

    if (storedToken.revoked) {
      // REUSE DETECTED: This token was already rotated, meaning it was stolen.
      // Revoke the entire family to protect the user.
      const revoked = await refreshTokenRepo.revokeFamily(storedToken.family_id);
      // Also revoke all API keys — otherwise proxy tunnels survive token revocation
      const keysRevoked = await userRepo.revokeAllApiKeys(storedToken.user_id);
      log.warn("refresh token reuse detected — revoking family + API keys", {
        userId: storedToken.user_id,
        familyId: storedToken.family_id,
        revokedTokens: revoked,
        revokedKeys: keysRevoked,
      });
      res.status(401).json({ error: "Token reuse detected. All sessions revoked for security." });
      return;
    }

    // Verify user still exists and is active
    const user = await userRepo.findUserById(payload.userId);
    if (!user || user.status !== "active") {
      res.status(401).json({ error: "Account is no longer active" });
      return;
    }

    // Check if password was changed after refresh token was issued
    if (payload.iat && user.password_changed_at) {
      const tokenIssuedAt = payload.iat * 1000;
      if (new Date(user.password_changed_at).getTime() > tokenIssuedAt) {
        await refreshTokenRepo.revokeToken(incomingHash);
        res.status(401).json({ error: "Token invalidated by password change" });
        return;
      }
    }

    // Revoke the old token
    await refreshTokenRepo.revokeToken(incomingHash);

    // Issue new token pair (rotation) — same family
    const tokens = createTokenPair({ userId: user.id, email: user.email, isAdmin: user.is_admin, adminRole: user.admin_role ?? "none" });
    const newHash = refreshTokenRepo.hashToken(tokens.refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await refreshTokenRepo.storeToken(user.id, newHash, storedToken.family_id, expiresAt);

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

    // Browser (cookie) clients: tokens only in httpOnly cookies
    // Extension/API (body) clients: tokens in response body
    if (fromCookie) {
      res.json({ message: "Token refreshed" });
    } else {
      res.json({ token: tokens.accessToken, refreshToken: tokens.refreshToken });
    }
  } catch (err) {
    log.error("token refresh failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Token refresh failed" });
  }
});

// POST /api/auth/change-password — change user's password (requires current password)
router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { userId, email } = (req as AuthenticatedRequest).user;
    const clientIp = (req.ip ?? req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");

    // Rate limit password change attempts to prevent brute force on current password
    const isAgentChangePw = isVerifiedAgent(req);
    const lockoutMsg = isAgentChangePw ? null : checkLoginLockout(clientIp, email);
    if (lockoutMsg) {
      res.status(429).json({ error: lockoutMsg });
      return;
    }

    // Wallet-only accounts cannot set/change passwords
    if (isWalletEmail(email)) {
      res.status(400).json({ error: "Wallet accounts cannot set passwords" });
      return;
    }

    const currentPassword = req.body.currentPassword ?? "";
    const newPassword = req.body.newPassword ?? "";

    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: "Current password and new password are required" });
      return;
    }

    // Cap password length to prevent bcrypt DoS
    if (currentPassword.length > 128 || newPassword.length > 128) {
      res.status(400).json({ error: "Password exceeds maximum length" });
      return;
    }

    // Reject same password
    if (currentPassword === newPassword) {
      res.status(400).json({ error: "New password must be different from current password" });
      return;
    }

    const pwError = validatePassword(newPassword, email);
    if (pwError) {
      res.status(400).json({ error: pwError });
      return;
    }

    // Verify current password
    const user = await userRepo.findUserForAuth(email);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) {
      if (!isAgentChangePw) recordLoginFailure(clientIp, email); // Track failed password attempts
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    // Successful password verification — clear lockout for this IP+email
    resetLoginAttempts(clientIp, email);

    // Hash and save new password (also sets password_changed_at)
    const newHash = await hashPassword(newPassword);
    await userRepo.updatePassword(userId, newHash);

    // Revoke all existing refresh tokens for this user
    await refreshTokenRepo.revokeAllForUser(userId);

    // Revoke all API keys on password change — if account was compromised,
    // attacker's API keys must also be invalidated
    await userRepo.revokeAllApiKeys(userId);

    // Issue new token pair with fresh family
    const tokens = createTokenPair({ userId, email, isAdmin: user.is_admin, adminRole: user.admin_role ?? "none" });
    const familyId = refreshTokenRepo.newFamilyId();
    const tokenHash = refreshTokenRepo.hashToken(tokens.refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await refreshTokenRepo.storeToken(userId, tokenHash, familyId, expiresAt);

    log.info("password changed", { userId });

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

    res.json({ message: "Password changed successfully" });
  } catch (err) {
    log.error("password change failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Password change failed" });
  }
});

// POST /api/auth/logout — revoke all refresh tokens for the user (server-side session invalidation)
router.post("/logout", requireAuth, async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;
    const revoked = await refreshTokenRepo.revokeAllForUser(userId);
    clearAuthCookies(res);
    log.info("user logged out — all refresh tokens revoked", { userId, revokedCount: revoked });
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    log.error("logout failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Logout failed" });
  }
});

// GET /api/auth/me — session restoration via cookie (for frontend page reload)
router.get("/me", requireAuth, async (req, res) => {
  try {
    const { userId, email, isAdmin } = (req as AuthenticatedRequest).user;
    // Fetch full user record to include wallet_address and preferences
    const fullUser = await userRepo.findUserById(userId);
    res.json({
      user: {
        id: userId,
        email,
        is_admin: isAdmin,
        admin_role: fullUser?.admin_role ?? "none",
        wallet_address: fullUser?.wallet_address ?? null,
        log_target_hosts: fullUser?.log_target_hosts ?? false,
        email_verified: fullUser?.email_verified ?? false,
      },
    });
  } catch (err) {
    log.error("me endpoint failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to retrieve user info" });
  }
});

// POST /api/auth/verify-key — Verify API key and return JWT tokens (for browser extension)
router.post("/verify-key", async (req, res) => {
  try {
    // Rate limit verify-key per IP to prevent brute force / timing oracle
    const clientIp = (req.ip ?? req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const isAgentVerifyKey = isVerifiedAgent(req);
    if (!isAgentVerifyKey && !checkVerifyKeyRateLimit(clientIp)) {
      res.status(429).json({ valid: false, error: "Too many verification attempts. Try again later." });
      return;
    }

    const apiKey = sanitizeString(req.body.apiKey ?? "", 200);

    if (!apiKey.startsWith("dn_live_")) {
      res.status(401).json({ valid: false, error: "Invalid API key" }); // unified error message
      return;
    }

    const keyHash = hashApiKey(apiKey);
    const result = await userRepo.findUserByApiKeyHash(keyHash);

    if (!result) {
      res.status(401).json({ valid: false, error: "Invalid API key" });
      return;
    }

    if (result.user.status !== "active") {
      res.status(403).json({ valid: false, error: "Account suspended" });
      return;
    }

    // Block verify-key when MFA is enabled — API key alone must not bypass MFA
    const mfaConfig = await mfaRepo.findMfaConfigByUserId(result.user.id);
    if (mfaConfig?.enabled) {
      res.status(403).json({
        valid: false,
        error: "MFA is enabled. Use password login with MFA verification instead.",
        mfaRequired: true,
      });
      return;
    }

    const tokens = createTokenPair({
      userId: result.user.id,
      email: result.user.email,
      isAdmin: result.user.is_admin,
      adminRole: result.user.admin_role ?? "none",
    });

    // Store refresh token for rotation tracking
    const familyId = refreshTokenRepo.newFamilyId();
    const rtHash = refreshTokenRepo.hashToken(tokens.refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await refreshTokenRepo.storeToken(result.user.id, rtHash, familyId, expiresAt);

    // Extension-only endpoint: return tokens + user info for chrome.storage.session
    res.json({
      valid: true,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      userId: result.user.id,
      email: result.user.email,
    });
  } catch (err) {
    log.error("API key verification failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ valid: false, error: "Verification failed" });
  }
});

// ─── MFA Endpoints ──────────────────────────────────────────────────

const MFA_CHALLENGE_COOKIE = "dominusnode_mfa_challenge";

// MFA brute-force protection: max 5 failed attempts per userId per 5-minute window
const MAX_MFA_ATTEMPTS = 5;
const MFA_LOCKOUT_MS = 5 * 60 * 1000;
const MAX_MFA_MAP_SIZE = 10_000;
const mfaAttempts = new Map<string, { count: number; lockedUntil: number }>();

// TOTP replay prevention: track lastUsedCounter per user (RFC 6238 §5.2)
// Each TOTP code maps to a time counter — reject codes with counter <= last accepted
const MAX_TOTP_COUNTER_MAP_SIZE = 50_000;
const totpLastUsedCounters = new Map<string, bigint>();

// MFA challenge token single-use enforcement:
// Track consumed challenge JTIs to prevent replay within the 5-min validity window
const MAX_CONSUMED_CHALLENGES_SIZE = 50_000;
const consumedChallengeJtis = new Map<string, number>(); // jti -> expiresAt timestamp

// Periodic cleanup of expired consumed challenge JTIs (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [jti, expiresAt] of consumedChallengeJtis) {
    if (expiresAt <= now) {
      consumedChallengeJtis.delete(jti);
    }
  }
}, 300_000).unref();

function checkMfaLockout(userId: string): string | null {
  const entry = mfaAttempts.get(userId);
  if (!entry) return null;
  if (entry.lockedUntil > Date.now()) {
    const remainSec = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    return `Too many MFA attempts. Try again in ${remainSec} seconds.`;
  }
  if (entry.lockedUntil <= Date.now() && entry.count >= MAX_MFA_ATTEMPTS) {
    mfaAttempts.delete(userId);
  }
  return null;
}

function recordMfaFailure(userId: string): void {
  // Evict oldest entry if map is too large
  if (mfaAttempts.size >= MAX_MFA_MAP_SIZE) {
    const firstKey = mfaAttempts.keys().next().value;
    if (firstKey) mfaAttempts.delete(firstKey);
  }
  const entry = mfaAttempts.get(userId) ?? { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_MFA_ATTEMPTS) {
    entry.lockedUntil = Date.now() + MFA_LOCKOUT_MS;
    log.warn("MFA locked due to failed attempts", { userId, count: entry.count });
  }
  mfaAttempts.set(userId, entry);
}

function resetMfaAttempts(userId: string): void {
  mfaAttempts.delete(userId);
}

// Periodic cleanup of expired MFA lockout entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of mfaAttempts) {
    if (entry.lockedUntil > 0 && entry.lockedUntil <= now) {
      mfaAttempts.delete(userId);
    }
  }
}, 300_000).unref();

// POST /api/auth/mfa/verify — Complete MFA challenge with TOTP code or backup code
router.post("/mfa/verify", async (req, res) => {
  try {
    // Per-IP rate limiting for MFA verification (prevents distributed brute force)
    const clientIp = (req.ip ?? req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const isAgentMfa = isVerifiedAgent(req);
    const ipLimitMsg = isAgentMfa ? null : checkIpLoginLimit(clientIp);
    if (ipLimitMsg) {
      res.status(429).json({ error: ipLimitMsg });
      return;
    }

    // Read challenge token from cookie (browser) or body (extension)
    const challengeToken =
      req.cookies?.[MFA_CHALLENGE_COOKIE] ?? req.body.mfaChallengeToken ?? "";
    if (!challengeToken) {
      res.status(400).json({ error: "MFA challenge token required" });
      return;
    }

    const challenge = verifyMfaChallengeToken(challengeToken);
    if (!challenge) {
      res.status(401).json({ error: "Invalid or expired MFA challenge" });
      return;
    }

    // Single-use enforcement: reject replayed challenge tokens
    const jti = challenge.jti;
    if (!jti) {
      log.warn("MFA challenge token missing jti claim", { userId: challenge.userId });
      res.status(401).json({ error: "Invalid MFA challenge token" });
      return;
    }
    if (consumedChallengeJtis.has(jti)) {
      log.warn("MFA challenge token reuse attempted", { userId: challenge.userId });
      res.status(401).json({ error: "MFA challenge token has already been used" });
      return;
    }

    // Check MFA brute-force lockout
    const mfaLockoutMsg = checkMfaLockout(challenge.userId);
    if (mfaLockoutMsg) {
      res.status(429).json({ error: mfaLockoutMsg });
      return;
    }

    // Consume challenge JTI BEFORE code verification to prevent brute force
    // via challenge token reuse — token is single-use regardless of verification outcome
    if (consumedChallengeJtis.size >= MAX_CONSUMED_CHALLENGES_SIZE) {
      const firstKey = consumedChallengeJtis.keys().next().value;
      if (firstKey) consumedChallengeJtis.delete(firstKey);
    }
    consumedChallengeJtis.set(jti, Date.now() + 5 * 60 * 1000);

    const code = sanitizeString(req.body.code ?? "", 20);
    const isBackupCode = req.body.isBackupCode === true;

    if (!code) {
      res.status(400).json({ error: "Verification code required" });
      return;
    }

    const mfaConfig = await mfaRepo.findMfaConfigByUserId(challenge.userId);
    if (!mfaConfig?.enabled) {
      res.status(400).json({ error: "MFA is not enabled" });
      return;
    }

    let verified = false;

    if (isBackupCode) {
      // Atomically find and consume backup code (prevents race conditions)
      const codeHash = hashBackupCode(code);
      const consumed = await mfaRepo.consumeBackupCodeAtomic(challenge.userId, codeHash);
      if (consumed) {
        verified = true;
        log.info("MFA verified with backup code", { userId: challenge.userId });
      }
    } else {
      // Verify TOTP code with replay prevention (RFC 6238 §5.2)
      const secret = decryptTotpSecret(mfaConfig.totp_secret_enc, mfaConfig.totp_secret_iv);
      const lastCounter = totpLastUsedCounters.get(challenge.userId);
      const counter = verifyTotpCode(secret, code, undefined, lastCounter);
      if (counter !== null) {
        verified = true;
        // Evict oldest entry if map is too large
        if (totpLastUsedCounters.size >= MAX_TOTP_COUNTER_MAP_SIZE && !totpLastUsedCounters.has(challenge.userId)) {
          const firstKey = totpLastUsedCounters.keys().next().value;
          if (firstKey) totpLastUsedCounters.delete(firstKey);
        }
        totpLastUsedCounters.set(challenge.userId, counter);
      }
    }

    if (!verified) {
      recordMfaFailure(challenge.userId);
      recordIpLoginAttempt(clientIp); // Count MFA failures against IP budget
      res.status(401).json({ error: "Invalid verification code" });
      return;
    }

    // MFA verified — clear lockout counter
    resetMfaAttempts(challenge.userId);

    // MFA verified — issue real tokens
    const user = await userRepo.findUserById(challenge.userId);
    if (!user || user.status !== "active") {
      res.status(401).json({ error: "Account is no longer active" });
      return;
    }

    const tokens = createTokenPair({ userId: user.id, email: user.email, isAdmin: user.is_admin, adminRole: user.admin_role ?? "none" });
    const familyId = refreshTokenRepo.newFamilyId();
    const rtHash = refreshTokenRepo.hashToken(tokens.refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await refreshTokenRepo.storeToken(user.id, rtHash, familyId, expiresAt);

    // Clear challenge cookie
    res.clearCookie(MFA_CHALLENGE_COOKIE, { httpOnly: true, sameSite: "strict", path: "/api/auth/mfa" });
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

    log.info("MFA verified — tokens issued", { userId: user.id });

    const userPayload = {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      is_admin: user.is_admin ?? false,
      admin_role: user.admin_role ?? "none",
    };

    if (isBrowserClient(req)) {
      res.json({ user: userPayload });
    } else {
      res.json({
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        userId: user.id,
        email: user.email,
        user: userPayload,
      });
    }
  } catch (err) {
    log.error("MFA verify failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "MFA verification failed" });
  }
});

// POST /api/auth/mfa/setup — Generate TOTP secret + QR URI + backup codes (shown once)
router.post("/mfa/setup", requireAuth, async (req, res) => {
  try {
    const { userId, email } = (req as AuthenticatedRequest).user;

    // Check if MFA is already enabled
    const existing = await mfaRepo.findMfaConfigByUserId(userId);
    if (existing?.enabled) {
      res.status(409).json({ error: "MFA is already enabled. Disable it first to reconfigure." });
      return;
    }

    // Generate TOTP secret
    const { raw, base32 } = generateTotpSecret();
    const { encrypted, iv } = encryptTotpSecret(raw);

    // Store encrypted secret (upserts if setup was started but not completed)
    await mfaRepo.createMfaConfig(userId, encrypted, iv);

    // Generate backup codes
    const { plaintextCodes, hashes } = generateBackupCodes();
    await mfaRepo.storeBackupCodes(userId, hashes);

    // Build OTPAuth URI for QR code generation
    const otpauthUri = buildTotpUri(base32, email);

    log.info("MFA setup initiated", { userId });

    res.json({
      secret: base32,
      otpauthUri,
      backupCodes: plaintextCodes,
    });
  } catch (err) {
    log.error("MFA setup failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "MFA setup failed" });
  }
});

// POST /api/auth/mfa/enable — Verify initial TOTP code to activate MFA
router.post("/mfa/enable", requireAuth, async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;
    const code = sanitizeString(req.body.code ?? "", 6);

    if (!code || !/^\d{6}$/.test(code)) {
      res.status(400).json({ error: "A 6-digit TOTP code is required" });
      return;
    }

    const mfaConfig = await mfaRepo.findMfaConfigByUserId(userId);
    if (!mfaConfig) {
      res.status(400).json({ error: "MFA setup not started. Call /mfa/setup first." });
      return;
    }

    if (mfaConfig.enabled) {
      res.status(409).json({ error: "MFA is already enabled" });
      return;
    }

    // Verify the code against the stored secret with replay prevention (RFC 6238 §5.2)
    const secret = decryptTotpSecret(mfaConfig.totp_secret_enc, mfaConfig.totp_secret_iv);
    const lastCounter = totpLastUsedCounters.get(userId);
    const enableCounter = verifyTotpCode(secret, code, undefined, lastCounter);

    if (enableCounter === null) {
      res.status(401).json({ error: "Invalid TOTP code. Ensure your authenticator app is synced." });
      return;
    }

    // Track used counter to prevent replay
    if (totpLastUsedCounters.size >= MAX_TOTP_COUNTER_MAP_SIZE && !totpLastUsedCounters.has(userId)) {
      const firstKey = totpLastUsedCounters.keys().next().value;
      if (firstKey) totpLastUsedCounters.delete(firstKey);
    }
    totpLastUsedCounters.set(userId, enableCounter);

    await mfaRepo.enableMfa(userId);
    log.info("MFA enabled", { userId });

    res.json({ enabled: true });
  } catch (err) {
    log.error("MFA enable failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "MFA enable failed" });
  }
});

// POST /api/auth/mfa/disable — Disable MFA (requires password + TOTP code)
router.post("/mfa/disable", requireAuth, async (req, res) => {
  try {
    const { userId, email } = (req as AuthenticatedRequest).user;
    const password = req.body.password ?? "";
    const code = sanitizeString(req.body.code ?? "", 20);

    if (!password) {
      res.status(400).json({ error: "Password is required to disable MFA" });
      return;
    }
    // Cap password length to prevent bcrypt DoS
    if (password.length > 128) {
      res.status(400).json({ error: "Invalid password" });
      return;
    }
    if (!code) {
      res.status(400).json({ error: "TOTP code or backup code is required" });
      return;
    }

    // Brute-force protection for MFA disable
    const mfaDisableLockout = checkMfaLockout(userId);
    if (mfaDisableLockout) {
      res.status(429).json({ error: mfaDisableLockout });
      return;
    }

    // Verify password
    const user = await userRepo.findUserForAuth(email);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    const passwordValid = await verifyPassword(password, user.password_hash);
    if (!passwordValid) {
      recordMfaFailure(userId); // count password failures too
      res.status(401).json({ error: "Invalid password" });
      return;
    }

    const mfaConfig = await mfaRepo.findMfaConfigByUserId(userId);
    if (!mfaConfig?.enabled) {
      res.status(400).json({ error: "MFA is not enabled" });
      return;
    }

    // Verify TOTP or backup code with replay prevention (RFC 6238 §5.2)
    const secret = decryptTotpSecret(mfaConfig.totp_secret_enc, mfaConfig.totp_secret_iv);
    const disableLastCounter = totpLastUsedCounters.get(userId);
    const disableCounter = verifyTotpCode(secret, code, undefined, disableLastCounter);
    let verified = disableCounter !== null;
    if (disableCounter !== null) {
      totpLastUsedCounters.set(userId, disableCounter);
    }

    if (!verified) {
      // Try as backup code (atomic find+consume to prevent race conditions)
      const codeHash = hashBackupCode(code);
      const consumed = await mfaRepo.consumeBackupCodeAtomic(userId, codeHash);
      if (consumed) {
        verified = true;
      }
    }

    if (!verified) {
      recordMfaFailure(userId); // track failures for brute-force protection
      res.status(401).json({ error: "Invalid verification code" });
      return;
    }

    // MFA disable verified — clear lockout counter
    resetMfaAttempts(userId);

    // Delete MFA config and backup codes
    await mfaRepo.deleteMfaConfig(userId);

    // Revoke all refresh tokens for safety
    await refreshTokenRepo.revokeAllForUser(userId);

    // MFA disable must also revoke API keys (parity with password change)
    await userRepo.revokeAllApiKeys(userId);

    log.info("MFA disabled", { userId });

    res.json({ enabled: false });
  } catch (err) {
    log.error("MFA disable failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "MFA disable failed" });
  }
});

// GET /api/auth/mfa/status — Check MFA status
router.get("/mfa/status", requireAuth, async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;
    const mfaConfig = await mfaRepo.findMfaConfigByUserId(userId);
    const enabled = mfaConfig?.enabled ?? false;
    const backupCodesRemaining = enabled ? await mfaRepo.countUnusedBackupCodes(userId) : 0;

    res.json({ enabled, backupCodesRemaining });
  } catch (err) {
    log.error("MFA status check failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to check MFA status" });
  }
});

// ─── Token Helpers ───────────────────────────────────────────────────

function generateSecureToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

// ─── Per-IP forgot-password rate limiter ─────────────────────────────
const MAX_FORGOT_PER_IP = 5; // 5 requests per IP per 15 min
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const forgotPasswordAttempts = new Map<string, { count: number; windowStart: number }>();

function checkForgotPasswordRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = forgotPasswordAttempts.get(ip);
  if (!entry || now - entry.windowStart > FORGOT_WINDOW_MS) {
    if (forgotPasswordAttempts.size >= MAX_LOCKOUT_MAP_SIZE) {
      const firstKey = forgotPasswordAttempts.keys().next().value;
      if (firstKey) forgotPasswordAttempts.delete(firstKey);
    }
    forgotPasswordAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_FORGOT_PER_IP;
}

// Cleanup forgot-password rate limit entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of forgotPasswordAttempts) {
    if (now - entry.windowStart > FORGOT_WINDOW_MS) {
      forgotPasswordAttempts.delete(ip);
    }
  }
}, 300_000).unref();

// Per-IP resend-verification rate limiter
const MAX_RESEND_PER_IP = 3; // 3 requests per IP per 15 min
const resendVerificationAttempts = new Map<string, { count: number; windowStart: number }>();

function checkResendVerificationRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = resendVerificationAttempts.get(ip);
  if (!entry || now - entry.windowStart > FORGOT_WINDOW_MS) {
    if (resendVerificationAttempts.size >= MAX_LOCKOUT_MAP_SIZE) {
      const firstKey = resendVerificationAttempts.keys().next().value;
      if (firstKey) resendVerificationAttempts.delete(firstKey);
    }
    resendVerificationAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_RESEND_PER_IP;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of resendVerificationAttempts) {
    if (now - entry.windowStart > FORGOT_WINDOW_MS) {
      resendVerificationAttempts.delete(ip);
    }
  }
}, 300_000).unref();

// ─── POST /api/auth/forgot-password ─────────────────────────────────
router.post("/forgot-password", async (req, res) => {
  try {
    const email = sanitizeString(req.body.email ?? "", 254).toLowerCase();

    if (!isValidEmail(email)) {
      // Always return 200 to prevent email enumeration
      res.json({ message: "If an account with that email exists, a password reset link has been sent." });
      return;
    }

    const clientIp = req.ip ?? "unknown";
    if (!checkForgotPasswordRateLimit(clientIp)) {
      res.status(429).json({ error: "Too many password reset requests. Please try again later." });
      return;
    }

    // Block wallet-only accounts from password reset
    if (isWalletEmail(email)) {
      // Don't reveal that it's a wallet email
      res.json({ message: "If an account with that email exists, a password reset link has been sent." });
      return;
    }

    const user = await userRepo.findUserByEmail(email);
    if (!user || user.status !== "active") {
      // Don't reveal whether the email exists
      log.info("forgot-password for non-existent/inactive email", { email, ip: clientIp });
      res.json({ message: "If an account with that email exists, a password reset link has been sent." });
      return;
    }

    // Generate a secure token
    const { raw, hash } = generateSecureToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await userRepo.createPasswordResetToken(user.id, hash, expiresAt);

    // Send email (async, don't block response on delivery)
    sendPasswordResetEmail(email, raw).catch((err) => {
      log.error("failed to send password reset email", { userId: user.id, error: err instanceof Error ? err.message : String(err) });
    });

    log.info("password reset requested", { userId: user.id, ip: clientIp });
    res.json({ message: "If an account with that email exists, a password reset link has been sent." });
  } catch (err) {
    log.error("forgot-password failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Password reset request failed" });
  }
});

// ─── POST /api/auth/reset-password ──────────────────────────────────
router.post("/reset-password", async (req, res) => {
  try {
    const token = sanitizeString(req.body.token ?? "", 128);
    const newPassword = req.body.newPassword ?? "";

    if (!token || token.length < 32) {
      res.status(400).json({ error: "Invalid or expired reset token." });
      return;
    }

    // Cap password length to prevent bcrypt DoS
    if (newPassword.length > 128) {
      res.status(400).json({ error: "Password exceeds maximum length" });
      return;
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    // Atomically consume the token (DELETE...RETURNING) to prevent TOCTOU race.
    // A concurrent request with the same token will get null since the row is already deleted.
    const resetToken = await userRepo.consumePasswordResetToken(tokenHash);

    if (!resetToken) {
      res.status(400).json({ error: "Invalid or expired reset token." });
      return;
    }

    // Check expiry
    if (new Date(resetToken.expiresAt) < new Date()) {
      res.status(400).json({ error: "This reset link has expired. Please request a new one." });
      return;
    }

    // Find the user
    const user = await userRepo.findUserById(resetToken.userId);
    if (!user || user.status !== "active") {
      res.status(400).json({ error: "Invalid or expired reset token." });
      return;
    }

    // Validate new password
    const pwError = validatePassword(newPassword, user.email);
    if (pwError) {
      res.status(400).json({ error: pwError });
      return;
    }

    // Hash and update password
    const passwordHash = await hashPassword(newPassword);
    await userRepo.updatePassword(user.id, passwordHash);

    // Revoke all refresh tokens + API keys for security (force re-login)
    await refreshTokenRepo.revokeAllForUser(user.id);
    await userRepo.revokeAllApiKeys(user.id);

    log.info("password reset completed", { userId: user.id });
    res.json({ message: "Password has been reset successfully. Please log in with your new password." });
  } catch (err) {
    log.error("reset-password failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Password reset failed" });
  }
});

// ─── POST /api/auth/verify-email ────────────────────────────────────
router.post("/verify-email", async (req, res) => {
  try {
    const token = sanitizeString(req.body.token ?? "", 128);

    if (!token || token.length < 32) {
      res.status(400).json({ error: "Invalid or expired verification token." });
      return;
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    // Atomically consume the token (DELETE...RETURNING) to prevent TOCTOU race.
    // A concurrent request with the same token will get null since the row is already deleted.
    const verifyToken = await userRepo.consumeEmailVerificationToken(tokenHash);

    if (!verifyToken) {
      res.status(400).json({ error: "Invalid or expired verification token." });
      return;
    }

    // Check expiry
    if (new Date(verifyToken.expiresAt) < new Date()) {
      // Token already deleted by consumeEmailVerificationToken — just inform user
      res.status(400).json({ error: "This verification link has expired. Please request a new one." });
      return;
    }

    // Mark email as verified
    await userRepo.markEmailVerified(verifyToken.userId);

    log.info("email verified", { userId: verifyToken.userId });
    res.json({ message: "Email verified successfully!" });
  } catch (err) {
    log.error("verify-email failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Email verification failed" });
  }
});

// ─── POST /api/auth/resend-verification ─────────────────────────────
router.post("/resend-verification", requireAuth, async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;
    const clientIp = req.ip ?? "unknown";

    if (!checkResendVerificationRateLimit(clientIp)) {
      res.status(429).json({ error: "Too many verification requests. Please try again later." });
      return;
    }

    const user = await userRepo.findUserById(userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (user.email_verified) {
      res.json({ message: "Email is already verified." });
      return;
    }

    // Wallet users don't need email verification
    if (isWalletEmail(user.email)) {
      res.json({ message: "Wallet accounts do not require email verification." });
      return;
    }

    // Cooldown: if a token was created in the last 60 seconds, don't replace it.
    // Replacing too quickly invalidates the link in the email the user already received.
    const recentExists = await userRepo.findRecentEmailVerificationToken(userId, 60);
    if (recentExists) {
      res.json({ message: "Verification email was sent recently. Please check your inbox (and spam folder)." });
      return;
    }

    // Generate verification token
    const { raw, hash } = generateSecureToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await userRepo.createEmailVerificationToken(userId, hash, expiresAt);

    sendVerificationEmail(user.email, raw).catch((err) => {
      log.error("failed to send verification email", { userId, error: err instanceof Error ? err.message : String(err) });
    });

    log.info("verification email resent", { userId, ip: clientIp });
    res.json({ message: "Verification email sent. Please check your inbox." });
  } catch (err) {
    log.error("resend-verification failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to resend verification email" });
  }
});

export default router;
