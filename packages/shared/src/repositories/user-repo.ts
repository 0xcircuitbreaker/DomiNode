import type { DbTxClient } from "../db.js";
import { WALLET_EMAIL_DOMAIN } from "../wallet-auth.js";
import { query, queryOn, getPool } from "../db.js";
import { hashPassword } from "../auth.js";
import { randomBytes, createHash } from "node:crypto";
import type { User, ApiKey } from "../types.js";

export async function createUser(
  email: string,
  passwordHash: string,
): Promise<User> {
  const result = await query<User>(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email, created_at, status, password_changed_at, is_admin, admin_role, wallet_address, log_target_hosts, email_verified`,
    [email, passwordHash],
  );
  return { ...result.rows[0], password_hash: "", wallet_address: result.rows[0].wallet_address ?? null, log_target_hosts: result.rows[0].log_target_hosts ?? false, email_verified: result.rows[0].email_verified ?? false };
}

/**
 * Find user by email for authentication (includes password_hash).
 * Only use in auth flows where password verification is needed.
 */
export async function findUserForAuth(email: string): Promise<User | null> {
  const result = await query<User>(
    `SELECT id, email, password_hash, created_at, status, password_changed_at, is_admin, admin_role, wallet_address, log_target_hosts, email_verified FROM users WHERE email = $1 AND status = 'active'`,
    [email],
  );
  return result.rows[0] ?? null;
}

/**
 * Find user by email (safe — redacts password_hash).
 * Use in non-auth contexts where password_hash is not needed.
 */
export async function findUserByEmail(email: string): Promise<User | null> {
  const result = await query<User>(
    `SELECT id, email, created_at, status, password_changed_at, is_admin, admin_role, wallet_address, log_target_hosts, email_verified FROM users WHERE email = $1`,
    [email],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, password_hash: "", wallet_address: row.wallet_address ?? null, log_target_hosts: row.log_target_hosts ?? false, email_verified: row.email_verified ?? false };
}

/**
 * Count all non-deleted, non-admin users. Used for global registration cap enforcement.
 * Admin accounts don't consume alpha slots.
 */
export async function countActiveUsers(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM users WHERE status != 'deleted' AND is_admin = false`,
  );
  return parseInt(result.rows[0].count, 10);
}

export async function findUserById(id: string): Promise<User | null> {
  const result = await query<User>(
    `SELECT id, email, created_at, status, password_changed_at, is_admin, admin_role, wallet_address, log_target_hosts, email_verified FROM users WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, password_hash: "", wallet_address: row.wallet_address ?? null, log_target_hosts: row.log_target_hosts ?? false, email_verified: row.email_verified ?? false };
}

export async function findUserByApiKeyHash(
  keyHash: string,
): Promise<{ user: User; apiKey: ApiKey } | null> {
  const result = await query<User & { ak_id: string; ak_key_prefix: string; ak_label: string; ak_created_at: Date; ak_revoked_at: Date | null; ak_team_id: string | null }>(
    `SELECT u.id, u.email, u.created_at, u.status, u.password_changed_at, u.is_admin, u.admin_role, u.wallet_address, u.log_target_hosts, u.email_verified, u.plan_id,
            k.id AS ak_id,
            k.key_prefix AS ak_key_prefix,
            k.label AS ak_label,
            k.created_at AS ak_created_at,
            k.revoked_at AS ak_revoked_at,
            k.team_id AS ak_team_id
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
    admin_role: (row as unknown as { admin_role?: string }).admin_role as import("../types.js").AdminRole ?? "none",
    wallet_address: row.wallet_address ?? null,
    log_target_hosts: row.log_target_hosts ?? false,
    email_verified: row.email_verified ?? false,
  };

  const apiKey: ApiKey = {
    id: row.ak_id,
    user_id: row.id,
    team_id: row.ak_team_id ?? null,
    key_hash: "",
    key_prefix: row.ak_key_prefix,
    label: row.ak_label,
    created_at: row.ak_created_at,
    revoked_at: row.ak_revoked_at,
  };

  return { user, apiKey };
}

