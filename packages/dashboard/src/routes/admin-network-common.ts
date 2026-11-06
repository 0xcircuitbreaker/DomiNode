/**
 * Shared helpers for the /api/admin/network routers (ADMIN_API.md).
 */
import type { Request, Response } from "express";
import { createLogger, getPool, hasMinRole, PolicyValidationError } from "@dominusnode/shared";
import type { AdminRole } from "@dominusnode/shared";
import type { AuthenticatedRequest } from "../middleware/auth.js";

const log = createLogger("api:admin-network");

export interface TxClient {
  query<R>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function adminId(req: Request): string {
  return (req as unknown as AuthenticatedRequest).user.userId;
}

/** Run fn in a transaction after re-checking the caller's admin role FOR UPDATE. */
export async function withAdminTx<T>(userId: string, fn: (c: TxClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<{ admin_role: AdminRole | null }>(
      `SELECT admin_role FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`,
      [userId],
    );
    if (!r.rows[0] || !hasMinRole(r.rows[0].admin_role ?? "none", "admin")) {
      throw new HttpError(403, "Admin access required");
    }
    const out = await fn(client as unknown as TxClient);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function fail(res: Response, err: unknown, what: string): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof PolicyValidationError) {
    res.status(400).json({ error: "Invalid policy", details: err.errors.slice(0, 50) });
    return;
  }
  log.error(`${what} failed`, { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ error: `${what} failed` });
}

/** Insert an audit_events row inside the caller's admin transaction. */
export async function audit(
  c: TxClient, req: Request, action: string, resource: string, resourceId: string, details: Record<string, unknown>,
): Promise<void> {
  await c.query(
    `INSERT INTO audit_events (user_id, action, resource, resource_id, ip_address, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [adminId(req), action, resource, resourceId, (req.ip ?? "").slice(0, 64) || null, JSON.stringify(details)],
  );
}

// ─── Money ──────────────────────────────────────────────────────────

export interface Money { musd: string; usd: string }

/** µUSD (bigint/number/decimal string/null) → { musd, usd } with 6 decimal places. */
export function money(v: unknown): Money {
  let b: bigint;
  try {
    b = v === null || v === undefined ? 0n : BigInt(typeof v === "number" ? Math.trunc(v) : String(v));
  } catch {
    b = 0n;
  }
  const neg = b < 0n;
  const a = neg ? -b : b;
  const usd = `${neg ? "-" : ""}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")}`;
  return { musd: b.toString(), usd };
}

/** Bytes (bigint-ish) → GB (1e9) decimal string with 6 places. */
export function gb(v: unknown): string {
  let b: bigint;
  try { b = v === null || v === undefined ? 0n : BigInt(String(v)); } catch { b = 0n; }
  return `${b / 1_000_000_000n}.${((b % 1_000_000_000n) / 1000n).toString().padStart(6, "0")}`;
}

export function bigStr(v: unknown): string {
  try { return v === null || v === undefined ? "0" : BigInt(String(v)).toString(); } catch { return "0"; }
}

// ─── Query parsing ──────────────────────────────────────────────────

export const MAX_LIMIT = 200;
export const MAX_OFFSET = 100_000;

export function str(q: unknown): string | undefined {
  return typeof q === "string" && q.length > 0 ? q : undefined;
}

export function page(req: Request, def = 50): { limit: number; offset: number } {
  const l = str(req.query["limit"]);
  const o = str(req.query["offset"]);
  const limit = l === undefined ? def : Number(l);
  const offset = o === undefined ? 0 : Number(o);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new HttpError(400, `limit must be an integer in [1, ${MAX_LIMIT}]`);
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) throw new HttpError(400, `offset must be an integer in [0, ${MAX_OFFSET}]`);
  return { limit, offset };
}

export function enumParam<T extends string>(req: Request, name: string, allowed: readonly T[]): T | undefined {
  const v = str(req.query[name]);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw new HttpError(400, `${name} must be one of ${allowed.join("|")}`);
  return v as T;
}

export function uuidParam(req: Request, name: string): string | undefined {
  const v = str(req.query[name]);
  if (v === undefined) return undefined;
  if (!UUID_RE.test(v)) throw new HttpError(400, `${name} must be a UUID`);
  return v.toLowerCase();
}

export function uuidPath(req: Request, name = "id"): string {
  const v = String(req.params[name] ?? "");
  if (!UUID_RE.test(v)) throw new HttpError(400, `Invalid ${name}`);
  return v.toLowerCase();
}

export function boolParam(req: Request, name: string): boolean | undefined {
  const v = str(req.query[name]);
  if (v === undefined) return undefined;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new HttpError(400, `${name} must be true|false`);
}

export function countryParam(req: Request, name = "country"): string | undefined {
  const v = str(req.query[name]);
  if (v === undefined) return undefined;
  const u = v.toUpperCase();
  if (!/^[A-Z]{2}$/.test(u)) throw new HttpError(400, `${name} must be an ISO 3166-1 alpha-2 code`);
  return u;
}

export function intParam(req: Request, name: string, min: number, max: number): number | undefined {
  const v = str(req.query[name]);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be an integer in [${min}, ${max}]`);
  return n;
}

export function dateParam(req: Request, name: string): Date | undefined {
  const v = str(req.query[name]);
  if (v === undefined) return undefined;
  if (v.length > 40) throw new HttpError(400, `${name} must be an ISO timestamp`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${name} must be an ISO timestamp`);
  return d;
}

export type Period = "24h" | "7d" | "30d" | "90d" | "all";
export const PERIODS: readonly Period[] = ["24h", "7d", "30d", "90d", "all"];
const PERIOD_MS: Record<Exclude<Period, "all">, number> = {
  "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000,
};
/** Start of a period (null for "all"). Default 30d. */
export function periodStart(req: Request): { period: Period; since: Date | null } {
  const period = enumParam(req, "period", PERIODS) ?? "30d";
  return { period, since: period === "all" ? null : new Date(Date.now() - PERIOD_MS[period]) };
}

/** Escape LIKE metacharacters for a user-supplied search term. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function searchParam(req: Request, name = "search", max = 100): string | undefined {
  const v = str(req.query[name]);
  if (v === undefined) return undefined;
  if (v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new HttpError(400, `${name} must be at most ${max} printable chars`);
  return v;
}
