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
 * Pending relay_settle_retries are kept so the charge still settles.
 */
export const RELAY_ERASURE_STATEMENTS: ReadonlyArray<{ label: string; sql: string }> = [
  // Destination metadata where this user was the requester.
  { label: "relay_abuse_log", sql: "DELETE FROM relay_abuse_log WHERE requester_user_id = $1" },
  // Finished settle retries carry the destination host in their payload.
  {
    label: "relay_settle_retries",
    sql: "DELETE FROM relay_settle_retries WHERE requester_user_id = $1 AND status <> 'pending'",
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
  // Starter-credit grant: drop the claimant's IP prefix.
  { label: "starter_credit_grants", sql: "UPDATE starter_credit_grants SET ip_prefix = NULL WHERE user_id = $1" },
  { label: "requester_spend_inflight", sql: "DELETE FROM requester_spend_inflight WHERE user_id = $1" },
  { label: "requester_rate_window", sql: "DELETE FROM requester_rate_window WHERE user_id = $1" },
];

/** Run every relay-network erasure statement on the caller's transaction client. */
export async function eraseRelayPersonalDataTx(client: Pick<PoolClient, "query">, userId: string): Promise<void> {
  for (const s of RELAY_ERASURE_STATEMENTS) {
    await client.query(s.sql, [userId]);
  }
}
