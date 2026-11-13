import { query } from "../db.js";
import type { SettleRelayChargeInput } from "./relay-charge-repo.js";
import { encodeSettleInput, decodeSettleInput } from "./relay-settle-retry-repo.js";

/**
 * Durable relay-session state for crash/restart recovery.
 *
 * At session start the gateway stores everything settleRelayCharge needs
 * (reservation, rail, team, locked price and split snapshot) on the sessions
 * row together with its instance id. While the session runs, the owning
 * instance heartbeats the row with the gateway-counted bytes. When an
 * instance dies, its sessions stop heartbeating; any instance then settles
 * them with the last flushed byte count (the unused reservation is refunded
 * and the node is paid for those bytes) instead of confiscating the
 * reservation. Sessions of live instances, and sessions with a pending
 * relay_settle_retries row, are never touched.
 */

const INSTANCE_RE = /^[A-Za-z0-9.:_-]{1,64}$/;
const MAX_BYTES = 1_099_511_627_776;

function checkInstance(id: string): void {
  if (!INSTANCE_RE.test(id)) throw new Error("invalid instance id");
}

function clampBytes(n: number): number {
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_BYTES) : 0;
}

/** Store the recovery payload (bytes zeroed) and owner instance on a fresh session row. */
export async function attachRecoveryPayload(instanceId: string, input: SettleRelayChargeInput): Promise<void> {
  checkInstance(instanceId);
  const payload = encodeSettleInput({ ...input, bytesGateway: 0n, bytesNode: null, bytesIn: 0, bytesOut: 0 });
  const r = await query(
    `UPDATE sessions
     SET gateway_instance = $2, gateway_heartbeat_at = now(), settle_payload = $3::jsonb,
         flushed_bytes_in = 0, flushed_bytes_out = 0
     WHERE id = $1 AND status = 'active'`,
    [input.sessionId, instanceId, JSON.stringify(payload)],
  );
  if ((r.rowCount ?? 0) !== 1) throw new Error("session recovery payload not stored");
}

export interface SessionBytes { sessionId: string; bytesIn: number; bytesOut: number }

/** Heartbeat this instance's live sessions and flush their gateway-counted bytes (one statement). */
export async function heartbeatSessions(instanceId: string, rows: SessionBytes[]): Promise<number> {
  checkInstance(instanceId);
  if (rows.length === 0) return 0;
  const ids: string[] = [], ins: string[] = [], outs: string[] = [];
  for (const r of rows.slice(0, 100_000)) {
    ids.push(r.sessionId); ins.push(String(clampBytes(r.bytesIn))); outs.push(String(clampBytes(r.bytesOut)));
  }
  const res = await query(
    `UPDATE sessions s
     SET gateway_heartbeat_at = now(),
         flushed_bytes_in = GREATEST(s.flushed_bytes_in, v.bin),
         flushed_bytes_out = GREATEST(s.flushed_bytes_out, v.bout)
     FROM unnest($2::uuid[], $3::bigint[], $4::bigint[]) AS v(id, bin, bout)
     WHERE s.id = v.id AND s.gateway_instance = $1 AND s.status = 'active'`,
    [instanceId, ids, ins, outs],
  );
  return res.rowCount ?? 0;
}

export interface RecoverableSession { sessionId: string; input: SettleRelayChargeInput }

/**
 * Active sessions whose owning instance stopped heartbeating more than
 * staleSeconds ago (never this instance's own), excluding sessions the
 * settle-retry queue already owns. Bytes are the last flushed counts.
 * Unreadable payloads are skipped (left for an admin), never guessed.
 */
export async function listRecoverableSessions(selfInstanceId: string, staleSeconds: number, limit = 100): Promise<RecoverableSession[]> {
  checkInstance(selfInstanceId);
  const stale = Math.max(30, Math.min(86_400, Math.floor(staleSeconds)));
  const lim = Math.max(1, Math.min(1000, Math.floor(limit)));
  const r = await query<{ id: string; settle_payload: unknown; flushed_bytes_in: string; flushed_bytes_out: string }>(
    `SELECT s.id, s.settle_payload, s.flushed_bytes_in, s.flushed_bytes_out
     FROM sessions s
     WHERE s.status = 'active'
       AND s.settle_payload IS NOT NULL
       AND s.gateway_instance IS DISTINCT FROM $1
       AND s.gateway_heartbeat_at < now() - make_interval(secs => $2)
       AND NOT EXISTS (SELECT 1 FROM relay_settle_retries q WHERE q.session_id = s.id AND q.status = 'pending')
     ORDER BY s.gateway_heartbeat_at
     LIMIT $3`,
    [selfInstanceId, stale, lim],
  );
  const out: RecoverableSession[] = [];
  for (const row of r.rows) {
    try {
      const base = decodeSettleInput(row.settle_payload);
      if (base.sessionId !== row.id) continue;
      const bytesIn = clampBytes(Number(row.flushed_bytes_in));
      const bytesOut = clampBytes(Number(row.flushed_bytes_out));
      out.push({
        sessionId: row.id,
        input: { ...base, bytesIn, bytesOut, bytesGateway: BigInt(bytesIn + bytesOut), bytesNode: null, sessionStatus: "error" },
      });
    } catch {
      /* invalid payload: leave for admin reconciliation */
    }
  }
  return out;
}

/**
 * Legacy rows (created before recovery payloads existed) cannot be settled:
 * close them as 'error' once old enough that no live gateway can still own
 * them. Rows the settle-retry queue owns are left alone.
 */
export async function closeLegacyOrphans(olderThanSeconds: number): Promise<number> {
  const age = Math.max(300, Math.min(30 * 86_400, Math.floor(olderThanSeconds)));
  const r = await query(
    `UPDATE sessions s SET status = 'error', ended_at = now(), settle_payload = NULL
     WHERE s.status = 'active' AND s.settle_payload IS NULL
       AND s.started_at < now() - make_interval(secs => $1)
       AND NOT EXISTS (SELECT 1 FROM relay_settle_retries q WHERE q.session_id = s.id AND q.status = 'pending')`,
    [age],
  );
  return r.rowCount ?? 0;
}
