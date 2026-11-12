import type { DbTxClient } from "../db.js";
import { query, queryOn } from "../db.js";

export interface WaitlistEntry {
  id: string;
  email: string;
  status: "pending" | "notified" | "registered" | "cancelled";
  notified_at: Date | null;
  created_at: Date;
}

/** Add an email to the waitlist. Returns the entry (without ip_address). */
export async function addToWaitlist(
  email: string,
  ipAddress: string,
): Promise<WaitlistEntry> {
  const result = await query<WaitlistEntry>(
    `INSERT INTO waitlist (email, ip_address)
     VALUES ($1, $2)
     RETURNING id, email, status, notified_at, created_at`,
    [email, ipAddress],
  );
  return result.rows[0];
}

/** Find a waitlist entry by email. */
export async function findByEmail(email: string): Promise<WaitlistEntry | null> {
  const result = await query<WaitlistEntry>(
    `SELECT id, email, status, notified_at, created_at FROM waitlist WHERE email = $1`,
    [email],
  );
  return result.rows[0] ?? null;
}

/** Find a waitlist entry by ID. */
export async function findById(id: string): Promise<WaitlistEntry | null> {
  const result = await query<WaitlistEntry>(
    `SELECT id, email, status, notified_at, created_at FROM waitlist WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Count pending waitlist entries. */
export async function countPending(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM waitlist WHERE status = 'pending'`,
  );
  return parseInt(result.rows[0].count, 10);
}

/** Paginated list of waitlist entries with optional status filter. */
export async function listWaitlist(
  page: number,
  limit: number,
  statusFilter?: string,
): Promise<{ entries: WaitlistEntry[]; total: number }> {
  const conditions = statusFilter ? `WHERE status = $3` : ``;
  const params: unknown[] = [(page - 1) * limit, limit];
  if (statusFilter) params.push(statusFilter);

  const countSql = statusFilter
    ? `SELECT COUNT(*) AS count FROM waitlist WHERE status = $1`
    : `SELECT COUNT(*) AS count FROM waitlist`;
  const countParams = statusFilter ? [statusFilter] : [];
  const countResult = await query<{ count: string }>(countSql, countParams);
  const total = parseInt(countResult.rows[0].count, 10);

  const listSql = `SELECT id, email, status, notified_at, created_at
    FROM waitlist ${conditions}
    ORDER BY created_at ASC
    OFFSET $1 LIMIT $2`;
  const listResult = await query<WaitlistEntry>(listSql, params);

  return { entries: listResult.rows, total };
}

/** Mark a waitlist entry as notified. */
export async function markNotified(id: string, ext?: DbTxClient): Promise<boolean> {
  const result = await queryOn(ext,
    `UPDATE waitlist SET status = 'notified', notified_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Mark a waitlist entry as registered (by email, for post-registration hook). */
export async function markRegistered(email: string): Promise<boolean> {
  const result = await query(
    `UPDATE waitlist SET status = 'registered'
     WHERE email = $1 AND status IN ('pending', 'notified')`,
    [email],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Cancel a waitlist entry. */
export async function cancelEntry(id: string, ext?: DbTxClient): Promise<boolean> {
  const result = await queryOn(ext,
    `UPDATE waitlist SET status = 'cancelled'
     WHERE id = $1 AND status IN ('pending', 'notified')`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Bulk-notify multiple waitlist entries by IDs. Returns number updated. */
export async function bulkNotify(ids: string[], ext?: DbTxClient): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await queryOn(ext,
    `UPDATE waitlist SET status = 'notified', notified_at = now()
     WHERE id = ANY($1) AND status = 'pending'`,
    [ids],
  );
  return result.rowCount ?? 0;
}

/** Get oldest pending entries (for bulk approval). */
export async function getPendingEmails(limit: number): Promise<WaitlistEntry[]> {
  const result = await query<WaitlistEntry>(
    `SELECT id, email, status, notified_at, created_at
     FROM waitlist WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}
