import type { DbTxClient } from "../db.js";
import * as crypto from "node:crypto";
import type { PoolClient } from "pg";
import { query, queryOn } from "../db.js";

export interface RefreshTokenRecord {
  id: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  revoked: boolean;
  expires_at: Date;
  created_at: Date;
  /** Set only when the token was rotated by /refresh (not on logout/family revoke). */
  rotated_at?: Date | null;
}

/** A rotated token presented again within this window is a benign concurrent refresh, not theft. */
export const ROTATION_GRACE_MS = 10_000;

/** True when the token was rotated (not explicitly revoked) within the grace window. */
export function isWithinRotationGrace(
  token: { rotated_at?: Date | string | null },
  now: number = Date.now(),
): boolean {
  if (!token.rotated_at) return false;
  const t = new Date(token.rotated_at).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  return age >= -1_000 && age <= ROTATION_GRACE_MS;
}

/** Coarse IP prefix for client binding: /24 for IPv4, /48 for IPv6. */
function ipPrefix(ip: string): string {
  const v = ip.replace(/^::ffff:/i, "").trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v.split(".").slice(0, 3).join(".");
  if (v.includes(":")) return v.toLowerCase().split(":").slice(0, 3).join(":");
  return v;
}

/** SHA-256 binding of the client (User-Agent + IP prefix) a refresh token was issued to. */
export function clientBindingHash(userAgent: string | undefined, ip: string | undefined): string {
  return crypto.createHash("sha256")
    .update(`${(userAgent ?? "").slice(0, 512)}\n${ipPrefix(ip ?? "")}`)
    .digest("hex");
}

/**
 * Client binding of the token that replaced a rotated one (the newest token in
 * the family issued at or after the rotation). `undefined` when no successor
 * exists; `null` when the successor predates client binding.
 */
export async function findSuccessorClientHash(
  familyId: string,
  rotatedAt: Date | string,
): Promise<string | null | undefined> {
  const result = await query<{ client_hash: string | null }>(
    `SELECT client_hash FROM refresh_tokens
     WHERE family_id = $1 AND created_at >= $2::timestamptz - INTERVAL '1 second'
     ORDER BY created_at DESC LIMIT 1`,
    [familyId, new Date(rotatedAt)],
  );
  if (result.rows.length === 0) return undefined;
  return result.rows[0].client_hash ?? null;
}

/** Hash a refresh token for safe storage */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Generate a new family ID for a token chain */
export function newFamilyId(): string {
  return crypto.randomUUID();
}

/** Store a refresh token */
export async function storeToken(
  userId: string,
  tokenHash: string,
  familyId: string,
  expiresAt: Date,
  clientHash: string | null = null,
): Promise<Omit<RefreshTokenRecord, "token_hash">> {
  const result = await query<Omit<RefreshTokenRecord, "token_hash">>(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, client_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, family_id, revoked, expires_at, created_at`,
    [userId, tokenHash, familyId, expiresAt, clientHash],
  );
  return result.rows[0];
}

/** Find a valid (non-revoked, non-expired) token by its hash */
export async function findValidToken(tokenHash: string): Promise<Omit<RefreshTokenRecord, "token_hash"> | null> {
  // Exclude token_hash from SELECT — caller already has the hash as input
  const result = await query<Omit<RefreshTokenRecord, "token_hash">>(
    `SELECT id, user_id, family_id, revoked, expires_at, created_at FROM refresh_tokens
     WHERE token_hash = $1 AND NOT revoked AND expires_at > now()
     LIMIT 1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/** Find a token by hash regardless of revocation (for reuse detection) */
export async function findTokenByHash(tokenHash: string): Promise<Omit<RefreshTokenRecord, "token_hash"> | null> {
  // Exclude token_hash from SELECT — caller already has the hash as input
  const result = await query<Omit<RefreshTokenRecord, "token_hash">>(
    `SELECT id, user_id, family_id, revoked, expires_at, created_at, rotated_at FROM refresh_tokens WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/** Revoke a specific token */
export async function revokeToken(tokenHash: string): Promise<void> {
  await query(
    `UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1`,
    [tokenHash],
  );
}

/** Revoke all tokens in a family (theft detection) */
export async function revokeFamily(familyId: string): Promise<number> {
  const result = await query(
    `UPDATE refresh_tokens SET revoked = true WHERE family_id = $1 AND NOT revoked`,
    [familyId],
  );
  return result.rowCount ?? 0;
}

/** Revoke all tokens for a user (logout, password change) */
export async function revokeAllForUser(userId: string, ext?: DbTxClient): Promise<number> {
  const result = await queryOn(ext,
    `UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 AND NOT revoked`,
    [userId],
  );
  return result.rowCount ?? 0;
}

/** Find and lock a token row by hash within a transaction (FOR UPDATE SKIP LOCKED) */
export async function findAndLockTokenByHash(
  tokenHash: string,
  client: PoolClient,
): Promise<Omit<RefreshTokenRecord, "token_hash"> | null> {
  // Exclude token_hash from SELECT — caller already has the hash as input
  const result = await client.query(
    `SELECT id, user_id, family_id, revoked, expires_at, created_at
     FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE SKIP LOCKED LIMIT 1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/** Revoke a token within a transaction */
export async function revokeTokenInTx(tokenHash: string, client: PoolClient): Promise<void> {
  await client.query(`UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1`, [tokenHash]);
}

/** Store a refresh token within a transaction */
export async function storeTokenInTx(
  userId: string,
  tokenHash: string,
  familyId: string,
  expiresAt: Date,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [userId, tokenHash, familyId, expiresAt],
  );
}

/** Clean up expired tokens (maintenance) */
export async function purgeExpired(): Promise<number> {
  const result = await query(
    `DELETE FROM refresh_tokens WHERE expires_at < now() - INTERVAL '1 day'`,
    [],
  );
  return result.rowCount ?? 0;
}
