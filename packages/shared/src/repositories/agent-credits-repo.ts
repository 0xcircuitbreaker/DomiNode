import { query } from "../db.js";
import { withTx } from "./node-credit-repo.js";

/** Agent self-service reads/writes behind /v1 (docs/agent-network/AGENT_API.md). */

const HEX64 = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SIGN_CHALLENGE_TTL_MS = 10 * 60_000;
export const MAX_OUTSTANDING_SIGN_CHALLENGES = 10;
export const MAX_REPORTS_PER_NODE_PER_DAY = 5;
export const REPORT_WINDOW_DAYS = 7;

export type SignAction = "payout_wallet_set" | "withdraw";
export const REPORT_REASONS = ["blocked", "captcha", "rate_limited", "slow", "bad_content", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

// ─── Signing challenges ──────────────────────────────────────────────

/**
 * Store a single-use challenge (sha256(nonce) + the exact message to sign).
 * Returns null when the user already has too many outstanding challenges.
 */
export async function createSignChallenge(
  userId: string, action: SignAction, nonceHash: string, message: string,
): Promise<{ expiresAt: Date } | null> {
  if (!HEX64.test(nonceHash)) throw new Error("Invalid nonce hash");
  if (typeof message !== "string" || message.length < 1 || message.length > 2000) throw new Error("Invalid message");
  return withTx(async (client) => {
    // Serialize per user so the outstanding-count check cannot be raced.
    await client.query(`SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`, [userId]);
    await client.query(`DELETE FROM agent_sign_challenges WHERE user_id = $1 AND expires_at <= now()`, [userId]);
    const c = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM agent_sign_challenges WHERE user_id = $1`, [userId],
    );
    if (Number(c.rows[0]?.n ?? "0") >= MAX_OUTSTANDING_SIGN_CHALLENGES) return null;
    const r = await client.query<{ expires_at: Date }>(
      `INSERT INTO agent_sign_challenges (nonce_hash, user_id, action, message, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
       RETURNING expires_at`,
      [nonceHash, userId, action, message, SIGN_CHALLENGE_TTL_MS / 1000],
    );
    return { expiresAt: r.rows[0].expires_at };
  });
}

/** Atomically consume a challenge (DELETE ... RETURNING). Returns the stored message or null. */
export async function consumeSignChallenge(
  userId: string, action: SignAction, nonceHash: string,
): Promise<string | null> {
  if (!HEX64.test(nonceHash)) return null;
  const r = await query<{ message: string }>(
    `DELETE FROM agent_sign_challenges
     WHERE nonce_hash = $1 AND user_id = $2 AND action = $3 AND expires_at > now()
     RETURNING message`,
    [nonceHash, userId, action],
  );
  return r.rows[0]?.message ?? null;
}

// ─── Credits ─────────────────────────────────────────────────────────

export interface CreditSummary {
  pendingMusd: bigint;
  availableMusd: bigint;
  frozen: boolean;
  autoConvertPct: number;
  taxFormStatus: "not_required" | "requested" | "received" | "rejected";
  ytdPaidMusd: bigint;
}

/** The caller's credit account (zeros when no account exists yet). */
export async function getCreditSummary(userId: string): Promise<CreditSummary> {
  const r = await query<{
    pending_musd: string; available_musd: string; frozen: boolean; auto_convert_pct: number;
    tax_form_status: CreditSummary["taxFormStatus"]; ytd_paid_musd: string; tax_year: number | null; cur_year: number;
  }>(
    `SELECT pending_musd, available_musd, frozen, auto_convert_pct, tax_form_status, ytd_paid_musd, tax_year,
            EXTRACT(YEAR FROM now())::int AS cur_year
     FROM node_credit_accounts WHERE user_id = $1`,
    [userId],
  );
  const a = r.rows[0];
  if (!a) {
    return { pendingMusd: 0n, availableMusd: 0n, frozen: false, autoConvertPct: 0, taxFormStatus: "not_required", ytdPaidMusd: 0n };
  }
  return {
    pendingMusd: BigInt(a.pending_musd),
    availableMusd: BigInt(a.available_musd),
    frozen: a.frozen,
    autoConvertPct: a.auto_convert_pct,
    taxFormStatus: a.tax_form_status,
    ytdPaidMusd: a.tax_year === a.cur_year ? BigInt(a.ytd_paid_musd) : 0n,
  };
}

export type LedgerType = "earn" | "mature" | "clawback" | "convert_to_wallet" | "withdraw" | "withdraw_reversal";
const LEDGER_TYPES = new Set<LedgerType>(["earn", "mature", "clawback", "convert_to_wallet", "withdraw", "withdraw_reversal"]);

export interface LedgerEntry {
  id: bigint;
  type: LedgerType;
  amountMusd: bigint;
  relayChargeId: string | null;
  externalRef: string | null;
  createdAt: Date;
}

/** Newest-first ledger page. `before` is the id cursor from the previous page. */
export async function listTransactions(
  userId: string, opts: { limit: number; before?: bigint; type?: LedgerType },
): Promise<LedgerEntry[]> {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 && opts.limit <= 200 ? opts.limit : 50;
  if (opts.type !== undefined && !LEDGER_TYPES.has(opts.type)) throw new Error("Invalid type");
  const r = await query<{ id: string; type: LedgerType; amount_musd: string; relay_charge_id: string | null; external_ref: string | null; created_at: Date }>(
    `SELECT id, type, amount_musd, relay_charge_id, external_ref, created_at
     FROM node_credit_transactions
     WHERE user_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint) AND ($3::text IS NULL OR type = $3::text)
     ORDER BY id DESC LIMIT $4`,
    [userId, opts.before !== undefined ? opts.before.toString() : null, opts.type ?? null, limit],
  );
  return r.rows.map((x) => ({
    id: BigInt(x.id), type: x.type, amountMusd: BigInt(x.amount_musd), relayChargeId: x.relay_charge_id,
    externalRef: x.external_ref, createdAt: x.created_at,
  }));
}

export interface OwnPayout {
  id: string;
  amountMusd: bigint;
  trigger: "auto" | "on_demand";
  status: string;
  txHash: string | null;
  failureReason: string | null;
  address: string | null;
  chain: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The caller's payouts, newest first. */
export async function listOwnPayouts(userId: string, opts: { limit: number; offset: number }): Promise<OwnPayout[]> {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 && opts.limit <= 200 ? opts.limit : 50;
  const offset = Number.isInteger(opts.offset) && opts.offset >= 0 && opts.offset <= 1_000_000 ? opts.offset : 0;
  const r = await query<{
    id: string; amount_musd: string; trigger: "auto" | "on_demand"; status: string; tx_hash: string | null;
    failure_reason: string | null; address: string | null; chain: string | null; created_at: Date; updated_at: Date;
  }>(
    `SELECT p.id, p.amount_musd, p.trigger, p.status, p.tx_hash, p.failure_reason, w.address, w.chain,
            p.created_at, p.updated_at
     FROM node_payouts p LEFT JOIN payout_wallets w ON w.id = p.payout_wallet_id
     WHERE p.user_id = $1
     ORDER BY p.created_at DESC, p.id DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return r.rows.map((x) => ({
    id: x.id, amountMusd: BigInt(x.amount_musd), trigger: x.trigger, status: x.status, txHash: x.tx_hash,
    failureReason: x.failure_reason, address: x.address, chain: x.chain, createdAt: x.created_at, updatedAt: x.updated_at,
  }));
}

// ─── Node caps ───────────────────────────────────────────────────────

export interface NodeCaps { maxStreams: number; maxGbDay: number; maxReqPerSec: number | null }

/**
 * Set owner caps on an owned, non-revoked node. Ownership and update are one
 * statement (no TOCTOU). The caller has already bounded values to policy
 * defaults. Returns null when the node is not the caller's.
 */
export async function updateNodeCaps(
  userId: string, nodeId: string, caps: { maxStreams?: number; maxGbDay?: number; maxReqPerSec?: number },
): Promise<(NodeCaps & { id: string; status: string }) | null> {
  if (!UUID_RE.test(nodeId)) return null;
  const r = await query<{ id: string; status: string; max_streams: number; max_gb_day: number; max_req_per_sec: number | null }>(
    `UPDATE nodes SET
       max_streams = COALESCE($3::int, max_streams),
       max_gb_day = COALESCE($4::int, max_gb_day),
       max_req_per_sec = COALESCE($5::int, max_req_per_sec)
     WHERE id = $1 AND owner_user_id = $2 AND status <> 'revoked'
     RETURNING id, status, max_streams, max_gb_day, max_req_per_sec`,
    [nodeId, userId, caps.maxStreams ?? null, caps.maxGbDay ?? null, caps.maxReqPerSec ?? null],
  );
  const n = r.rows[0];
  return n ? { id: n.id, status: n.status, maxStreams: n.max_streams, maxGbDay: n.max_gb_day, maxReqPerSec: n.max_req_per_sec } : null;
}

// ─── Burn reports ────────────────────────────────────────────────────

export type ReportResult =
  | { ok: true; reportId: string; nodeId: string; reportsToday: number }
  | { ok: false; reason: "not_found" | "not_relay" | "too_old" | "duplicate" | "rate_limited" };

/**
 * Record a burn report for a relay session the reporter owns. Cap (5 per
 * reporter per node per UTC day) is enforced under a per-(reporter,node)
 * advisory lock. Feeds node_daily_stats.burns, which the reputation job reads.
 */
export async function reportSession(reporterUserId: string, sessionId: string, reason: ReportReason): Promise<ReportResult> {
  if (!UUID_RE.test(sessionId)) return { ok: false, reason: "not_found" };
  if (!(REPORT_REASONS as readonly string[]).includes(reason)) throw new Error("Invalid reason");
  return withTx(async (client) => {
    const s = await client.query<{ node_id: string | null; recent: boolean }>(
      `SELECT node_id, started_at > now() - make_interval(days => $3) AS recent
       FROM sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, reporterUserId, REPORT_WINDOW_DAYS],
    );
    const row = s.rows[0];
    if (!row) return { ok: false, reason: "not_found" };
    if (!row.node_id) return { ok: false, reason: "not_relay" };
    if (!row.recent) return { ok: false, reason: "too_old" };
    const nodeId = row.node_id;
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`node_report:${reporterUserId}:${nodeId}`]);
    const c = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM node_reports
       WHERE reporter_user_id = $1 AND node_id = $2 AND day = (now() AT TIME ZONE 'UTC')::date`,
      [reporterUserId, nodeId],
    );
    const today = Number(c.rows[0]?.n ?? "0");
    if (today >= MAX_REPORTS_PER_NODE_PER_DAY) return { ok: false, reason: "rate_limited" };
    const ins = await client.query<{ id: string }>(
      `INSERT INTO node_reports (session_id, node_id, reporter_user_id, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, reporter_user_id) DO NOTHING
       RETURNING id`,
      [sessionId, nodeId, reporterUserId, reason],
    );
    if (!ins.rows[0]) return { ok: false, reason: "duplicate" };
    await client.query(
      `INSERT INTO node_daily_stats (node_id, day, burns) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
       ON CONFLICT (node_id, day) DO UPDATE SET burns = LEAST(node_daily_stats.burns + 1, 2000000000)`,
      [nodeId],
    );
    return { ok: true, reportId: String(ins.rows[0].id), nodeId, reportsToday: today + 1 };
  });
}
