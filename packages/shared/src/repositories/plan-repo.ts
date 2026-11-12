import type { DbTxClient } from "../db.js";
import { query, getPool } from "../db.js";
import type { Plan } from "../types.js";

interface PlanRow {
  id: string;
  name: string;
  price_per_gb_cents: number;
  monthly_bandwidth_bytes: string; // BIGINT comes as string from pg
  is_default: boolean;
  max_connections: number;
  max_sessions_per_minute: number;
  allowed_proxy_types: string | null;
}

function rowToPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    pricePerGbCents: row.price_per_gb_cents,
    monthlyBandwidthBytes: Number(row.monthly_bandwidth_bytes),
    isDefault: row.is_default,
    maxConnections: row.max_connections,
    maxSessionsPerMinute: row.max_sessions_per_minute ?? 30,
    allowedProxyTypes: row.allowed_proxy_types ?? null,
  };
}

export async function getPlan(planId: string): Promise<Plan | null> {
  const result = await query<PlanRow>(
    `SELECT id, name, price_per_gb_cents, monthly_bandwidth_bytes, is_default, max_connections, max_sessions_per_minute, allowed_proxy_types FROM plans WHERE id = $1`,
    [planId],
  );
  const row = result.rows[0];
  return row ? rowToPlan(row) : null;
}

export async function getAllPlans(): Promise<Plan[]> {
  const result = await query<PlanRow>(
    `SELECT id, name, price_per_gb_cents, monthly_bandwidth_bytes, is_default, max_connections, max_sessions_per_minute, allowed_proxy_types FROM plans ORDER BY price_per_gb_cents DESC, id`,
  );
  return result.rows.map(rowToPlan);
}

export async function getUserPlan(userId: string): Promise<Plan> {
  const result = await query<PlanRow>(
    `SELECT p.id, p.name, p.price_per_gb_cents, p.monthly_bandwidth_bytes, p.is_default, p.max_connections, p.max_sessions_per_minute, p.allowed_proxy_types
     FROM plans p
     JOIN users u ON u.plan_id = p.id
     WHERE u.id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    // Throw explicitly instead of silently falling back to free tier.
    // Silent fallback could grant free access to deleted/suspended users.
    throw new Error(`No plan found for user ${userId}`);
  }
  return rowToPlan(row);
}

// Wrap setUserPlan in a transaction with FOR SHARE on plan lookup
export async function setUserPlan(userId: string, planId: string, ext?: DbTxClient): Promise<void> {
  const own = !ext;
  const client = ext ?? await getPool().connect();
  try {
    if (own) await client.query("BEGIN");

    // Verify the plan exists (FOR SHARE prevents concurrent deletion)
    const planResult = await client.query<PlanRow>(
      `SELECT id, name, price_per_gb_cents, monthly_bandwidth_bytes, is_default, max_connections, max_sessions_per_minute, allowed_proxy_types FROM plans WHERE id = $1 FOR SHARE`,
      [planId],
    );
    if (planResult.rows.length === 0) {
      throw new Error(`Plan '${planId}' not found`);
    }

    const result = await client.query(
      `UPDATE users SET plan_id = $1 WHERE id = $2`,
      [planId, userId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`User '${userId}' not found`);
    }

    if (own) await client.query("COMMIT");
  } catch (err) {
    if (own) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (own) client.release();
  }
}

export async function getTeamPlan(teamId: string): Promise<Plan> {
  const result = await query<PlanRow>(
    `SELECT p.id, p.name, p.price_per_gb_cents, p.monthly_bandwidth_bytes, p.is_default, p.max_connections, p.max_sessions_per_minute, p.allowed_proxy_types
     FROM plans p
     JOIN teams t ON t.plan_id = p.id
     WHERE t.id = $1 AND t.status = 'active'`,
    [teamId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`No plan found for team ${teamId}`);
  }
  return rowToPlan(row);
}

export async function getMonthlyUsage(userId: string): Promise<number> {
  // Get total bytes used this calendar month (UTC)
  const result = await query<{ total_bytes: string }>(
    `SELECT COALESCE(SUM(bytes_in + bytes_out), 0) AS total_bytes
     FROM usage_records
     WHERE user_id = $1
       AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')`,
    [userId],
  );
  return Number(result.rows[0].total_bytes);
}
