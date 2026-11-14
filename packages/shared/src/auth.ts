import * as crypto from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { hashApiKeyV1, hashApiKeyForStorage } from "./api-key-hash.js";

const BCRYPT_ROUNDS = 12;
const API_KEY_BYTES = 32;
const ACCESS_TOKEN_EXPIRY = "15m"; // Short-lived access tokens
const REFRESH_TOKEN_EXPIRY = "7d"; // Refresh tokens last 7 days
const MFA_CHALLENGE_EXPIRY = "5m"; // MFA challenge tokens

const KNOWN_DEFAULTS = new Set([
  "change-me-to-a-64-char-random-string-in-production",
  "secret",
  "jwt_secret",
]);

function getJwtSecret(): string {
  const secret = process.env["JWT_SECRET"];
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  if (secret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters");
  }
  if (KNOWN_DEFAULTS.has(secret)) {
    throw new Error("JWT_SECRET must not be a default/example value. Generate one with: openssl rand -hex 64");
  }
  return secret;
}

// Use a separate secret for refresh tokens (derived from main secret)
function getRefreshSecret(): string {
  const base = getJwtSecret();
  // Use HMAC for proper PRF guarantee in key derivation
  return crypto.createHmac("sha256", base).update("refresh").digest("hex");
}

// ─── API Key ─────────────────────────────────────────────────────────

export interface GeneratedApiKey {
  /** The raw key — show to user exactly once: dn_live_<hex> */
  raw: string;
  /** Stored hash: HMAC-SHA256(pepper) when API_KEY_PEPPER_FILE is set, else SHA-256 (api-key-hash.ts) */
  hash: string;
  /** First 16 chars of raw key — stored for display */
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const random = crypto.randomBytes(API_KEY_BYTES).toString("hex");
  const raw = `dn_live_${random}`;
  const hash = hashApiKeyForStorage(raw);
  const prefix = raw.slice(0, 16);
  return { raw, hash, prefix };
}

/** Legacy v1 hash (SHA-256 hex). Lookups go through userRepo.findUserByApiKey. */
export function hashApiKey(raw: string): string {
  return hashApiKeyV1(raw);
}

// ─── Password ────────────────────────────────────────────────────────

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ─── JWT ─────────────────────────────────────────────────────────────

