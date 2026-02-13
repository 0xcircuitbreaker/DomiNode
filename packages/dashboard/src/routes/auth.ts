import { Router, type Request as ExpressRequest } from "express";
import {
  userRepo,
  walletRepo,
  refreshTokenRepo,
  mfaRepo,
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
} from "@dominode/shared";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { setAuthCookies, clearAuthCookies, getRefreshCookieName } from "../helpers/cookies.js";

const router = Router();
const log = createLogger("api:auth");

// Determine if the request is from the browser frontend (uses cookies, no tokens needed in body)
const ALLOWED_ORIGINS = (process.env["CORS_ORIGINS"] ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim());

function isBrowserClient(req: ExpressRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  const forwardedHostHeader = req.headers["x-forwarded-host"];
  const requestHostRaw = typeof forwardedHostHeader === "string" && forwardedHostHeader.trim()
    ? forwardedHostHeader.split(",")[0]?.trim()
    : req.headers["host"];
  if (!requestHostRaw) return false;

  try {
    const originUrl = new URL(origin);
    const normalizedRequestHost = requestHostRaw.includes("://")
      ? requestHostRaw
      : `http://${requestHostRaw}`;
    const requestUrl = new URL(normalizedRequestHost);

    if (originUrl.host.toLowerCase() === requestUrl.host.toLowerCase()) return true;
    if (originUrl.hostname.toLowerCase() !== requestUrl.hostname.toLowerCase()) return false;

    // Reverse proxies may strip port from Host; treat same hostname as browser origin.
    if (!requestUrl.port || !originUrl.port) return true;
    return originUrl.port === requestUrl.port;
  } catch {
    return false;
  }
}

// ─── Account lockout after failed logins ──────────────────────────
// Keyed on IP+email to prevent DoS (attacker can't lock arbitrary accounts)
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LOCKOUT_MAP_SIZE = 50_000; // Cap memory usage
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

// R17: Per-IP global login limit across ALL emails — prevents credential stuffing
const MAX_LOGIN_ATTEMPTS_PER_IP = 20; // 20 total login attempts per IP per 15 min
const ipLoginAttempts = new Map<string, { count: number; windowStart: number }>();

