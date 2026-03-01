import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("retention");

// M-4 fix: Batch size to prevent long table locks
const DELETE_BATCH_SIZE = 10_000;

// Pre-built query map eliminates dynamic table name interpolation.
// Each allowed table has its DELETE query as a static string — no SQL injection possible.
const TABLE_QUERIES: Record<string, string> = {
  usage_records: `DELETE FROM usage_records WHERE ctid IN (
    SELECT ctid FROM usage_records WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  sessions: `DELETE FROM sessions WHERE ctid IN (
    SELECT ctid FROM sessions WHERE started_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  audit_events: `DELETE FROM audit_events WHERE ctid IN (
    SELECT ctid FROM audit_events WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  wallet_transactions: `DELETE FROM wallet_transactions WHERE ctid IN (
    SELECT ctid FROM wallet_transactions WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  wallet_challenges: `DELETE FROM wallet_challenges WHERE ctid IN (
    SELECT ctid FROM wallet_challenges WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  email_verification_tokens: `DELETE FROM email_verification_tokens WHERE ctid IN (
    SELECT ctid FROM email_verification_tokens WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  password_reset_tokens: `DELETE FROM password_reset_tokens WHERE ctid IN (
    SELECT ctid FROM password_reset_tokens WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  agentic_wallet_transactions: `DELETE FROM agentic_wallet_transactions WHERE ctid IN (
    SELECT ctid FROM agentic_wallet_transactions WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  team_wallet_transactions: `DELETE FROM team_wallet_transactions WHERE ctid IN (
    SELECT ctid FROM team_wallet_transactions WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  team_invites: `DELETE FROM team_invites WHERE ctid IN (
    SELECT ctid FROM team_invites WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  x402_transactions: `DELETE FROM x402_transactions WHERE ctid IN (
    SELECT ctid FROM x402_transactions WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  agentic_wallets: `DELETE FROM agentic_wallets WHERE ctid IN (
    SELECT ctid FROM agentic_wallets WHERE status = 'deleted' AND created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  teams: `DELETE FROM teams WHERE ctid IN (
    SELECT ctid FROM teams WHERE status = 'deleted' AND created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  // Expired refresh tokens and old payment invoices
  refresh_tokens: `DELETE FROM refresh_tokens WHERE ctid IN (
    SELECT ctid FROM refresh_tokens WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  payment_invoices: `DELETE FROM payment_invoices WHERE ctid IN (
    SELECT ctid FROM payment_invoices WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  // Referral/affiliate/promo/loyalty tables
  referral_codes: `DELETE FROM referral_codes WHERE ctid IN (
    SELECT ctid FROM referral_codes WHERE created_at < NOW() - INTERVAL '1 day' * $1 AND active = false LIMIT $2
  )`,
  referral_redemptions: `DELETE FROM referral_redemptions WHERE ctid IN (
    SELECT ctid FROM referral_redemptions WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  affiliate_links: `DELETE FROM affiliate_links WHERE ctid IN (
    SELECT ctid FROM affiliate_links WHERE created_at < NOW() - INTERVAL '1 day' * $1 AND active = false LIMIT $2
  )`,
  affiliate_commissions: `DELETE FROM affiliate_commissions WHERE ctid IN (
    SELECT ctid FROM affiliate_commissions WHERE created_at < NOW() - INTERVAL '1 day' * $1 AND status = 'credited' LIMIT $2
  )`,
  promo_codes: `DELETE FROM promo_codes WHERE ctid IN (
    SELECT ctid FROM promo_codes WHERE created_at < NOW() - INTERVAL '1 day' * $1 AND active = false LIMIT $2
  )`,
  promo_redemptions: `DELETE FROM promo_redemptions WHERE ctid IN (
    SELECT ctid FROM promo_redemptions WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  loyalty_rewards: `DELETE FROM loyalty_rewards WHERE ctid IN (
    SELECT ctid FROM loyalty_rewards WHERE created_at < NOW() - INTERVAL '1 day' * $1 AND status = 'credited' LIMIT $2
  )`,
};

interface RetentionPolicy {
  table_name: string;
  retention_days: number;
}

/**
 * Enforce data retention policies by deleting expired records in batches.
 * Returns the total number of records deleted across all tables.
 */
export async function enforceRetentionPolicies(): Promise<number> {
  const result = await query<RetentionPolicy>(
    "SELECT table_name, retention_days FROM data_retention_policies"
  );

  let totalDeleted = 0;

  for (const policy of result.rows) {
    const deleteQuery = TABLE_QUERIES[policy.table_name];
    if (!deleteQuery) {
      log.warn("skipping unknown table in retention policy", { table: policy.table_name });
      continue;
    }

    // L-2: Validate retention_days range
    if (policy.retention_days < 1 || policy.retention_days > 3650) {
      log.warn("skipping invalid retention_days", { table: policy.table_name, days: policy.retention_days });
      continue;
    }

    try {
      // M-4 fix: Delete in batches to prevent long table locks
      let batchDeleted = 0;
      let tableDeleted = 0;
      let iterations = 0;
      const maxIterations = 100; // Safety cap: max 1M rows per table per run

      do {
        const deleteResult = await query(
          deleteQuery,
          [policy.retention_days, DELETE_BATCH_SIZE]
        );

        batchDeleted = deleteResult.rowCount ?? 0;
        tableDeleted += batchDeleted;
        totalDeleted += batchDeleted;
        iterations++;
      } while (batchDeleted >= DELETE_BATCH_SIZE && iterations < maxIterations);

      if (tableDeleted > 0) {
        log.info("retention cleanup", {
          table: policy.table_name,
          retentionDays: policy.retention_days,
          deleted: tableDeleted,
          batches: iterations,
        });
      }
    } catch (err) {
      log.error("retention cleanup failed for table", {
        table: policy.table_name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return totalDeleted;
}
