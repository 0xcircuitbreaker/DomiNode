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
  // Public abuse reports: only closed reports age out.
  abuse_reports: `DELETE FROM abuse_reports WHERE ctid IN (
    SELECT ctid FROM abuse_reports WHERE created_at < NOW() - INTERVAL '1 day' * $1 AND status IN ('actioned', 'dismissed') LIMIT $2
  )`,
  loyalty_rewards: `DELETE FROM loyalty_rewards WHERE ctid IN (
    SELECT ctid FROM loyalty_rewards WHERE created_at < NOW() - INTERVAL '1 day' * $1 AND status = 'credited' LIMIT $2
  )`,
  // Short-lived challenges. pow_challenges holds the caller's IP (abuse-report
  // and node-registration PoW), so it must actually age out.
  pow_challenges: `DELETE FROM pow_challenges WHERE ctid IN (
    SELECT ctid FROM pow_challenges WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  node_challenges: `DELETE FROM node_challenges WHERE ctid IN (
    SELECT ctid FROM node_challenges WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  agent_sign_challenges: `DELETE FROM agent_sign_challenges WHERE ctid IN (
    SELECT ctid FROM agent_sign_challenges WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
  waitlist: `DELETE FROM waitlist WHERE ctid IN (
    SELECT ctid FROM waitlist WHERE created_at < NOW() - INTERVAL '1 day' * $1 LIMIT $2
  )`,
};

/**
 * Policy rows that are deliberately not purged by age here. They are live
 * records (kept while the account exists and removed by erasure), or are
 * purged by a dedicated job: relay_abuse_log uses policy.logRetentionDays
 * (purgeRelayAbuseLogBatch).
 */
export const RETENTION_EXEMPT_TABLES: ReadonlySet<string> = new Set([
  "team_wallets",
  "team_members",
  "agent_secrets",
  "relay_abuse_log",
]);

/** Tables enforceRetentionPolicies can purge by age. */
export const RETENTION_PURGEABLE_TABLES: ReadonlySet<string> = new Set(Object.keys(TABLE_QUERIES));

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
      if (RETENTION_EXEMPT_TABLES.has(policy.table_name)) continue;
      log.error("skipping unknown table in retention policy", { table: policy.table_name });
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

// ─── Relay abuse-log retention (DESIGN.md §6.4, policy.logRetentionDays) ──

export const ABUSE_LOG_BATCH = 1000;

/**
 * Delete one batch (≤1000 rows) of relay_abuse_log rows older than `days`.
 * Returns the number of rows deleted; callers loop until it is < batch.
 */
export async function purgeRelayAbuseLogBatch(days: number, batch = ABUSE_LOG_BATCH): Promise<number> {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("days out of range");
  const lim = Number.isInteger(batch) && batch > 0 && batch <= ABUSE_LOG_BATCH ? batch : ABUSE_LOG_BATCH;
  const r = await query(
    `DELETE FROM relay_abuse_log WHERE id IN (
       SELECT id FROM relay_abuse_log WHERE ts < now() - INTERVAL '1 day' * $1 ORDER BY id LIMIT $2
     )`,
    [days, lim],
  );
  return r.rowCount ?? 0;
}

/**
 * Admin audit rows of abuse-log lookups (relay_abuse_log_access) name a
 * requester id and destination host. Once the abuse log itself is past
 * retention, keep the accountability record (who looked, when) but drop the
 * requester/node/host it pointed at. One batch (<=1000 rows) per call.
 */
export async function scrubAbuseLogAccessAuditBatch(days: number, batch = ABUSE_LOG_BATCH): Promise<number> {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("days out of range");
  const lim = Number.isInteger(batch) && batch > 0 && batch <= ABUSE_LOG_BATCH ? batch : ABUSE_LOG_BATCH;
  const r = await query(
    `UPDATE audit_events SET resource_id = 'REDACTED',
            details = (details - 'requesterId' - 'host' - 'nodeId') || '{"scrubbed":true}'::jsonb
      WHERE id IN (
        SELECT id FROM audit_events
         WHERE action = 'relay_abuse_log_access' AND created_at < now() - INTERVAL '1 day' * $1
           AND NOT (COALESCE(details, '{}'::jsonb) ? 'scrubbed')
         LIMIT $2
      )`,
    [days, lim],
  );
  return r.rowCount ?? 0;
}