function checkIpLoginLimit(ip: string): string | null {
  const now = Date.now();
  const entry = ipLoginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOCKOUT_DURATION_MS) {
    return null; // window expired or new IP
  }
  if (entry.count >= MAX_LOGIN_ATTEMPTS_PER_IP) {
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

// R17: Per-IP verify-key rate limiting — prevents API key brute force / oracle
const MAX_VERIFY_KEY_PER_IP = 10; // 10 attempts per IP per 5-min window
const VERIFY_KEY_WINDOW_MS = 5 * 60 * 1000;
const verifyKeyAttempts = new Map<string, { count: number; windowStart: number }>();

function checkVerifyKeyRateLimit(ip: string): boolean {
  const now = Date.now();
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
  return entry.count <= MAX_VERIFY_KEY_PER_IP;
}

function lockoutKey(ip: string, email: string): string {
  return `${ip}:${email}`;
}

function checkLoginLockout(ip: string, email: string): string | null {
  const key = lockoutKey(ip, email);
  const entry = loginAttempts.get(key);
  if (!entry) return null;
  if (entry.lockedUntil > Date.now()) {
    const remainSec = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    return `Account temporarily locked. Try again in ${remainSec} seconds.`;
  }
  if (entry.lockedUntil <= Date.now() && entry.count >= MAX_LOGIN_ATTEMPTS) {
    loginAttempts.delete(key);
  }
  return null;
}

function recordLoginFailure(ip: string, email: string): void {
  const key = lockoutKey(ip, email);
  // Evict oldest entries if map is too large
  if (loginAttempts.size >= MAX_LOCKOUT_MAP_SIZE) {
    const firstKey = loginAttempts.keys().next().value;
    if (firstKey) loginAttempts.delete(firstKey);
  }
  const entry = loginAttempts.get(key) ?? { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
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

// ─── Per-IP registration rate limiter (prevents mass signup abuse) ───
const MAX_REGISTRATIONS_PER_IP = 3; // 3 accounts per IP per hour
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_REG_RATE_MAP_SIZE = 50_000;
const registrationLog = new Map<string, number[]>(); // IP -> timestamps

function checkRegistrationRateLimit(ip: string): boolean {
  const now = Date.now();
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
  if (timestamps.length >= MAX_REGISTRATIONS_PER_IP) {
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

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const email = sanitizeString(req.body.email ?? "", 254).toLowerCase();
    const password = req.body.password ?? "";

    if (!isValidEmail(email)) {
      res.status(400).json({ error: "Invalid email address" });
      return;
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
    const clientIp = req.ip ?? "unknown";
    if (!checkRegistrationRateLimit(clientIp)) {
      res.status(429).json({ error: "Too many registrations from this IP. Please try again later." });
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

    const tokens = createTokenPair({ userId: user.id, email: user.email, isAdmin: user.is_admin });

    // Store refresh token in DB for rotation tracking
    const familyId = refreshTokenRepo.newFamilyId();
    const tokenHash = refreshTokenRepo.hashToken(tokens.refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    await refreshTokenRepo.storeToken(user.id, tokenHash, familyId, expiresAt);

    log.info("user registered", { userId: user.id });

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

    const userPayload = {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      is_admin: user.is_admin ?? false,
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

    // R17: Per-IP global login limit (prevents credential stuffing across emails)
    const ipLimitMsg = checkIpLoginLimit(clientIp);
    if (ipLimitMsg) {
      res.status(429).json({ error: ipLimitMsg });
      return;
    }

    // Check account lockout (keyed on IP+email to prevent DoS)
    const lockoutMsg = checkLoginLockout(clientIp, email);
    if (lockoutMsg) {
      res.status(429).json({ error: lockoutMsg });
      return;
    }

    const user = await userRepo.findUserByEmail(email);
    if (!user) {
      recordLoginFailure(clientIp, email);
      recordIpLoginAttempt(clientIp); // R17: Track IP-wide attempts
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    // Check password BEFORE revealing account status (prevents enumeration)
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      recordLoginFailure(clientIp, email);
      recordIpLoginAttempt(clientIp); // R17: Track IP-wide attempts
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (user.status !== "active") {
      res.status(403).json({ error: "Account is suspended or disabled" });
      return;
    }

    // Successful login — clear any lockout for this IP+email
    resetLoginAttempts(clientIp, email);

    // Check if MFA is enabled for this user
    const mfaConfig = await mfaRepo.findMfaConfigByUserId(user.id);
    if (mfaConfig?.enabled) {
      // MFA required: issue a short-lived challenge token instead of real tokens
      const challengeToken = signMfaChallengeToken({ userId: user.id, email: user.email });
      log.info("MFA challenge issued", { userId: user.id });

      if (isBrowserClient(req)) {
        // Set challenge token as cookie for browser clients
        res.cookie("dominode_mfa_challenge", challengeToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 5 * 60 * 1000, // 5 minutes
          path: "/api/auth/mfa", // R14 H-4: restrict to MFA verification path
        });
        res.json({ mfaRequired: true });
      } else {
        // Extension/API clients get the challenge token in body
        res.json({ mfaRequired: true, mfaChallengeToken: challengeToken });
      }
      return;
    }

    const tokens = createTokenPair({ userId: user.id, email: user.email, isAdmin: user.is_admin });

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

    if (storedToken.revoked) {
      // REUSE DETECTED: This token was already rotated, meaning it was stolen.
      // Revoke the entire family to protect the user.
      const revoked = await refreshTokenRepo.revokeFamily(storedToken.family_id);
      log.warn("refresh token reuse detected — revoking family", {
        userId: storedToken.user_id,
        familyId: storedToken.family_id,
        revokedCount: revoked,
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
    const tokens = createTokenPair({ userId: user.id, email: user.email, isAdmin: user.is_admin });
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

    // R18 C-4: Wallet-only accounts cannot set/change passwords
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

    // Reject same password (R12 H-4)
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
    const user = await userRepo.findUserByEmail(email);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    // Hash and save new password (also sets password_changed_at)
    const newHash = await hashPassword(newPassword);
    await userRepo.updatePassword(userId, newHash);

    // Revoke all existing refresh tokens for this user
    await refreshTokenRepo.revokeAllForUser(userId);

    // Issue new token pair with fresh family
    const tokens = createTokenPair({ userId, email, isAdmin: user.is_admin });
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
    // Fetch full user record to include wallet_address
    const fullUser = await userRepo.findUserById(userId);
    res.json({
      user: {
        id: userId,
        email,
        is_admin: isAdmin,
        wallet_address: fullUser?.wallet_address ?? null,
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
    // R17: Rate limit verify-key per IP to prevent brute force / timing oracle
    const clientIp = (req.ip ?? req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (!checkVerifyKeyRateLimit(clientIp)) {
      res.status(429).json({ valid: false, error: "Too many verification attempts. Try again later." });
      return;
    }

    const apiKey = sanitizeString(req.body.apiKey ?? "", 200);

    if (!apiKey.startsWith("dn_live_")) {
      res.status(401).json({ valid: false, error: "Invalid API key" }); // R14 H-3: unified error message
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

    const tokens = createTokenPair({
      userId: result.user.id,
      email: result.user.email,
      isAdmin: result.user.is_admin,
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

const MFA_CHALLENGE_COOKIE = "dominode_mfa_challenge";

// MFA brute-force protection: max 5 failed attempts per userId per 5-minute window
const MAX_MFA_ATTEMPTS = 5;
const MFA_LOCKOUT_MS = 5 * 60 * 1000;
const MAX_MFA_MAP_SIZE = 10_000;
const mfaAttempts = new Map<string, { count: number; lockedUntil: number }>();

// TOTP replay prevention: track lastUsedCounter per user (RFC 6238 §5.2)
// Each TOTP code maps to a time counter — reject codes with counter <= last accepted
const MAX_TOTP_COUNTER_MAP_SIZE = 50_000;
const totpLastUsedCounters = new Map<string, bigint>();

// MFA challenge token single-use enforcement (R12 C-1):
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

    // Single-use enforcement: reject replayed challenge tokens (R12 C-1, R13 C-1, R14 C-1)
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
      res.status(401).json({ error: "Invalid verification code" });
      return;
    }

    // MFA verified — clear lockout counter
    resetMfaAttempts(challenge.userId);

    // Mark challenge token as consumed (single-use enforcement)
    if (consumedChallengeJtis.size >= MAX_CONSUMED_CHALLENGES_SIZE) {
      const firstKey = consumedChallengeJtis.keys().next().value;
      if (firstKey) consumedChallengeJtis.delete(firstKey);
    }
    consumedChallengeJtis.set(jti, Date.now() + 5 * 60 * 1000);

    // MFA verified — issue real tokens
    const user = await userRepo.findUserById(challenge.userId);
    if (!user || user.status !== "active") {
      res.status(401).json({ error: "Account is no longer active" });
      return;
    }

    const tokens = createTokenPair({ userId: user.id, email: user.email, isAdmin: user.is_admin });
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
    if (!code) {
      res.status(400).json({ error: "TOTP code or backup code is required" });
      return;
    }

    // Brute-force protection for MFA disable (R12 H-3)
    const mfaDisableLockout = checkMfaLockout(userId);
    if (mfaDisableLockout) {
      res.status(429).json({ error: mfaDisableLockout });
      return;
    }

    // Verify password
    const user = await userRepo.findUserByEmail(email);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    const passwordValid = await verifyPassword(password, user.password_hash);
    if (!passwordValid) {
      recordMfaFailure(userId); // R12 H-3: count password failures too
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
      recordMfaFailure(userId); // R12 H-3: track failures for brute-force protection
      res.status(401).json({ error: "Invalid verification code" });
      return;
    }

    // MFA disable verified — clear lockout counter
    resetMfaAttempts(userId);

    // Delete MFA config and backup codes
    await mfaRepo.deleteMfaConfig(userId);

    // Revoke all refresh tokens for safety
    await refreshTokenRepo.revokeAllForUser(userId);

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

export default router;
