import { query } from "../db.js";
import type { SettleRelayChargeInput, RelayRail } from "./relay-charge-repo.js";

/**
 * Durable retry queue for settleRelayCharge failures (relay_settle_retries).
 * settleRelayCharge is idempotent on session_id, so retrying is always safe.
 */

export const SETTLE_RETRY_MAX_ATTEMPTS = 20;
const RAILS: ReadonlySet<string> = new Set(["wallet", "team", "agentic_wallet", "x402", "mpp", "free"]);
const MAX_BYTES = 1_099_511_627_776n;

export interface SettleRetryRow {
  sessionId: string;
  attempts: number;
  input: SettleRelayChargeInput;
}

function big(v: bigint | null | undefined): string | null {
  return v === null || v === undefined ? null : v.toString();
}

/** Serialize the settle input; bigints become decimal strings. */
export function encodeSettleInput(i: SettleRelayChargeInput): Record<string, unknown> {
  return {
    sessionId: i.sessionId, requesterUserId: i.requesterUserId, requesterWallet: i.requesterWallet ?? null,
    requesterTeamId: i.requesterTeamId ?? null, rail: i.rail, reservedCents: i.reservedCents, nodeId: i.nodeId,
    bytesGateway: big(i.bytesGateway), bytesNode: big(i.bytesNode), bytesIn: i.bytesIn, bytesOut: i.bytesOut,
    pricePerGbMusd: big(i.pricePerGbMusd),
    snapshot: {
      splitConfigId: i.snapshot.splitConfigId, tierId: i.snapshot.tierId,
      nodeShareBps: i.snapshot.nodeShareBps, holdDays: i.snapshot.holdDays,
      genesisBonusBps: i.snapshot.genesisBonusBps ?? 0, buyerTierId: i.snapshot.buyerTierId ?? null,
      buyerDiscountBps: i.snapshot.buyerDiscountBps ?? 0, minPlatformMarginBps: i.snapshot.minPlatformMarginBps ?? 2500,
      tierWeightBps: i.snapshot.tierWeightBps ?? null,
    },
    destHost: i.destHost, destPort: i.destPort, usageTargetHost: i.usageTargetHost ?? null,
    zeroReason: i.zeroReason ?? null, prepaidGrossMusd: big(i.prepaidGrossMusd),
    agenticWalletId: i.agenticWalletId ?? null,
  };
}

function str(v: unknown): string {
  if (typeof v !== "string") throw new Error("invalid retry payload");
  return v;
}
function int(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("invalid retry payload");
  return v;
}
function bigOf(v: unknown): bigint {
  if (typeof v !== "string" || !/^\d{1,20}$/.test(v)) throw new Error("invalid retry payload");
  const b = BigInt(v);
  if (b > 10n ** 19n) throw new Error("invalid retry payload");
  return b;
}

/** Rebuild a settle input field by field (never spreads untrusted keys). */
export function decodeSettleInput(p: unknown): SettleRelayChargeInput {
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("invalid retry payload");
  const o = p as Record<string, unknown>;
  const snap = o["snapshot"] as Record<string, unknown> | undefined;
  if (!snap || typeof snap !== "object") throw new Error("invalid retry payload");
  const rail = str(o["rail"]);
  if (!RAILS.has(rail)) throw new Error("invalid retry payload");
  const bytesGateway = bigOf(o["bytesGateway"]);
  if (bytesGateway > MAX_BYTES) throw new Error("invalid retry payload");
  const out: SettleRelayChargeInput = {
    sessionId: str(o["sessionId"]), requesterUserId: str(o["requesterUserId"]),
    requesterWallet: o["requesterWallet"] === null ? null : str(o["requesterWallet"]),
    requesterTeamId: o["requesterTeamId"] === null ? null : str(o["requesterTeamId"]),
    rail: rail as RelayRail, reservedCents: int(o["reservedCents"]), nodeId: str(o["nodeId"]),
    bytesGateway, bytesNode: o["bytesNode"] === null ? null : bigOf(o["bytesNode"]),
    bytesIn: int(o["bytesIn"]), bytesOut: int(o["bytesOut"]), pricePerGbMusd: bigOf(o["pricePerGbMusd"]),
    snapshot: {
      splitConfigId: int(snap["splitConfigId"]), tierId: int(snap["tierId"]),
      nodeShareBps: int(snap["nodeShareBps"]), holdDays: int(snap["holdDays"]),
      // Older payloads predate these fields: no bonus, no discount.
      genesisBonusBps: snap["genesisBonusBps"] === undefined ? 0 : int(snap["genesisBonusBps"]),
      buyerTierId: snap["buyerTierId"] === undefined || snap["buyerTierId"] === null ? null : int(snap["buyerTierId"]),
      buyerDiscountBps: snap["buyerDiscountBps"] === undefined ? 0 : int(snap["buyerDiscountBps"]),
      minPlatformMarginBps: snap["minPlatformMarginBps"] === undefined ? 2500 : int(snap["minPlatformMarginBps"]),
    },
    destHost: str(o["destHost"]), destPort: int(o["destPort"]),
  };
  // Snapshotted exit-class weight (ECONOMICS §1a); older payloads have none.
  const tw = snap["tierWeightBps"];
  if (tw !== undefined && tw !== null) {
    const w = int(tw);
    if (w > 10_000) throw new Error("invalid retry payload");
    out.snapshot.tierWeightBps = w;
  }
  if (o["usageTargetHost"] !== null && o["usageTargetHost"] !== undefined) out.usageTargetHost = str(o["usageTargetHost"]);
  if (o["zeroReason"] !== null && o["zeroReason"] !== undefined) out.zeroReason = str(o["zeroReason"]) as SettleRelayChargeInput["zeroReason"];
  if (o["prepaidGrossMusd"] !== null && o["prepaidGrossMusd"] !== undefined) out.prepaidGrossMusd = bigOf(o["prepaidGrossMusd"]);
  if (o["agenticWalletId"] !== null && o["agenticWalletId"] !== undefined) out.agenticWalletId = str(o["agenticWalletId"]);
  return out;
}

