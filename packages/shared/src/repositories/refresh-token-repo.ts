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
): Promise<Omit<RefreshTokenRecord, "token_hash">> {
  const result = await query<Omit<RefreshTokenRecord, "token_hash">>(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, family_id, revoked, expires_at, created_at`,
    [userId, tokenHash, familyId, expiresAt],
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
    `SELECT id, user_id, family_id, revoked, expires_at, created_at FROM refresh_tokens WHERE token_hash = $1 LIMIT 1`,
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