/** Create a user authenticated via crypto wallet (synthetic email, unusable password) */
export async function createWalletUser(
  walletAddress: string,
  syntheticEmail: string,
  randomHash: string,
): Promise<User> {
  const result = await query<User>(
    `INSERT INTO users (email, password_hash, wallet_address, email_verified)
     VALUES ($1, $2, $3, true)
     RETURNING id, email, created_at, status, password_changed_at, is_admin, admin_role, wallet_address, log_target_hosts, email_verified`,
    [syntheticEmail, randomHash, walletAddress.toLowerCase()],
  );
  return { ...result.rows[0], password_hash: "", wallet_address: result.rows[0].wallet_address ?? null, log_target_hosts: result.rows[0].log_target_hosts ?? false, email_verified: result.rows[0].email_verified ?? false };
}

/**
 * Find user by wallet address for authentication (includes password_hash).
 * Only use in auth flows where password verification is needed.
 */
export async function findWalletUserForAuth(address: string): Promise<User | null> {
  const result = await query<User>(
    `SELECT id, email, password_hash, created_at, status, password_changed_at, is_admin, admin_role, wallet_address, log_target_hosts, email_verified FROM users WHERE wallet_address = $1 AND status = 'active'`,
    [address.toLowerCase()],
  );
  return result.rows[0] ?? null;
}

