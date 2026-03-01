import * as crypto from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

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
  /** SHA-256 hex digest — stored in DB for fast lookup */
  hash: string;
  /** First 16 chars of raw key — stored for display */
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const random = crypto.randomBytes(API_KEY_BYTES).toString("hex");
  const raw = `dn_live_${random}`;
  const hash = hashApiKey(raw);
  const prefix = raw.slice(0, 16);
  return { raw, hash, prefix };
}

export function hashApiKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
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
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** Sign a short-lived access token (15 minutes) */
export function signJwt(payload: JwtPayload): string {
  return jwt.sign(payload, getJwtSecret(), { algorithm: "HS256", expiresIn: ACCESS_TOKEN_EXPIRY });
}

/** Sign a long-lived refresh token (7 days) */
export function signRefreshToken(payload: JwtPayload): string {
  return jwt.sign({ ...payload, type: "refresh" }, getRefreshSecret(), {
    algorithm: "HS256",
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
}

/** Create both access + refresh tokens */
export function createTokenPair(payload: JwtPayload): TokenPair {
  return {
    accessToken: signJwt(payload),
    refreshToken: signRefreshToken(payload),
  };
}

/** Verify an access token — rejects MFA challenge tokens */
export function verifyJwt(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] }) as jwt.JwtPayload;
    // Reject MFA challenge tokens from being used as access tokens
    if (decoded.mfaPending === true) return null;
    if (typeof decoded.userId === "string" && typeof decoded.email === "string") {
      return { userId: decoded.userId, email: decoded.email, isAdmin: decoded.isAdmin === true };
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

/** Verify a refresh token */
export function verifyRefreshToken(token: string): (JwtPayload & { iat?: number }) | null {
  try {
    const decoded = jwt.verify(token, getRefreshSecret(), { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (
      typeof decoded.userId === "string" &&
      typeof decoded.email === "string" &&
      decoded.type === "refresh"
    ) {
      return { userId: decoded.userId, email: decoded.email, isAdmin: decoded.isAdmin === true, iat: decoded.iat };
    }
    return null;
  } catch {
    return null;
  }
}
