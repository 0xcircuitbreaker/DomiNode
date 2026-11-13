import type { PoolClient } from "pg";

/**
 * GDPR erasure of relay-network personal data for one user.
 *
 * Both erasure paths (DELETE /api/account and admin deleteUser) anonymize the
 * users row instead of deleting it, so ON DELETE CASCADE never fires. This
 * helper must be called INSIDE their BEGIN/COMMIT so erasure is all-or-nothing.
 *
 * Kept (accounting / payout audit, keyed only by the now-anonymized user id):
 * relay_charges, node_credit_accounts/transactions, requester_spend_daily,
 * node_payouts amounts and tx hashes, collusion_flags (abuse control).
 * Pending relay_settle_retries are kept so the charge still settles, but their
 * payload is scrubbed of the destination and wallet; settleRelayCharge also
 * skips the abuse log and usage target_host for a deleted requester.
 */
export const RELAY_ERASURE_STATEMENTS: ReadonlyArray<{ label: string; sql: string }> = [
  // Destination metadata where this user was the requester.
  { label: "relay_abuse_log", sql: "DELETE FROM relay_abuse_log WHERE requester_user_id = $1" },
  // Finished settle retries carry the destination host in their payload.
  {
    label: "relay_settle_retries",
    sql: "DELETE FROM relay_settle_retries WHERE requester_user_id = $1 AND status <> 'pending'",
  },
  // Pending retries still settle; drop the destination and wallet they carry.
  {
    label: "relay_settle_retries_pending",
    sql: `UPDATE relay_settle_retries
             SET payload = (payload - 'requesterWallet' - 'usageTargetHost')
                           || '{"destHost":"redacted","requesterWallet":null}'::jsonb
           WHERE requester_user_id = $1 AND status = 'pending'`,
  },
  // Live IP slots of this user's nodes (exit IP, /24, ASN).
  {
    label: "node_ip_slots",
    sql: "DELETE FROM node_ip_slots WHERE node_id IN (SELECT id FROM nodes WHERE owner_user_id = $1)",
  },
  // Nodes: revoke and drop the operator's IP, prefix, ASN, country and wallet.
  {
    label: "nodes",
    sql: `UPDATE nodes SET status = 'revoked', observed_ip = NULL, ip_prefix24 = NULL, asn = NULL,
            country = NULL, owner_wallet = '0x0000000000000000000000000000000000000000'
          WHERE owner_user_id = $1`,
  },
  { label: "node_challenges", sql: "DELETE FROM node_challenges WHERE user_id = $1" },
  // Payout wallets: node_payouts.payout_wallet_id is ON DELETE SET NULL.
  { label: "payout_wallets", sql: "DELETE FROM payout_wallets WHERE user_id = $1" },
  // Unlink finished payouts from the user (amounts/tx hashes kept for audit).
  {
    label: "node_payouts",
    sql: "UPDATE node_payouts SET user_id = NULL WHERE user_id = $1 AND status IN ('confirmed','failed','reversed')",
  },
  { label: "agent_sign_challenges", sql: "DELETE FROM agent_sign_challenges WHERE user_id = $1" },
  { label: "agent_secrets", sql: "DELETE FROM agent_secrets WHERE user_id = $1" },
  // Non-EVM payer address -> user mapping.
  { label: "payer_identities", sql: "DELETE FROM payer_identities WHERE user_id = $1" },
  // Burn reports this user filed as a requester.
  { label: "node_reports", sql: "DELETE FROM node_reports WHERE reporter_user_id = $1" },
  // Starter-credit grant: drop the claimant's IP prefix and hash any legacy
  // plaintext funding source (same h1 form grantTx matches, so caps still hold).
  {
    label: "starter_credit_grants",
    sql: `UPDATE starter_credit_grants SET ip_prefix = NULL,
            funding_source = CASE WHEN funding_source ~ '^h[12]:[0-9a-f]{64}$' THEN funding_source
              ELSE 'h1:' || encode(sha256(convert_to('starter-funding:' || funding_source, 'UTF8')), 'hex') END
          WHERE user_id = $1`,
  },
  { label: "requester_spend_inflight", sql: "DELETE FROM requester_spend_inflight WHERE user_id = $1" },
  { label: "requester_rate_window", sql: "DELETE FROM requester_rate_window WHERE user_id = $1" },
  // Admin audit rows ABOUT this user (user_id there is the admin): keep the
  // action and admin for accountability, drop what links back to the user.
  {
    label: "audit_events_about_user",
    sql: `UPDATE audit_events SET resource_id = 'REDACTED', details = NULL
          WHERE (user_id IS NULL OR user_id::text <> $1::text)
            AND (resource_id = $1::text
              OR details->>'requesterId' = $1::text OR details->>'userId' = $1::text
              OR details->>'ownerUserId' = $1::text OR details->>'targetUserId' = $1::text
              OR resource_id IN (SELECT id::text FROM nodes WHERE owner_user_id::text = $1::text))`,
  },
];