/** Find a user by their linked wallet address (safe — redacts password_hash) */
export async function findUserByWalletAddress(address: string): Promise<User | null> {
  const result = await query<User>(
    `SELECT id, email, created_at, status, password_changed_at, is_admin, admin_role, wallet_address, log_target_hosts, email_verified FROM users WHERE wallet_address = $1`,
    [address.toLowerCase()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, password_hash: "", wallet_address: row.wallet_address ?? null, log_target_hosts: row.log_target_hosts ?? false, email_verified: row.email_verified ?? false };
}

/** Link a wallet address to an existing user account */
export async function linkWalletAddress(userId: string, address: string): Promise<boolean> {
  const result = await query(
    `UPDATE users SET wallet_address = $1 WHERE id = $2 AND wallet_address IS NULL`,
    [address.toLowerCase(), userId],
  );
  return (result.rowCount ?? 0) > 0;
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
     RETURNING id, user_id, team_id, key_prefix, label, created_at, revoked_at`,
    [userId, keyHash, keyPrefix, label],
  );
  return { ...result.rows[0], key_hash: "", team_id: result.rows[0].team_id ?? null };
}

export async function listApiKeys(userId: string, includeRevoked: boolean = false): Promise<ApiKey[]> {
  // Use separate query strings instead of template literal interpolation
  const sql = includeRevoked
    ? `SELECT id, user_id, team_id, key_prefix, label, created_at, revoked_at
       FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`
    : `SELECT id, user_id, team_id, key_prefix, label, created_at, revoked_at
       FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`;
  const result = await query<ApiKey>(sql, [userId]);
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
export async function revokeAllApiKeys(userId: string, ext?: DbTxClient): Promise<number> {
  const result = await queryOn(ext,
    `UPDATE api_keys SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return result.rowCount ?? 0;
}

/** Update user's target host logging preference */
export async function updateLogTargetHosts(userId: string, enabled: boolean): Promise<boolean> {
  const result = await query(
    `UPDATE users SET log_target_hosts = $1 WHERE id = $2`,
    [enabled, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Mark a user's email as verified */
export async function markEmailVerified(userId: string): Promise<boolean> {
  const result = await query(
    `UPDATE users SET email_verified = true WHERE id = $1`,
    [userId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ─── Email Verification Tokens ──────────────────────────────────────

export async function createEmailVerificationToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
  // Wrap DELETE old + INSERT new in a single transaction to prevent race conditions
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Delete any existing tokens for this user first (one active token at a time)
    await client.query(`DELETE FROM email_verification_tokens WHERE user_id = $1`, [userId]);
    await client.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function findRecentEmailVerificationToken(userId: string, withinSeconds: number): Promise<boolean> {
  const result = await query<{ id: string }>(
    `SELECT id FROM email_verification_tokens
     WHERE user_id = $1 AND created_at > NOW() - make_interval(secs => $2)
     LIMIT 1`,
    [userId, withinSeconds],
  );
  return result.rows.length > 0;
}

/** Atomically consume an email verification token (DELETE...RETURNING) to prevent TOCTOU */
export async function consumeEmailVerificationToken(tokenHash: string): Promise<{ userId: string; expiresAt: Date } | null> {
  const result = await query<{ user_id: string; expires_at: Date }>(
    `DELETE FROM email_verification_tokens
     WHERE token_hash = $1
     RETURNING user_id, expires_at`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { userId: row.user_id, expiresAt: row.expires_at };
}

// ─── Password Reset Tokens ──────────────────────────────────────────

export async function createPasswordResetToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
  // Wrap DELETE old + INSERT new in a single transaction to prevent race conditions
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Delete any existing unused tokens for this user (one active reset at a time)
    await client.query(`DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Atomically consume a password reset token (DELETE...RETURNING) to prevent TOCTOU */
export async function consumePasswordResetToken(tokenHash: string): Promise<{ userId: string; expiresAt: Date } | null> {
  const result = await query<{ user_id: string; expires_at: Date }>(
    `DELETE FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL
     RETURNING user_id, expires_at`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { userId: row.user_id, expiresAt: row.expires_at };
}

const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
/** Solana base58 public key (32 bytes → 32..44 base58 chars). Case-sensitive. */
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Solana x402 payer → wallet-identity user via payer_identities (users.wallet_address
 * stays EVM-only). User + identity are inserted in ONE statement, so either both
 * exist or neither; a concurrent create collapses on the deterministic email
 * (base58 is case-sensitive, so the email carries a hash, not the address).
 */
async function findOrCreateSolanaPayerUser(addr: string): Promise<{ id: string; status: string; created: boolean }> {
  const find = async () => (await query<{ id: string; status: string }>(
    `SELECT u.id, u.status FROM payer_identities p JOIN users u ON u.id = p.user_id
     WHERE p.chain = 'solana' AND p.address = $1`, [addr],
  )).rows[0];
  const existing = await find();
  if (existing) return { ...existing, created: false };
  const unusable = await hashPassword(randomBytes(64).toString("hex"));
  const email = `sol-${createHash("sha256").update(addr).digest("hex").slice(0, 40)}@${WALLET_EMAIL_DOMAIN}`;
  const ins = await query<{ id: string; status: string }>(
    `WITH u AS (
       INSERT INTO users (email, password_hash, email_verified) VALUES ($1, $2, true)
       ON CONFLICT DO NOTHING RETURNING id, status
     ), p AS (
       INSERT INTO payer_identities (chain, address, user_id) SELECT 'solana', $3, id FROM u
       ON CONFLICT DO NOTHING RETURNING user_id
     )
     SELECT u.id, u.status FROM u JOIN p ON p.user_id = u.id`,
    [email, unusable, addr],
  );
  if (ins.rows[0]) return { ...ins.rows[0], created: true };
  const raced = await find();
  if (!raced) throw new Error("x402 payer identity conflict");
  return { ...raced, created: false };
}

/**
 * x402 payer → wallet-identity user (DESIGN.md §7): reuse the user bound to
 * this payer address, or create one (synthetic email, unusable bcrypt password,
 * same identity wallet-auth would create). Race-safe: concurrent creates
 * collapse onto the unique wallet_address/email indexes via ON CONFLICT DO NOTHING.
 * Only EVM payers can be mapped (users.wallet_address is 0x + 40 hex).
 */
export async function findOrCreateX402User(payer: string): Promise<{ id: string; status: string; created: boolean }> {
  if (typeof payer === "string" && SOLANA_ADDRESS_RE.test(payer)) return findOrCreateSolanaPayerUser(payer);
  const addr = typeof payer === "string" ? payer.toLowerCase() : "";
  if (!EVM_ADDRESS_RE.test(addr)) throw new Error("x402 payer must be an EVM address or a Solana address");
  const find = async () => (await query<{ id: string; status: string }>(
    `SELECT id, status FROM users WHERE wallet_address = $1`, [addr],
  )).rows[0];
  const existing = await find();
  if (existing) return { ...existing, created: false };
  const unusable = await hashPassword(randomBytes(64).toString("hex"));
  const ins = await query<{ id: string; status: string }>(
    `INSERT INTO users (email, password_hash, wallet_address, email_verified)
     VALUES ($1, $2, $3, true)
     ON CONFLICT DO NOTHING
     RETURNING id, status`,
    [`${addr}@${WALLET_EMAIL_DOMAIN}`, unusable, addr],
  );
  if (ins.rows[0]) return { ...ins.rows[0], created: true };
  const raced = await find();
  if (!raced) throw new Error("x402 payer identity conflict");
  return { ...raced, created: false };
}