export interface JwtPayload {
  userId: string;
  email: string;
  isAdmin?: boolean;
  adminRole?: string; // AdminRole carried in JWT
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** Sign a short-lived access token (15 minutes) */
export function signJwt(payload: JwtPayload): string {
  return jwt.sign(payload, getJwtSecret(), { algorithm: "HS256", expiresIn: ACCESS_TOKEN_EXPIRY });
}

/**
 * Sign a long-lived refresh token (7 days). A random jti makes every
 * issuance unique: without it, two logins in the same second produce the
 * same token (same payload + iat), and the stored hash collides with the
 * unique index on refresh_tokens.token_hash.
 */
export function signRefreshToken(payload: JwtPayload): string {
  return jwt.sign({ ...payload, type: "refresh" }, getRefreshSecret(), {
    algorithm: "HS256",
    expiresIn: REFRESH_TOKEN_EXPIRY,
    jwtid: crypto.randomUUID(),
  });
}

/** Create both access + refresh tokens */
export function createTokenPair(payload: JwtPayload): TokenPair {
  return {
    accessToken: signJwt(payload),
    refreshToken: signRefreshToken(payload),
  };
}

const VALID_ADMIN_ROLES = new Set(["none", "admin", "cybersecurity_admin", "root_admin"]);

/** Verify an access token — rejects MFA challenge tokens */
export function verifyJwt(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] }) as jwt.JwtPayload;
    // Reject MFA challenge tokens from being used as access tokens
    if (decoded.mfaPending === true) return null;
    if (typeof decoded.userId === "string" && typeof decoded.email === "string") {
      return {
        userId: decoded.userId,
        email: decoded.email,
        isAdmin: decoded.isAdmin === true,
        adminRole: typeof decoded.adminRole === "string" && VALID_ADMIN_ROLES.has(decoded.adminRole) ? decoded.adminRole : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── MFA Challenge Token ────────────────────────────────────────────

// Use a separate secret for MFA challenge tokens (derived from main secret)
// to prevent token confusion attacks between access tokens and challenge tokens
function getMfaChallengeSecret(): string {
  const base = getJwtSecret();
  // Use HMAC for proper PRF guarantee in key derivation
  return crypto.createHmac("sha256", base).update("mfa-challenge").digest("hex");
}

export interface MfaChallengePayload {
  userId: string;
  email: string;
  mfaPending: true;
  jti: string; // REQUIRED — JTI-less tokens enable replay attacks
}

/** Sign a short-lived MFA challenge token (5 minutes) with unique JTI for single-use enforcement */
export function signMfaChallengeToken(payload: { userId: string; email: string }): string {
  const jti = crypto.randomUUID();
  return jwt.sign({ ...payload, mfaPending: true, jti }, getMfaChallengeSecret(), {
    algorithm: "HS256",
    expiresIn: MFA_CHALLENGE_EXPIRY,
  });
}

/** Verify an MFA challenge token — only valid if mfaPending is true */
export function verifyMfaChallengeToken(token: string): MfaChallengePayload | null {
  try {
    const decoded = jwt.verify(token, getMfaChallengeSecret(), { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (
      decoded.mfaPending === true &&
      typeof decoded.userId === "string" &&
      typeof decoded.email === "string"
    ) {
      // JTI is mandatory — reject tokens without it to prevent replay attacks
      const jti = typeof decoded.jti === "string" && decoded.jti.length > 0 ? decoded.jti : null;
      if (!jti) return null;
      return { userId: decoded.userId, email: decoded.email, mfaPending: true, jti };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Proxy Session Token ─────────────────────────────────────────────
// Wallet users can authenticate to the proxy without API keys.
// Sign once with wallet → get HMAC session token → use for proxy requests.
// HMAC-SHA256 verification is ~3-5μs (same speed as API key hash lookup).

const PROXY_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour default
const MAX_PROXY_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hour max

function getProxySessionSecret(): string {
  const base = getJwtSecret();
  return crypto.createHmac("sha256", base).update("proxy-session").digest("hex");
}

export interface ProxySessionPayload {
  userId: string;
  walletAddress: string;
  expiresAt: number; // Unix ms
  nonce: string; // Unique per token for revocation
}

/**
 * Create a stateless HMAC-based proxy session token.
 * Format: base64url(payload).base64url(hmac)
 * Verification: ~3-5μs (same as SHA-256 hash lookup).
 */
export function createProxySessionToken(
  userId: string,
  walletAddress: string,
  ttlMs?: number,
): { token: string; expiresAt: number } {
  const ttl = Math.min(Math.max(ttlMs ?? PROXY_SESSION_TTL_MS, 60_000), MAX_PROXY_SESSION_TTL_MS);
  const expiresAt = Date.now() + ttl;
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload: ProxySessionPayload = { userId, walletAddress, expiresAt, nonce };
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const hmac = crypto.createHmac("sha256", getProxySessionSecret()).update(payloadStr).digest("base64url");
  return { token: `dn_proxy_${payloadStr}.${hmac}`, expiresAt };
}

/**
 * Verify a proxy session token. Returns payload or null.
 * O(1) HMAC verification — no DB lookup needed.
 */
export function verifyProxySessionToken(token: string): ProxySessionPayload | null {
  // Strip dn_proxy_ prefix
  const stripped = token.startsWith("dn_proxy_") ? token.slice(9) : null;
  if (!stripped) return null;

  const dotIdx = stripped.lastIndexOf(".");
  if (dotIdx === -1) return null;

  const payloadStr = stripped.slice(0, dotIdx);
  const providedHmac = stripped.slice(dotIdx + 1);

  // Length sanity — reject absurdly large tokens (>4KB payload)
  if (payloadStr.length > 4096 || providedHmac.length > 64) return null;

  // Compute expected HMAC
  const expectedHmac = crypto.createHmac("sha256", getProxySessionSecret()).update(payloadStr).digest("base64url");

  // Timing-safe comparison
  if (expectedHmac.length !== providedHmac.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expectedHmac), Buffer.from(providedHmac))) return null;

  // Parse and validate payload
  try {
    const raw = JSON.parse(Buffer.from(payloadStr, "base64url").toString("utf-8"));
    // Prototype pollution protection — strip dangerous keys from parsed payload
    if (raw && typeof raw === "object") {
      for (const key of Object.keys(raw)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          delete raw[key];
        }
      }
    }
    if (
      typeof raw.userId !== "string" || raw.userId.length === 0 ||
      typeof raw.walletAddress !== "string" || raw.walletAddress.length === 0 ||
      typeof raw.expiresAt !== "number" ||
      typeof raw.nonce !== "string" || raw.nonce.length === 0
    ) {
      return null;
    }
    // Check expiry
    if (Date.now() > raw.expiresAt) return null;
    // Defense-in-depth: reject tokens with expiresAt too far in the future
    if (raw.expiresAt > Date.now() + MAX_PROXY_SESSION_TTL_MS + 60_000) return null;

    return {
      userId: raw.userId,
      walletAddress: raw.walletAddress,
      expiresAt: raw.expiresAt,
      nonce: raw.nonce,
    };
  } catch {
    return null;
  }
}

/** Verify a refresh token */
export function verifyRefreshToken(token: string): (JwtPayload & { iat?: number }) | null {
  try {
    const decoded = jwt.verify(token, getRefreshSecret(), { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (
      typeof decoded.userId === "string" &&
      typeof decoded.email === "string" &&
      decoded.type === "refresh"
    ) {
      return {
        userId: decoded.userId,
        email: decoded.email,
        isAdmin: decoded.isAdmin === true,
        adminRole: typeof decoded.adminRole === "string" && VALID_ADMIN_ROLES.has(decoded.adminRole) ? decoded.adminRole : undefined,
        iat: decoded.iat,
      };
    }
    return null;
  } catch {
    return null;
  }
}
