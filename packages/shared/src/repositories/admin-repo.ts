import { query } from "../db.js";
import type {
  AdminUserView,
  AdminUserDetail,
  RevenueStats,
  DailyRevenue,
  SystemStats,
} from "../types.js";

// ─── User Management ────────────────────────────────────────────────

export async function listUsers(
  page: number,
  limit: number,
): Promise<{ users: AdminUserView[]; total: number }> {
  const offset = (page - 1) * limit;

  const [dataResult, countResult] = await Promise.all([
    query<{
      id: string;
      email: string;
      status: string;
      plan_id: string;
      balance_cents: string | null;
      created_at: Date;
      is_admin: boolean;
    }>(
      `SELECT u.id, u.email, u.status, u.plan_id,
              w.balance_cents, u.created_at, u.is_admin
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       ORDER BY u.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM users`,
    ),
  ]);

  return {
    users: dataResult.rows.map((row) => ({
      id: row.id,
      email: row.email,
      status: row.status,
      planId: row.plan_id ?? "payg",
      balanceCents: Number(row.balance_cents ?? 0),
      createdAt: row.created_at,
      isAdmin: row.is_admin ?? false,
    })),
    total: Number(countResult.rows[0].count),
  };
}

export async function getUserDetails(
  userId: string,
): Promise<AdminUserDetail | null> {
  const result = await query<{
    id: string;
    email: string;
    status: string;
    plan_id: string;
    balance_cents: string | null;
    created_at: Date;
    is_admin: boolean;
    api_key_count: string;
    total_usage_bytes: string;
    total_spent_cents: string;
    last_active: Date | null;
  }>(
    `SELECT u.id, u.email, u.status, u.plan_id,
            w.balance_cents, u.created_at, u.is_admin,
            (SELECT COUNT(*) FROM api_keys WHERE user_id = u.id AND revoked_at IS NULL) AS api_key_count,
            COALESCE((SELECT SUM(bytes_in + bytes_out) FROM usage_records WHERE user_id = u.id), 0) AS total_usage_bytes,
            COALESCE((SELECT SUM(cost_cents) FROM usage_records WHERE user_id = u.id), 0) AS total_spent_cents,
            (SELECT MAX(created_at) FROM usage_records WHERE user_id = u.id) AS last_active
     FROM users u
     LEFT JOIN wallets w ON w.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    email: row.email,
    status: row.status,
    planId: row.plan_id ?? "payg",
    balanceCents: Number(row.balance_cents ?? 0),
    createdAt: row.created_at,
    isAdmin: row.is_admin ?? false,
    apiKeyCount: Number(row.api_key_count),
    totalUsageBytes: Number(row.total_usage_bytes),
    totalSpentCents: Number(row.total_spent_cents),
    lastActive: row.last_active,
  };
}

export async function suspendUser(userId: string): Promise<void> {
  await query(
    `UPDATE users SET status = 'suspended' WHERE id = $1 AND status = 'active'`,
    [userId],
  );
}

export async function reactivateUser(userId: string): Promise<void> {
  await query(
    `UPDATE users SET status = 'active' WHERE id = $1 AND status = 'suspended'`,
    [userId],
  );
}

export async function deleteUser(userId: string): Promise<void> {
  // Soft-delete: set status to 'deleted', don't actually remove rows
  await query(
    `UPDATE users SET status = 'deleted' WHERE id = $1`,
    [userId],
  );
}

// ─── Revenue Analytics ──────────────────────────────────────────────

export async function getRevenueStats(
  since: Date,
  until: Date,
): Promise<RevenueStats> {
  const result = await query<{
    total_revenue_cents: string;
    total_transactions: string;
    avg_transaction_cents: string;
    topup_count: string;
    unique_paying_users: string;
  }>(
    `SELECT
       COALESCE(SUM(wt.amount_cents), 0) AS total_revenue_cents,
       COUNT(*) AS total_transactions,
       COALESCE(AVG(wt.amount_cents), 0) AS avg_transaction_cents,
       COUNT(*) FILTER (WHERE wt.type = 'topup') AS topup_count,
       COUNT(DISTINCT w.user_id) FILTER (WHERE wt.type = 'topup') AS unique_paying_users
     FROM wallet_transactions wt
     JOIN wallets w ON w.id = wt.wallet_id
     WHERE wt.type = 'topup'
       AND wt.created_at >= $1
       AND wt.created_at <= $2`,
    [since, until],
  );

  const row = result.rows[0];
  return {
    totalRevenueCents: Number(row.total_revenue_cents),
    totalTransactions: Number(row.total_transactions),
    avgTransactionCents: Math.round(Number(row.avg_transaction_cents)),
    topUpCount: Number(row.topup_count),
    uniquePayingUsers: Number(row.unique_paying_users),
  };
}

export async function getDailyRevenue(
  since: Date,
  until: Date,
): Promise<DailyRevenue[]> {
  const result = await query<{
    date: string;
    revenue_cents: string;
    transaction_count: string;
  }>(
    `SELECT
       DATE(wt.created_at) AS date,
       COALESCE(SUM(wt.amount_cents), 0) AS revenue_cents,
       COUNT(*) AS transaction_count
     FROM wallet_transactions wt
     WHERE wt.type = 'topup'
       AND wt.created_at >= $1
       AND wt.created_at <= $2
     GROUP BY DATE(wt.created_at)
     ORDER BY date ASC`,
    [since, until],
  );

  return result.rows.map((row) => ({
    date: row.date,
    revenueCents: Number(row.revenue_cents),
    transactionCount: Number(row.transaction_count),
  }));
}

// ─── System Stats ───────────────────────────────────────────────────

export async function getSystemStats(): Promise<SystemStats> {
  const result = await query<{
    total_users: string;
    active_users: string;
    suspended_users: string;
    total_api_keys: string;
    active_api_keys: string;
    total_sessions: string;
    active_sessions: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM users) AS total_users,
       (SELECT COUNT(*) FROM users WHERE status = 'active') AS active_users,
       (SELECT COUNT(*) FROM users WHERE status = 'suspended') AS suspended_users,
       (SELECT COUNT(*) FROM api_keys) AS total_api_keys,
       (SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL) AS active_api_keys,
       (SELECT COUNT(*) FROM sessions) AS total_sessions,
       (SELECT COUNT(*) FROM sessions WHERE status = 'active') AS active_sessions`,
  );

  const row = result.rows[0];
  return {
    totalUsers: Number(row.total_users),
    activeUsers: Number(row.active_users),
    suspendedUsers: Number(row.suspended_users),
    totalApiKeys: Number(row.total_api_keys),
    activeApiKeys: Number(row.active_api_keys),
    totalSessions: Number(row.total_sessions),
    activeSessions: Number(row.active_sessions),
  };
}
