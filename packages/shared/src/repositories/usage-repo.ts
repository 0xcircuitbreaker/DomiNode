import type pg from "pg";
import { query } from "../db.js";
import type { Session, SessionStatus, UsageRecord } from "../types.js";

export async function createSession(
  userId: string,
  proxyIp: string = "",
): Promise<Session> {
  const result = await query<Session>(
    `INSERT INTO sessions (user_id, proxy_ip)
     VALUES ($1, $2)
     RETURNING id, user_id, started_at, ended_at, bytes_total, status`,
    [userId, proxyIp],
  );
  return result.rows[0];
}

export async function endSession(
  sessionId: string,
  bytesTotal: number,
  status: SessionStatus,
): Promise<void> {
  await query(
    `UPDATE sessions
     SET ended_at = now(),
         bytes_total = $1,
         status = $2
     WHERE id = $3`,
    [bytesTotal, status, sessionId],
  );
}

/** endSession inside a caller-owned transaction. */
export async function endSessionTx(
  client: Pick<pg.PoolClient, "query">,
  sessionId: string,
  bytesTotal: number,
  status: SessionStatus,
): Promise<void> {
  await client.query(
    `UPDATE sessions
     SET ended_at = now(),
         bytes_total = $1,
         status = $2
     WHERE id = $3`,
    [bytesTotal, status, sessionId],
  );
}

const MAX_INT = 2_147_483_647;

export async function createUsageRecord(record: {
  user_id: string;
  session_id: string;
  bytes_in: number;
  bytes_out: number;
  cost_cents: number;
  proxy_type: string;
  target_host: string;
  connect_latency_ms?: number | null;
}): Promise<UsageRecord> {
  // Validate numeric fields to prevent negative values or DB overflow
  if (!Number.isInteger(record.bytes_in) || record.bytes_in < 0 || record.bytes_in > MAX_INT) {
    throw new Error("bytes_in must be a non-negative integer within valid range");
  }
  if (!Number.isInteger(record.bytes_out) || record.bytes_out < 0 || record.bytes_out > MAX_INT) {
    throw new Error("bytes_out must be a non-negative integer within valid range");
  }
  if (!Number.isInteger(record.cost_cents) || record.cost_cents < 0 || record.cost_cents > MAX_INT) {
    throw new Error("cost_cents must be a non-negative integer within valid range");
  }
  const result = await query<UsageRecord>(
    `INSERT INTO usage_records (user_id, session_id, bytes_in, bytes_out, cost_cents, proxy_type, target_host, connect_latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, user_id, session_id, bytes_in, bytes_out, cost_cents, proxy_type, target_host, connect_latency_ms, created_at`,
    [
      record.user_id,
      record.session_id,
      record.bytes_in,
      record.bytes_out,
      record.cost_cents,
      record.proxy_type,
      record.target_host,
      record.connect_latency_ms ?? null,
    ],
  );
  return result.rows[0];
}