/** Erasure refused: a payout may be on-chain and must settle first. */
export class PayoutInFlightError extends Error {
  constructor() {
    super("A payout is in flight; account erasure can run once it settles");
    this.name = "PayoutInFlightError";
  }
}

/** Payouts that may already be on-chain (submitted, or claimed with a tx hash). */
export const PAYOUT_IN_FLIGHT_SQL = `SELECT id FROM node_payouts
  WHERE user_id = $1 AND (status = 'submitted' OR (status IN ('pending','held_tax','held_frozen') AND tx_hash IS NOT NULL))
  LIMIT 1 FOR UPDATE`;

/**
 * Reverse every unsent payout and re-credit the earnings ledger before the
 * payout wallet is deleted. The payout processor JOINs payout_wallets, so an
 * unsent payout left behind would stay pending forever.
 */
export const PAYOUT_ERASURE_REVERSAL_SQL = `WITH rev AS (
    UPDATE node_payouts SET status = 'reversed', failure_reason = 'account erased: reversed', updated_at = now()
     WHERE user_id = $1 AND status IN ('pending','held_tax','held_frozen') AND tx_hash IS NULL
     RETURNING id, amount_musd
  ), led AS (
    INSERT INTO node_credit_transactions (user_id, type, amount_musd, external_ref)
    SELECT $1, 'withdraw_reversal', amount_musd, id::text FROM rev
  )
  UPDATE node_credit_accounts
     SET available_musd = available_musd + (SELECT COALESCE(SUM(amount_musd), 0) FROM rev), updated_at = now()
   WHERE user_id = $1 AND EXISTS (SELECT 1 FROM rev)`;

/**
 * Run every relay-network erasure statement on the caller's transaction client.
 * Throws PayoutInFlightError (caller rolls back) while a payout may be on-chain.
 */
/**
 * x402 payments by this user: redact payer, tx hash and host (amounts kept for
 * accounting). Matches the EVM wallet case-insensitively and any Solana payer
 * linked via payer_identities, so it must run before payer_identities is deleted.
 * $2 is the user's wallet address read BEFORE users.wallet_address is nulled.
 */
export const X402_ERASURE_SQL = `UPDATE x402_transactions
     SET payer_address = 'REDACTED', target_host = 'REDACTED', tx_hash = 'REDACTED'
   WHERE ($2::text IS NOT NULL AND payer_address = lower($2::text))
      OR payer_address IN (SELECT address FROM payer_identities WHERE user_id = $1)`;

export async function eraseRelayPersonalDataTx(
  client: Pick<PoolClient, "query">,
  userId: string,
  walletAddress: string | null = null,
): Promise<void> {
  // Lock the earnings account first, the same order the payout paths use.
  await client.query("SELECT user_id FROM node_credit_accounts WHERE user_id = $1 FOR UPDATE", [userId]);
  const inFlight = await client.query(PAYOUT_IN_FLIGHT_SQL, [userId]);
  if ((inFlight.rows?.length ?? 0) > 0) throw new PayoutInFlightError();
  await client.query(PAYOUT_ERASURE_REVERSAL_SQL, [userId]);
  await client.query(X402_ERASURE_SQL, [userId, walletAddress]);
  for (const s of RELAY_ERASURE_STATEMENTS) {
    await client.query(s.sql, [userId]);
  }
}
