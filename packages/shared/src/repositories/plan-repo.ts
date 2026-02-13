import { query } from "../db.js";
import type { Plan } from "../types.js";

interface PlanRow {
  id: string;
  name: string;
  price_per_gb_cents: number;
  monthly_bandwidth_bytes: string; // BIGINT comes as string from pg
  is_default: boolean;
  max_connections: number;
}

function rowToPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    pricePerGbCents: row.price_per_gb_cents,
    monthlyBandwidthBytes: Number(row.monthly_bandwidth_bytes),
    isDefault: row.is_default,
    maxConnections: row.max_connections,
  };
}

export async function getPlan(planId: string): Promise<Plan | null> {
  const result = await query<PlanRow>(
    `SELECT * FROM plans WHERE id = $1`,
    [planId],
  );
  const row = result.rows[0];
  return row ? rowToPlan(row) : null;
}

export async function getAllPlans(): Promise<Plan[]> {
  const result = await query<PlanRow>(
    `SELECT * FROM plans ORDER BY price_per_gb_cents DESC, id`,
  );
  return result.rows.map(rowToPlan);
}

export async function getUserPlan(userId: string): Promise<Plan> {
  const result = await query<PlanRow>(
    `SELECT p.*
     FROM plans p
     JOIN users u ON u.plan_id = p.id
     WHERE u.id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    // Fallback to default plan if user or plan not found
    const fallback = await query<PlanRow>(
      `SELECT * FROM plans WHERE is_default = true LIMIT 1`,
    );
    return rowToPlan(fallback.rows[0]);
  }
  return rowToPlan(row);
}

export async function setUserPlan(userId: string, planId: string): Promise<void> {
  // Verify the plan exists
  const planResult = await query<PlanRow>(
    `SELECT * FROM plans WHERE id = $1`,
    [planId],
  );
  if (planResult.rows.length === 0) {
    throw new Error(`Plan '${planId}' not found`);
  }

  const result = await query(
    `UPDATE users SET plan_id = $1 WHERE id = $2`,
    [planId, userId],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`User '${userId}' not found`);
  }
}

export async function getMonthlyUsage(userId: string): Promise<number> {
  // Get total bytes used this calendar month (UTC)
  const result = await query<{ total_bytes: string }>(
    `SELECT COALESCE(SUM(bytes_in + bytes_out), 0) AS total_bytes
     FROM usage_records
     WHERE user_id = $1
       AND created_at >= date_trunc('month', now())`,
    [userId],
  );
  return Number(result.rows[0].total_bytes);
}
