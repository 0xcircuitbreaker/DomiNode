import * as crypto from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const BCRYPT_ROUNDS = 12;
const API_KEY_BYTES = 32;
const ACCESS_TOKEN_EXPIRY = "15m"; // Short-lived access tokens
const REFRESH_TOKEN_EXPIRY = "7d"; // Refresh tokens last 7 days

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
  return crypto.createHash("sha256").update(`refresh:${base}`).digest("hex");
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

/** Verify an access token */
export function verifyJwt(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (typeof decoded.userId === "string" && typeof decoded.email === "string") {
      return { userId: decoded.userId, email: decoded.email };
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
      return { userId: decoded.userId, email: decoded.email, iat: decoded.iat };
    }
    return null;
  } catch {
    return null;
  }
}
