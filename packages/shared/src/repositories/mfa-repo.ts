import { query, getPool } from "../db.js";

export interface MfaConfig {
  id: string;
  user_id: string;
  totp_secret_enc: string;
  totp_secret_iv: string;
  enabled: boolean;
  created_at: Date;
  enabled_at: Date | null;
}

export interface MfaBackupCode {
  id: string;
  user_id: string;
  code_hash: string;
  used_at: Date | null;
  created_at: Date;
}

export async function createMfaConfig(
  userId: string,
  encSecret: string,
  iv: string,
): Promise<MfaConfig> {
  const result = await query(
    `INSERT INTO mfa_configs (user_id, totp_secret_enc, totp_secret_iv)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET totp_secret_enc = $2, totp_secret_iv = $3, enabled = false, enabled_at = NULL
     RETURNING id, user_id, enabled, created_at, enabled_at`,
    [userId, encSecret, iv],
  );
  return result.rows[0] as MfaConfig;
}

export async function findMfaConfigByUserId(userId: string): Promise<MfaConfig | null> {
  const result = await query(
    `SELECT id, user_id, totp_secret_enc, totp_secret_iv, enabled, created_at, enabled_at FROM mfa_configs WHERE user_id = $1`,
    [userId],
  );
  return (result.rows[0] as MfaConfig) ?? null;
}

export async function enableMfa(userId: string): Promise<void> {
  await query(
    `UPDATE mfa_configs SET enabled = true, enabled_at = now() WHERE user_id = $1`,
    [userId],
  );
}

export async function disableMfa(userId: string): Promise<void> {
  await query(`DELETE FROM mfa_configs WHERE user_id = $1`, [userId]);
}

export async function deleteMfaConfig(userId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM mfa_configs WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM mfa_backup_codes WHERE user_id = $1`, [userId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function storeBackupCodes(userId: string, hashes: string[]): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM mfa_backup_codes WHERE user_id = $1`, [userId]);
    for (const hash of hashes) {
      await client.query(
        `INSERT INTO mfa_backup_codes (user_id, code_hash) VALUES ($1, $2)`,
        [userId, hash],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function findUnusedBackupCode(
  userId: string,
  codeHash: string,
): Promise<MfaBackupCode | null> {
  const result = await query(
    `SELECT id, user_id, code_hash, used_at, created_at FROM mfa_backup_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, codeHash],
  );
  return (result.rows[0] as MfaBackupCode) ?? null;
}

/**
 * Atomically find and consume a backup code in a single query.
 * Returns the consumed code or null if not found/already used.
 * Prevents race conditions where the same code could be used twice.
 */
export async function consumeBackupCodeAtomic(
  userId: string,
  codeHash: string,
): Promise<MfaBackupCode | null> {
  const result = await query(
    `UPDATE mfa_backup_codes SET used_at = now()
     WHERE id = (
       SELECT id FROM mfa_backup_codes
       WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, user_id, code_hash, used_at, created_at`,
    [userId, codeHash],
  );
  return (result.rows[0] as MfaBackupCode) ?? null;
}

export async function consumeBackupCode(codeId: string): Promise<void> {
  await query(
    `UPDATE mfa_backup_codes SET used_at = now() WHERE id = $1`,
    [codeId],
  );
}

export async function deleteAllBackupCodes(userId: string): Promise<void> {
  await query(`DELETE FROM mfa_backup_codes WHERE user_id = $1`, [userId]);
}

export async function countUnusedBackupCodes(userId: string): Promise<number> {
  const result = await query(
    `SELECT COUNT(*)::int AS count FROM mfa_backup_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  return (result.rows[0] as { count: number }).count;
}
