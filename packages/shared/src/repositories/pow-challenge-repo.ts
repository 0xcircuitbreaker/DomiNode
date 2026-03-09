import { query } from "../db.js";

/** TTL for PoW challenges: 5 minutes */
export const POW_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface PowChallenge {
  id: string;
  prefix: string;
  difficulty: number;
  ip_address: string;
  created_at: Date;
  consumed: boolean;
}

/** Create a new PoW challenge for the given IP address */
export async function createChallenge(
  prefix: string,
  difficulty: number,
  ipAddress: string,
): Promise<PowChallenge> {
  const result = await query<PowChallenge>(
    `INSERT INTO pow_challenges (prefix, difficulty, ip_address)
     VALUES ($1, $2, $3)
     RETURNING id, prefix, difficulty, ip_address, created_at, consumed`,
    [prefix, difficulty, ipAddress],
  );
  return result.rows[0];
}

/**
 * Atomically consume a PoW challenge by ID.
 * Returns the challenge if found, unconsumed, within TTL, and IP matches.
 * Uses UPDATE...RETURNING for single-use enforcement (no replay).
 */
export async function consumeChallenge(
  challengeId: string,
  ipAddress: string,
): Promise<PowChallenge | null> {
  const ttlCutoff = new Date(Date.now() - POW_CHALLENGE_TTL_MS);

  const result = await query<PowChallenge>(
    `UPDATE pow_challenges
     SET consumed = true
     WHERE id = $1
       AND consumed = false
       AND created_at > $2
       AND ip_address = $3
     RETURNING id, prefix, difficulty, ip_address, created_at, consumed`,
    [challengeId, ttlCutoff.toISOString(), ipAddress],
  );
  return result.rows[0] ?? null;
}

/** Count active (unconsumed, non-expired) challenges from an IP address */
export async function countActiveChallengesForIp(ip: string): Promise<number> {
  const ttlCutoff = new Date(Date.now() - POW_CHALLENGE_TTL_MS);
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM pow_challenges
     WHERE ip_address = $1 AND consumed = false AND created_at > $2`,
    [ip, ttlCutoff.toISOString()],
  );
  return parseInt(result.rows[0].count, 10);
}

/** Purge expired challenges (older than 10 minutes) */
export async function purgeExpiredChallenges(): Promise<number> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  const result = await query(
    `DELETE FROM pow_challenges WHERE created_at < $1`,
    [cutoff.toISOString()],
  );
  return result.rowCount ?? 0;
}
