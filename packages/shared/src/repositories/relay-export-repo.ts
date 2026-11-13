import { query } from "../db.js";

/**
 * GDPR access-right export of relay-network personal data (GET /api/account/export).
 * Explicit columns only, each capped at EXPORT_ROW_CAP rows. $1 is the user id,
 * $2 the user's wallet address (lowercased, may be null) for x402 rows, which
 * have no user_id column.
 */
export const EXPORT_ROW_CAP = 10_000;

export const RELAY_EXPORT_QUERIES: ReadonlyArray<{ key: string; table: string; sql: string }> = [
  {
    key: "nodes", table: "nodes",
    sql: `SELECT id, owner_wallet, status, observed_ip, ip_prefix24, asn, country, ip_class, declared_class, probe_class,
            max_streams, max_gb_day, reputation, byte_disputes, agent_version, last_seen_at, created_at
          FROM nodes WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT ${EXPORT_ROW_CAP}`,
  },
  {
    key: "relayAbuseLog", table: "relay_abuse_log",
    sql: `SELECT ts, session_id, node_id, dest_host, dest_port, bytes
          FROM relay_abuse_log WHERE requester_user_id = $1 ORDER BY ts DESC LIMIT ${EXPORT_ROW_CAP}`,
  },
  {
    key: "relayCharges", table: "relay_charges",
    sql: `SELECT id, session_id, node_id, payment_rail, bytes_gateway, bytes_node, price_per_gb_musd, gross_musd,
            node_musd, platform_musd, zero_reason, disputed, matures_at, matured, created_at,
            (requester_user_id = $1) AS as_requester, (node_owner_user_id = $1) AS as_node_owner
          FROM relay_charges WHERE requester_user_id = $1 OR node_owner_user_id = $1
          ORDER BY created_at DESC LIMIT ${EXPORT_ROW_CAP}`,
  },
  {
    key: "nodeCreditAccount", table: "node_credit_accounts",
    sql: `SELECT pending_musd, available_musd, auto_convert_pct, frozen, tax_form_status, tax_form_type,
            tax_form_received_at, tax_year, ytd_paid_musd, updated_at
          FROM node_credit_accounts WHERE user_id = $1`,
  },
  {
    key: "nodeCreditTransactions", table: "node_credit_transactions",
    sql: `SELECT id, type, amount_musd, relay_charge_id, external_ref, created_at
          FROM node_credit_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${EXPORT_ROW_CAP}`,
  },
  {
    key: "payoutWallets", table: "payout_wallets",
    sql: `SELECT id, address, chain, status, active_from, created_at
          FROM payout_wallets WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${EXPORT_ROW_CAP}`,
  },
  {
    key: "nodePayouts", table: "node_payouts",
    sql: `SELECT id, amount_musd, trigger, status, tx_hash, failure_reason, created_at, updated_at
          FROM node_payouts WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${EXPORT_ROW_CAP}`,
  },
  {
    key: "payerIdentities", table: "payer_identities",
    sql: `SELECT chain, address, created_at FROM payer_identities WHERE user_id = $1 LIMIT ${EXPORT_ROW_CAP}`,
  },
  {
    key: "x402Transactions", table: "x402_transactions",
    sql: `SELECT id, facilitator, payer_address, amount_usd, tx_hash, pool_type, target_host, status, created_at
          FROM x402_transactions
          WHERE ($2::text IS NOT NULL AND payer_address = lower($2::text))
             OR payer_address IN (SELECT address FROM payer_identities WHERE user_id = $1)
          ORDER BY created_at DESC LIMIT ${EXPORT_ROW_CAP}`,
  },
  {
    key: "mppTransactions", table: "mpp_transactions",
    sql: `SELECT id, amount_musd, excess_musd, status, created_at
          FROM mpp_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${EXPORT_ROW_CAP}`,
  },
  {
    key: "starterCreditGrants", table: "starter_credit_grants",
    sql: `SELECT id, amount_musd, remaining_musd, ip_prefix, status, expires_at, created_at, closed_at
          FROM starter_credit_grants WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${EXPORT_ROW_CAP}`,
  },
  {
    key: "nodeReportsFiled", table: "node_reports",
    sql: `SELECT id, session_id, node_id, reason, day, created_at
          FROM node_reports WHERE reporter_user_id = $1 ORDER BY created_at DESC LIMIT ${EXPORT_ROW_CAP}`,
  },
  {
    key: "requesterSpendDaily", table: "requester_spend_daily",
    sql: `SELECT day, settled_musd FROM requester_spend_daily WHERE user_id = $1 ORDER BY day DESC LIMIT ${EXPORT_ROW_CAP}`,
  },
  {
    key: "genesisMembership", table: "genesis_members",
    sql: `SELECT seq, enrolled_at, boost_until, credit_status, credit_musd, credit_granted_at, credit_matures_at
          FROM genesis_members WHERE owner_user_id = $1`,
  },
  {
    key: "contributionAllowlist", table: "contribution_allowlist",
    sql: `SELECT created_at FROM contribution_allowlist WHERE user_id = $1`,
  },
  {
    key: "walletOverflowCredits", table: "wallet_overflow_credits",
    sql: `SELECT amount_cents, reason, created_at, resolved_at FROM wallet_overflow_credits
          WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${EXPORT_ROW_CAP}`,
  },
];

/**
 * User-linked relay tables deliberately left out of the export, with the reason.
 * A test fails when a new user-linked table is neither exported nor listed here.
 */
export const RELAY_EXPORT_EXCLUDED: Readonly<Record<string, string>> = {
  node_challenges: "single-use registration nonce, minutes-lived",
  agent_sign_challenges: "single-use signing nonce, minutes-lived",
  relay_settle_retries: "internal settlement queue; the settled result is in relay_charges",
  requester_spend_inflight: "seconds-lived in-flight counter",
  requester_rate_window: "seconds-lived rate-limit counter",
  collusion_flags: "open abuse investigation (restricted under GDPR Art. 23)",
  node_ip_slots: "live copy of the node IP data exported under nodes",
};

export async function exportRelayPersonalData(
  userId: string,
  walletAddress: string | null,
): Promise<Record<string, unknown[]>> {
  const results = await Promise.all(
    RELAY_EXPORT_QUERIES.map((q) => query(q.sql, q.sql.includes("$2") ? [userId, walletAddress] : [userId])),
  );
  const out: Record<string, unknown[]> = {};
  RELAY_EXPORT_QUERIES.forEach((q, i) => { out[q.key] = results[i].rows; });
  return out;
}
