import { query } from "../db.js";
import { withTx } from "./node-credit-repo.js";

/**
 * Relay limits shared across gateway instances via PostgreSQL (DESIGN.md §4,
 * §11): per-/32, /24 and ASN node caps (node_ip_slots), the per-requester
 * daily spend cap including in-flight reservations, and requests/sec.
 *
 * Every row an instance owns carries its instance_id and a heartbeat; rows of
 * an instance that stopped heartbeating (crash) are ignored after
 * SLOT_TTL_SECONDS and swept, so crashed instances do not leak capacity.
 */
export const SLOT_TTL_SECONDS = 90;
const MAX_MUSD = 1_000_000_000_000_000n;
const INSTANCE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

function checkInstance(id: string): void {
  if (!INSTANCE_RE.test(id)) throw new Error("invalid instance id");
}
function checkMusd(v: bigint): void {
  if (typeof v !== "bigint" || v < 0n || v > MAX_MUSD) throw new Error("musd out of range");
}

export interface SlotClaim {
  nodeId: string;
  instanceId: string;
  ip: string;
  prefix24: string;
  asn: number | null;
  /** Count the ASN cap (also for asn = null: the shared unknown bucket). */
  enforceAsn: boolean;
  limits: { per32: number; per24: number; perAsn: number };
}

/**
 * Claim a node IP slot atomically against the fleet-wide caps. A global
 * transaction-scoped advisory lock serializes claims (tunnel auths are rare
 * relative to traffic), so count-then-insert cannot race across instances.
 * Returns false when a cap is reached.
 */
