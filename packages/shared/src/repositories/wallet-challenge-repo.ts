import { query } from "../db.js";
import { WALLET_CHALLENGE_TTL_MS } from "../wallet-auth.js";

export interface WalletChallenge {
  id: string;
  address: string;
  nonce: string;
  ip_address: string;
  created_at: Date;
  consumed: boolean;
}

/** Create a new wallet challenge (nonce) for the given address */
export async function createChallenge(
  address: string,
  nonce: string,
  ip: string,
): Promise<WalletChallenge> {
  const result = await query<WalletChallenge>(
    `INSERT INTO wallet_challenges (address, nonce, ip_address)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [address.toLowerCase(), nonce, ip],
  );
  return result.rows[0];
}

/**
 * Atomically consume the most recent unconsumed challenge for an address.
 * Returns the challenge if found and within TTL, null otherwise.
 * Uses UPDATE...RETURNING for single-use enforcement (no replay).
 */
export async function consumeChallenge(
  address: string,
  ip?: string,
): Promise<WalletChallenge | null> {
  const ttlCutoff = new Date(Date.now() - WALLET_CHALLENGE_TTL_MS);

  // R18 H-4: If IP is provided, bind challenge consumption to the originating IP
  if (ip) {
    // R30 C-2: FOR UPDATE SKIP LOCKED prevents concurrent consumption of the same challenge
    const result = await query<WalletChallenge>(
      `UPDATE wallet_challenges
       SET consumed = true
       WHERE id = (
         SELECT id FROM wallet_challenges
         WHERE address = $1
           AND consumed = false
           AND created_at > $2
           AND ip_address = $3
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [address.toLowerCase(), ttlCutoff.toISOString(), ip],
    );
    return result.rows[0] ?? null;
  }

  // R30 C-2: FOR UPDATE SKIP LOCKED prevents concurrent consumption of the same challenge
  const result = await query<WalletChallenge>(
    `UPDATE wallet_challenges
     SET consumed = true
     WHERE id = (
       SELECT id FROM wallet_challenges
       WHERE address = $1
         AND consumed = false
         AND created_at > $2
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [address.toLowerCase(), ttlCutoff.toISOString()],
  );
  return result.rows[0] ?? null;
}

/** Purge expired challenges (older than 10 minutes) */
export async function purgeExpiredChallenges(): Promise<number> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  const result = await query(
    `DELETE FROM wallet_challenges WHERE created_at < $1`,
    [cutoff.toISOString()],
  );
  return result.rowCount ?? 0;
}

/** Count active (unconsumed, non-expired) challenges from an IP address */
export async function countActiveChallengesForIp(ip: string): Promise<number> {
  const ttlCutoff = new Date(Date.now() - WALLET_CHALLENGE_TTL_MS);
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM wallet_challenges
     WHERE ip_address = $1 AND consumed = false AND created_at > $2`,
    [ip, ttlCutoff.toISOString()],
  );
  return parseInt(result.rows[0].count, 10);
}