/** Enqueue (idempotent on session_id: a second enqueue keeps the first payload). */
export async function enqueueSettleRetry(i: SettleRelayChargeInput, error: string): Promise<void> {
  await query(
    `INSERT INTO relay_settle_retries (session_id, requester_user_id, bytes_gateway, bytes_in, bytes_out, payload, last_error, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now() + interval '30 seconds')
     ON CONFLICT (session_id) DO NOTHING`,
    [i.sessionId, i.requesterUserId, i.bytesGateway.toString(), i.bytesIn, i.bytesOut,
      JSON.stringify(encodeSettleInput(i)), error.slice(0, 500)],
  );
}

/** Due pending retries (LIMIT 1000). Rows with an unreadable payload are marked dead. */
export async function listDueSettleRetries(limit = 100): Promise<SettleRetryRow[]> {
  const lim = Math.max(1, Math.min(1000, Math.floor(limit)));
  const r = await query<{ session_id: string; attempts: number; payload: unknown }>(
    `SELECT session_id, attempts, payload FROM relay_settle_retries
     WHERE status = 'pending' AND next_attempt_at <= now()
     ORDER BY next_attempt_at LIMIT $1`,
    [lim],
  );
  const out: SettleRetryRow[] = [];
  for (const row of r.rows) {
    try {
      out.push({ sessionId: row.session_id, attempts: row.attempts, input: decodeSettleInput(row.payload) });
    } catch {
      await query(
        `UPDATE relay_settle_retries SET status = 'dead', last_error = 'invalid payload', updated_at = now() WHERE session_id = $1`,
        [row.session_id],
      );
    }
  }
  return out;
}

export async function markSettleRetryDone(sessionId: string): Promise<void> {
  await query(
    `UPDATE relay_settle_retries SET status = 'done', attempts = LEAST(attempts + 1, 1000), last_error = NULL, updated_at = now()
     WHERE session_id = $1 AND status = 'pending'`,
    [sessionId],
  );
}

/** Backoff: 2^attempts minutes, capped at 6 h. Returns true when the row is now dead. */
export async function markSettleRetryFailed(sessionId: string, error: string, maxAttempts = SETTLE_RETRY_MAX_ATTEMPTS): Promise<boolean> {
  const r = await query<{ status: string }>(
    `UPDATE relay_settle_retries
     SET attempts = LEAST(attempts + 1, 1000),
         last_error = $2,
         status = CASE WHEN attempts + 1 >= $3 THEN 'dead' ELSE 'pending' END,
         next_attempt_at = now() + LEAST(interval '6 hours', interval '1 minute' * power(2, LEAST(attempts + 1, 20))),
         updated_at = now()
     WHERE session_id = $1 AND status = 'pending'
     RETURNING status`,
    [sessionId, error.slice(0, 500), maxAttempts],
  );
  return r.rows[0]?.status === "dead";
}