export async function getUsageByUser(
  userId: string,
  since: Date,
  until: Date,
  limit: number = 200,
  offset: number = 0,
): Promise<{ rows: UsageRecord[]; total: number }> {
  // Enforce bounds at the repository layer to prevent DoS from any caller
  limit = Math.max(1, Math.min(1000, limit));
  offset = Math.max(0, offset);
  const [dataResult, countResult] = await Promise.all([
    query<UsageRecord>(
      `SELECT id, user_id, session_id, bytes_in, bytes_out, cost_cents, proxy_type, target_host, connect_latency_ms, created_at FROM usage_records
       WHERE user_id = $1
         AND created_at >= $2
         AND created_at <= $3
       ORDER BY created_at DESC
       LIMIT $4 OFFSET $5`,
      [userId, since, until, limit, offset],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM usage_records
       WHERE user_id = $1
         AND created_at >= $2
         AND created_at <= $3`,
      [userId, since, until],
    ),
  ]);
  return {
    rows: dataResult.rows,
    total: Number(countResult.rows[0].count),
  };
}

export interface DailyUsage {
  date: string;
  total_bytes: number;
  total_cost_cents: number;
  request_count: number;
}

export async function getUsageByDay(
  userId: string,
  since: Date,
  until: Date,
): Promise<DailyUsage[]> {
  const result = await query<{
    date: string;
    total_bytes: string;
    total_cost_cents: string;
    request_count: string;
  }>(
    `SELECT
       DATE(created_at) AS date,
       COALESCE(SUM(bytes_in + bytes_out), 0) AS total_bytes,
       COALESCE(SUM(cost_cents), 0) AS total_cost_cents,
       COUNT(*) AS request_count
     FROM usage_records
     WHERE user_id = $1
       AND created_at >= $2
       AND created_at <= $3
     GROUP BY DATE(created_at)
     ORDER BY date ASC`,
    [userId, since, until],
  );

  return result.rows.map((row) => ({
    date: row.date,
    total_bytes: Number(row.total_bytes),
    total_cost_cents: Number(row.total_cost_cents),
    request_count: Number(row.request_count),
  }));
}

export interface UsageSummary {
  total_bytes: number;
  total_cost_cents: number;
  request_count: number;
}

export async function getActiveSessions(
  userId: string,
): Promise<
  Array<{
    id: string;
    startedAt: Date;
    status: string;
  }>
> {
  const result = await query<{
    id: string;
    started_at: Date;
    status: string;
  }>(
    `SELECT id, started_at, status
     FROM sessions
     WHERE user_id = $1
       AND status = 'active'
     ORDER BY started_at DESC
     LIMIT 50`,
    [userId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    startedAt: row.started_at,
    status: row.status,
  }));
}

export async function getTopHosts(
  userId: string,
  since: Date,
  until: Date,
  limit: number = 10,
): Promise<
  Array<{
    targetHost: string;
    totalBytes: number;
    requestCount: number;
  }>
> {
  // Enforce bounds at the repository layer
  limit = Math.max(1, Math.min(100, limit));
  const result = await query<{
    target_host: string;
    total_bytes: string;
    request_count: string;
  }>(
    `SELECT target_host,
            SUM(bytes_in + bytes_out) AS total_bytes,
            COUNT(*) AS request_count
     FROM usage_records
     WHERE user_id = $1
       AND created_at >= $2
       AND created_at < $3
       AND target_host != ''
     GROUP BY target_host
     ORDER BY total_bytes DESC
     LIMIT $4`,
    [userId, since, until, limit],
  );

  return result.rows.map((row) => ({
    targetHost: row.target_host,
    totalBytes: Number(row.total_bytes),
    requestCount: Number(row.request_count),
  }));
}

/**
 * Mark orphaned 'active' sessions as 'error' on startup.
 * After a crash, in-memory sessions are lost but DB sessions remain 'active'.
 */
export async function cleanupOrphanedSessions(): Promise<number> {
  const result = await query(
    `UPDATE sessions
     SET status = 'error',
         ended_at = now()
     WHERE status = 'active'`,
  );
  return result.rowCount ?? 0;
}

export async function getUsageSummary(
  userId: string,
  since: Date,
): Promise<UsageSummary> {
  const result = await query<{
    total_bytes: string;
    total_cost_cents: string;
    request_count: string;
  }>(
    `SELECT
       COALESCE(SUM(bytes_in + bytes_out), 0) AS total_bytes,
       COALESCE(SUM(cost_cents), 0) AS total_cost_cents,
       COUNT(*) AS request_count
     FROM usage_records
     WHERE user_id = $1
       AND created_at >= $2`,
    [userId, since],
  );

  const row = result.rows[0];
  return {
    total_bytes: Number(row.total_bytes),
    total_cost_cents: Number(row.total_cost_cents),
    request_count: Number(row.request_count),
  };
}

/**
 * Insert a usage record inside a caller-owned transaction (no RETURNING).
 * Same validation as createUsageRecord.
 */
export async function createUsageRecordTx(
  client: Pick<pg.PoolClient, "query">,
  record: {
    user_id: string;
    session_id: string;
    bytes_in: number;
    bytes_out: number;
    cost_cents: number;
    proxy_type: string;
    target_host: string;
    connect_latency_ms?: number | null;
  },
): Promise<void> {
  for (const [k, v] of [
    ["bytes_in", record.bytes_in],
    ["bytes_out", record.bytes_out],
    ["cost_cents", record.cost_cents],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > MAX_INT) {
      throw new Error(`${k} must be a non-negative integer within valid range`);
    }
  }
  await client.query(
    `INSERT INTO usage_records (user_id, session_id, bytes_in, bytes_out, cost_cents, proxy_type, target_host, connect_latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      record.user_id,
      record.session_id,
      record.bytes_in,
      record.bytes_out,
      record.cost_cents,
      record.proxy_type,
      record.target_host,
      record.connect_latency_ms ?? null,
    ],
  );
}