export async function claimNodeSlot(c: SlotClaim): Promise<boolean> {
  checkInstance(c.instanceId);
  return withTx(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('node_ip_slots'))`);
    await client.query(
      `DELETE FROM node_ip_slots WHERE heartbeat_at < now() - make_interval(secs => $1)`,
      [SLOT_TTL_SECONDS],
    );
    const r = await client.query<{ per32: string; per24: string; per_asn: string }>(
      `SELECT count(*) FILTER (WHERE ip = $2::inet) AS per32,
              count(*) FILTER (WHERE prefix24 = $3) AS per24,
              count(*) FILTER (WHERE asn IS NOT DISTINCT FROM $4::bigint) AS per_asn
         FROM node_ip_slots WHERE node_id <> $1`,
      [c.nodeId, c.ip, c.prefix24, c.asn],
    );
    const n = r.rows[0] ?? { per32: "0", per24: "0", per_asn: "0" };
    if (Number(n.per32) >= c.limits.per32 || Number(n.per24) >= c.limits.per24
      || (c.enforceAsn && Number(n.per_asn) >= c.limits.perAsn)) {
      return false;
    }
    await client.query(
      `INSERT INTO node_ip_slots (node_id, instance_id, ip, prefix24, asn, heartbeat_at)
       VALUES ($1, $2, $3::inet, $4, $5, now())
       ON CONFLICT (node_id) DO UPDATE SET instance_id = EXCLUDED.instance_id, ip = EXCLUDED.ip,
         prefix24 = EXCLUDED.prefix24, asn = EXCLUDED.asn, heartbeat_at = now()`,
      [c.nodeId, c.instanceId, c.ip, c.prefix24, c.asn],
    );
    return true;
  });
}

/** Release a slot this instance holds (no-op if another instance re-claimed it). */
export async function releaseNodeSlot(nodeId: string, instanceId: string): Promise<void> {
  checkInstance(instanceId);
  await query(`DELETE FROM node_ip_slots WHERE node_id = $1 AND instance_id = $2`, [nodeId, instanceId]);
}

/** Refresh this instance's slots and in-flight rows; sweep expired rows of dead instances. */
export async function heartbeat(instanceId: string): Promise<void> {
  checkInstance(instanceId);
  await query(`UPDATE node_ip_slots SET heartbeat_at = now() WHERE instance_id = $1`, [instanceId]);
  await query(`UPDATE requester_spend_inflight SET heartbeat_at = now() WHERE instance_id = $1`, [instanceId]);
  await query(`DELETE FROM node_ip_slots WHERE heartbeat_at < now() - make_interval(secs => $1)`, [SLOT_TTL_SECONDS]);
  await query(`DELETE FROM requester_spend_inflight WHERE heartbeat_at < now() - make_interval(secs => $1) OR inflight_musd = 0`, [SLOT_TTL_SECONDS]);
  await query(`DELETE FROM requester_rate_window WHERE sec < $1`, [Math.floor(Date.now() / 1000) - 60]);
  await query(`DELETE FROM requester_spend_daily WHERE day < (now() AT TIME ZONE 'UTC')::date - 2`);
}

/** Release everything this instance holds (graceful shutdown). */
export async function releaseInstance(instanceId: string): Promise<void> {
  checkInstance(instanceId);
  await query(`DELETE FROM node_ip_slots WHERE instance_id = $1`, [instanceId]);
  await query(`DELETE FROM requester_spend_inflight WHERE instance_id = $1`, [instanceId]);
}

export type ReserveResult = "ok" | "rate" | "spend";

export interface ReserveInput {
  userId: string;
  instanceId: string;
  /** In-flight amount to hold (0 = rate check + cap check only). */
  musd: bigint;
  /** Daily cap; null skips the spend check. */
  dailyCapMusd: bigint | null;
  /** Requests/sec limit; null skips the rate check. */
  reqPerSec: number | null;
  now?: number;
}

/**
 * Count one request against the fleet-wide req/s window and, under a per-user
 * row lock, refuse when settled + live in-flight spend has reached the daily
 * cap; otherwise add `musd` to this instance's in-flight hold. One transaction.
 */
export async function reserveRequester(i: ReserveInput): Promise<ReserveResult> {
  checkInstance(i.instanceId);
  checkMusd(i.musd);
  const now = i.now ?? Date.now();
  return withTx(async (client) => {
    if (i.reqPerSec !== null) {
      const r = await client.query<{ count: number }>(
        `INSERT INTO requester_rate_window (user_id, sec, count) VALUES ($1, $2, 1)
         ON CONFLICT (user_id, sec) DO UPDATE SET count = requester_rate_window.count + 1
           WHERE requester_rate_window.count < $3
         RETURNING count`,
        [i.userId, Math.floor(now / 1000), i.reqPerSec],
      );
      if (r.rows.length === 0) return "rate";
    }
    if (i.dailyCapMusd !== null) {
      const day = new Date(now).toISOString().slice(0, 10);
      await client.query(
        `INSERT INTO requester_spend_daily (user_id, day) VALUES ($1, $2::date) ON CONFLICT (user_id, day) DO NOTHING`,
        [i.userId, day],
      );
      const s = await client.query<{ settled_musd: string }>(
        `SELECT settled_musd FROM requester_spend_daily WHERE user_id = $1 AND day = $2::date FOR UPDATE`,
        [i.userId, day],
      );
      const f = await client.query<{ inflight: string }>(
        `SELECT COALESCE(SUM(inflight_musd), 0)::text AS inflight FROM requester_spend_inflight
         WHERE user_id = $1 AND heartbeat_at >= now() - make_interval(secs => $2)`,
        [i.userId, SLOT_TTL_SECONDS],
      );
      const used = BigInt(s.rows[0]?.settled_musd ?? "0") + BigInt(f.rows[0]?.inflight ?? "0");
      if (used >= i.dailyCapMusd) return "spend";
    }
    if (i.musd > 0n) {
      await client.query(
        `INSERT INTO requester_spend_inflight (user_id, instance_id, inflight_musd, heartbeat_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, instance_id) DO UPDATE
           SET inflight_musd = LEAST(requester_spend_inflight.inflight_musd + EXCLUDED.inflight_musd, $4), heartbeat_at = now()`,
        [i.userId, i.instanceId, i.musd.toString(), MAX_MUSD.toString()],
      );
    }
    return "ok";
  });
}

/**
 * Release `releaseMusd` of this instance's in-flight hold and add
 * `settledMusd` to today's settled spend, atomically.
 */
export async function settleRequester(
  userId: string, instanceId: string, releaseMusd: bigint, settledMusd: bigint, now = Date.now(),
): Promise<void> {
  checkInstance(instanceId);
  checkMusd(releaseMusd);
  checkMusd(settledMusd);
  if (releaseMusd === 0n && settledMusd === 0n) return;
  await withTx(async (client) => {
    if (releaseMusd > 0n) {
      await client.query(
        `UPDATE requester_spend_inflight SET inflight_musd = GREATEST(inflight_musd - $3, 0), heartbeat_at = now()
         WHERE user_id = $1 AND instance_id = $2`,
        [userId, instanceId, releaseMusd.toString()],
      );
    }
    if (settledMusd > 0n) {
      await client.query(
        `INSERT INTO requester_spend_daily (user_id, day, settled_musd, updated_at) VALUES ($1, $2::date, $3, now())
         ON CONFLICT (user_id, day) DO UPDATE
           SET settled_musd = LEAST(requester_spend_daily.settled_musd + EXCLUDED.settled_musd, $4), updated_at = now()`,
        [userId, new Date(now).toISOString().slice(0, 10), settledMusd.toString(), MAX_MUSD.toString()],
      );
    }
  });
}
