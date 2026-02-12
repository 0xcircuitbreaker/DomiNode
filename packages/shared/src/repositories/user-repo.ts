import { query } from "../db.js";
import type { User, ApiKey } from "../types.js";

export async function createUser(
  email: string,
  passwordHash: string,
): Promise<User> {
  const result = await query<User>(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING *`,
    [email, passwordHash],
  );
  return result.rows[0];
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const result = await query<User>(
    `SELECT * FROM users WHERE email = $1`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function findUserById(id: string): Promise<User | null> {
  const result = await query<User>(
    `SELECT id, email, created_at, status, password_changed_at, is_admin FROM users WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, password_hash: "" };
}

export async function findUserByApiKeyHash(
  keyHash: string,
): Promise<{ user: User; apiKey: ApiKey } | null> {
  const result = await query<User & { ak_id: string; ak_key_hash: string; ak_key_prefix: string; ak_label: string; ak_created_at: Date; ak_revoked_at: Date | null }>(
    `SELECT u.*,
            k.id AS ak_id,
            k.key_hash AS ak_key_hash,
            k.key_prefix AS ak_key_prefix,
            k.label AS ak_label,
            k.created_at AS ak_created_at,
            k.revoked_at AS ak_revoked_at
     FROM api_keys k
     JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = $1
       AND k.revoked_at IS NULL
       AND u.status = 'active'
     LIMIT 1`,
    [keyHash],
  );

  const row = result.rows[0];
  if (!row) return null;

  const user: User = {
    id: row.id,
    email: row.email,
    password_hash: "",
    created_at: row.created_at,
    status: row.status,
    password_changed_at: row.password_changed_at,
    is_admin: row.is_admin ?? false,
  };

  const apiKey: ApiKey = {
    id: row.ak_id,
    user_id: row.id,
    key_hash: row.ak_key_hash,
    key_prefix: row.ak_key_prefix,
    label: row.ak_label,
    created_at: row.ak_created_at,
    revoked_at: row.ak_revoked_at,
  };

  return { user, apiKey };
}

export async function updatePassword(
  userId: string,
  passwordHash: string,
): Promise<void> {
  await query(
    `UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2`,
    [passwordHash, userId],
  );
}

export async function createApiKey(
  userId: string,
  keyHash: string,
  keyPrefix: string,
  label: string,
): Promise<ApiKey> {
  const result = await query<ApiKey>(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, label)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userId, keyHash, keyPrefix, label],
  );
  return result.rows[0];
}

export async function listApiKeys(userId: string, includeRevoked: boolean = false): Promise<ApiKey[]> {
  const result = await query<ApiKey>(
    `SELECT id, user_id, key_prefix, label, created_at, revoked_at
     FROM api_keys
     WHERE user_id = $1 ${includeRevoked ? "" : "AND revoked_at IS NULL"}
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function countActiveKeys(userId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return parseInt(result.rows[0].count, 10);
}

export async function revokeApiKey(
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await query(
    `UPDATE api_keys
     SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Revoke all active API keys for a user (used on account suspension) */
export async function revokeAllApiKeys(userId: string): Promise<number> {
  const result = await query(
    `UPDATE api_keys SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return result.rowCount ?? 0;
}
