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
export async function eraseRelayPersonalDataTx(client: Pick<PoolClient, "query">, userId: string): Promise<void> {
  // Lock the earnings account first, the same order the payout paths use.
  await client.query("SELECT user_id FROM node_credit_accounts WHERE user_id = $1 FOR UPDATE", [userId]);
  const inFlight = await client.query(PAYOUT_IN_FLIGHT_SQL, [userId]);
  if ((inFlight.rows?.length ?? 0) > 0) throw new PayoutInFlightError();
  await client.query(PAYOUT_ERASURE_REVERSAL_SQL, [userId]);
  for (const s of RELAY_ERASURE_STATEMENTS) {
    await client.query(s.sql, [userId]);
  }
}
