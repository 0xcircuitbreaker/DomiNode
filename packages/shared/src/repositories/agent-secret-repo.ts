import * as crypto from "node:crypto";
import { getPool, query } from "../db.js";

/** Maximum active agent secrets per user */
export const MAX_AGENT_SECRETS_PER_USER = 5;

/** Prefix for agent secrets — distinguishable from dn_live_ API keys */
export const AGENT_SECRET_PREFIX = "das_";

export interface AgentSecret {
  id: string;
  user_id: string;
  label: string;
  created_at: Date;
  revoked_at: Date | null;
  last_used: Date | null;
}

export interface GeneratedAgentSecret {
  /** The raw secret — shown to user once, never stored */
  raw: string;
  /** SHA-256 hex hash — stored in DB for O(1) lookup */
  hash: string;
}

/** Generate a new agent secret with das_ prefix */
export function generateAgentSecret(): GeneratedAgentSecret {
  const random = crypto.randomBytes(32).toString("hex");
  const raw = `${AGENT_SECRET_PREFIX}${random}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

/** Hash an agent secret for DB lookup */
export function hashAgentSecret(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Create a new agent secret for a user.
 * Enforces per-user cap within a transaction.
 * Returns the created record (without hash).
 */
export async function createSecret(
  userId: string,
  secretHash: string,
  label: string,
): Promise<AgentSecret> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Count active secrets for this user — FOR UPDATE to prevent race
    const countResult = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM agent_secrets
       WHERE user_id = $1 AND revoked_at IS NULL
       FOR UPDATE`,
      [userId],
    );
    const activeCount = parseInt(countResult.rows[0].count, 10);
    if (activeCount >= MAX_AGENT_SECRETS_PER_USER) {
      // Revoke the oldest active secret to make room
      await client.query(
        `UPDATE agent_secrets
         SET revoked_at = now()
         WHERE id = (
           SELECT id FROM agent_secrets
           WHERE user_id = $1 AND revoked_at IS NULL
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )`,
        [userId],
      );
    }

    const result = await client.query<AgentSecret>(
      `INSERT INTO agent_secrets (user_id, secret_hash, label)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, label, created_at, revoked_at, last_used`,
      [userId, secretHash, label],
    );

    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Look up a user_id by agent secret hash.
 * Returns the user_id if the secret is active (not revoked), null otherwise.
 * Updates last_used timestamp as a side effect.
 */
export async function findUserBySecretHash(
  secretHash: string,
): Promise<string | null> {
  const result = await query<{ user_id: string }>(
    `UPDATE agent_secrets
     SET last_used = now()
     WHERE secret_hash = $1 AND revoked_at IS NULL
     RETURNING user_id`,
    [secretHash],
  );
  return result.rows[0]?.user_id ?? null;
}

/** List active (non-revoked) agent secrets for a user */
export async function listSecrets(userId: string): Promise<AgentSecret[]> {
  const result = await query<AgentSecret>(
    `SELECT id, user_id, label, created_at, revoked_at, last_used
     FROM agent_secrets
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}

/** Revoke a specific agent secret by ID. Returns the hash for cache invalidation. */
export async function revokeSecret(
  userId: string,
  secretId: string,
): Promise<string | null> {
  const result = await query<{ secret_hash: string }>(
    `UPDATE agent_secrets
     SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING secret_hash`,
    [secretId, userId],
  );
  return result.rows[0]?.secret_hash ?? null;
}

/** Revoke all agent secrets for a user (used during account suspension/deletion) */
export async function revokeAllSecrets(userId: string): Promise<number> {
  const result = await query(
    `UPDATE agent_secrets
     SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return result.rowCount ?? 0;
}
