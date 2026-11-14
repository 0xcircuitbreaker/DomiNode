import { query } from "../db.js";
import { BLOCKED_COUNTRY_CODES } from "../sanctions.js";

/**
 * Public network status (LAUNCH_PLAN §5.6) and unmet demand (§11 gap 9).
 * Everything here is aggregate: no node ids, IPs, requester ids or hosts.
 */

/**
 * k-anonymity for public stats: no published figure may describe fewer than
 * this many community (agent-run) nodes, so one operator's paid traffic and
 * online pattern are never singled out.
 */
export const PUBLIC_MIN_GROUP = 3;

export interface PublicSplit {
  onlineNodes: number; seedOnline: number; communityOnline: number;
  paidBytes24h: string; seedPaidBytes24h: string; communityPaidBytes24h: string;
  byClass: Record<string, number>;
  /**
   * Distinct community nodes with paid traffic in the 24h window (online or
   * not). Unknown (undefined/null, e.g. pre-feature snapshots) counts as 0.
   */
  communityPaidNodes24h?: number | null;
}

/** Published whenever community nodes online are below k (0 included): fixed shape, no signal. */
export const SMALL_COMMUNITY_SUPPRESSED = [
  "onlineNodes", "seedOnline", "communityOnline", "byClass",
  "paidBytes24h", "seedPaidBytes24h", "communityPaidBytes24h",
] as const;
/** Published whenever fewer than k community nodes earned paid bytes in 24h. */
export const SMALL_PAID_SUPPRESSED = ["paidBytes24h", "seedPaidBytes24h", "communityPaidBytes24h"] as const;

/**
 * Suppress small groups. Suppressed figures are published as 0 / "0" and named
 * in `suppressed` (numeric types stay stable for the SDKs).
 *  - community online below k, INCLUDING 0: every node count, byClass and
 *    every paid figure is hidden, always with the same `suppressed` list, so
 *    the 0 -> 1 -> 0 sequence of a lone node carries no signal (seed nodes are
 *    stable, so a published total minus the seed count would reveal it).
 *  - fewer than k distinct community nodes with paid traffic in the 24h window
 *    (which counts offline nodes too): all paid figures are hidden.
 *  - byClass entries below k fold into "other"; an "other" below k is dropped.
 */
export function kAnonymize<T extends PublicSplit>(x: T, k = PUBLIC_MIN_GROUP): T & { suppressed: string[] } {
  const out = { ...x, byClass: { ...x.byClass }, suppressed: [] as string[] };
  const smallCommunity = !(x.communityOnline >= k);
  const paidNodes = Number.isFinite(x.communityPaidNodes24h as number) ? (x.communityPaidNodes24h as number) : 0;
  const smallPaid = smallCommunity || paidNodes < k;
  if (smallCommunity) {
    out.onlineNodes = 0; out.seedOnline = 0; out.communityOnline = 0;
    out.suppressed.push(...SMALL_COMMUNITY_SUPPRESSED);
  } else if (smallPaid) {
    out.suppressed.push(...SMALL_PAID_SUPPRESSED);
  }
  if (smallPaid) { out.paidBytes24h = "0"; out.seedPaidBytes24h = "0"; out.communityPaidBytes24h = "0"; }
  delete (out as Partial<PublicSplit>).communityPaidNodes24h;
  const byClass: Record<string, number> = {};
  if (!smallCommunity) {
    let other = 0;
    for (const [cls, n] of Object.entries(x.byClass)) {
      if (!Number.isFinite(n) || n <= 0) continue;
      if (n >= k) byClass[cls] = n; else other += n;
    }
    if (other >= k) byClass["other"] = (byClass["other"] ?? 0) + other;
    else if (other > 0) out.suppressed.push("byClass");
  }
  out.byClass = byClass;
  return out;
}

export interface SnapshotInput {
  p50Ms: number | null;
  p95Ms: number | null;
}

/** Take (or refresh) the snapshot for the current UTC hour. */
export async function takeSnapshot(i: SnapshotInput): Promise<void> {
  const clamp = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.max(0, Math.min(3_600_000, Math.round(v))));
  await query(
    `WITH online AS (
       SELECT operator_run, country, asn, ip_class FROM nodes
       WHERE status = 'active' AND last_seen_at > now() - interval '5 minutes'
     ), paid AS (
       SELECT n.operator_run, SUM(rc.bytes_gateway) AS bytes, COUNT(DISTINCT rc.node_id) AS nodes
       FROM relay_charges rc JOIN nodes n ON n.id = rc.node_id
       WHERE rc.created_at > now() - interval '24 hours' AND rc.gross_musd > 0
       GROUP BY n.operator_run
     ), quality AS (
       SELECT SUM(streams) AS streams, SUM(failures) AS failures FROM node_daily_stats
       WHERE day >= (now() AT TIME ZONE 'UTC')::date - 1
     ), classes AS (
       SELECT COALESCE(jsonb_object_agg(cls, n), '{}'::jsonb) AS by_class
       FROM (SELECT COALESCE(ip_class, 'unknown') AS cls, COUNT(*) AS n FROM online GROUP BY 1) c
     )
     INSERT INTO network_stats_snapshots (hour, online_nodes, seed_online, community_online, countries, asns,
       success_rate_bps, p50_ms, p95_ms, paid_bytes_24h, seed_paid_bytes_24h, community_paid_bytes_24h, by_class, community_paid_nodes_24h)
     SELECT date_trunc('hour', now()),
       (SELECT COUNT(*) FROM online),
       (SELECT COUNT(*) FROM online WHERE operator_run),
       (SELECT COUNT(*) FROM online WHERE NOT operator_run),
       (SELECT COUNT(DISTINCT country) FROM online WHERE country IS NOT NULL),
       (SELECT COUNT(DISTINCT asn) FROM online WHERE asn IS NOT NULL),
       (SELECT CASE WHEN COALESCE(streams, 0) > 0
                    THEN GREATEST(0, LEAST(10000, ((streams - LEAST(failures, streams)) * 10000 / streams)))::int END FROM quality),
       $1::int, $2::int,
       COALESCE((SELECT SUM(bytes) FROM paid), 0),
       COALESCE((SELECT bytes FROM paid WHERE operator_run), 0),
       COALESCE((SELECT bytes FROM paid WHERE NOT operator_run), 0),
       (SELECT by_class FROM classes),
       COALESCE((SELECT nodes FROM paid WHERE NOT operator_run), 0)
     ON CONFLICT (hour) DO UPDATE SET
       online_nodes = EXCLUDED.online_nodes, seed_online = EXCLUDED.seed_online, community_online = EXCLUDED.community_online,
       countries = EXCLUDED.countries, asns = EXCLUDED.asns, success_rate_bps = EXCLUDED.success_rate_bps,
       p50_ms = EXCLUDED.p50_ms, p95_ms = EXCLUDED.p95_ms, paid_bytes_24h = EXCLUDED.paid_bytes_24h,
       seed_paid_bytes_24h = EXCLUDED.seed_paid_bytes_24h, community_paid_bytes_24h = EXCLUDED.community_paid_bytes_24h,
       by_class = EXCLUDED.by_class, community_paid_nodes_24h = EXCLUDED.community_paid_nodes_24h`,
    [clamp(i.p50Ms), clamp(i.p95Ms)],
  );
}

export async function purgeSnapshots(retentionDays: number): Promise<number> {
  const r = await query(`DELETE FROM network_stats_snapshots WHERE hour < now() - make_interval(days => $1)`, [retentionDays]);
  return r.rowCount ?? 0;
}

export interface SnapshotRow {
  hour: Date; onlineNodes: number; seedOnline: number; communityOnline: number; countries: number; asns: number;
  successRateBps: number | null; p50Ms: number | null; p95Ms: number | null; paidBytes24h: string;
  seedPaidBytes24h: string; communityPaidBytes24h: string; byClass: Record<string, number>;
  /** Fields hidden by kAnonymize (published as 0). */
  suppressed?: string[];
}

/** Public history; every row passes through kAnonymize. */
export async function listSnapshots(hours: number): Promise<SnapshotRow[]> {
  const r = await query<{
    hour: Date; online_nodes: number; seed_online: number; community_online: number; countries: number; asns: number;
    success_rate_bps: number | null; p50_ms: number | null; p95_ms: number | null; paid_bytes_24h: string;
    seed_paid_bytes_24h: string; community_paid_bytes_24h: string; by_class: Record<string, number>;
    community_paid_nodes_24h: number | null;
  }>(
    `SELECT hour, online_nodes, seed_online, community_online, countries, asns, success_rate_bps, p50_ms, p95_ms,
            paid_bytes_24h::text AS paid_bytes_24h, seed_paid_bytes_24h::text AS seed_paid_bytes_24h,
            community_paid_bytes_24h::text AS community_paid_bytes_24h, by_class, community_paid_nodes_24h
     FROM network_stats_snapshots WHERE hour > now() - make_interval(hours => $1) ORDER BY hour ASC LIMIT 10000`,
    [hours],
  );
  return r.rows.map((x) => {
    const row = kAnonymize({
      hour: x.hour, onlineNodes: x.online_nodes, seedOnline: x.seed_online, communityOnline: x.community_online,
      countries: x.countries, asns: x.asns, successRateBps: x.success_rate_bps, p50Ms: x.p50_ms, p95Ms: x.p95_ms,
      paidBytes24h: x.paid_bytes_24h, seedPaidBytes24h: x.seed_paid_bytes_24h, communityPaidBytes24h: x.community_paid_bytes_24h,
      byClass: x.by_class ?? {}, communityPaidNodes24h: x.community_paid_nodes_24h,
    });
    // Country/ASN counts of a suppressed hour would still describe the few nodes.
    if (row.suppressed.includes("onlineNodes")) {
      row.countries = 0; row.asns = 0;
      row.suppressed.push("countries", "asns");
    }
    return row;
  });
}

export interface IncidentRow {
  id: string; title: string; body: string; severity: string; status: string;
  startedAt: Date; resolvedAt: Date | null; updatedAt: Date;
}

export async function listIncidents(limit: number, offset = 0): Promise<IncidentRow[]> {
  const r = await query<{ id: string; title: string; body: string; severity: string; status: string; started_at: Date; resolved_at: Date | null; updated_at: Date }>(
    `SELECT id, title, body, severity, status, started_at, resolved_at, updated_at
     FROM network_incidents ORDER BY started_at DESC, id LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return r.rows.map((x) => ({ id: x.id, title: x.title, body: x.body, severity: x.severity, status: x.status, startedAt: x.started_at, resolvedAt: x.resolved_at, updatedAt: x.updated_at }));
}

// ─── Unmet demand ───────────────────────────────────────────────────

export interface UnmetDemandRow { hour: Date; country: string; ipClass: string; requests: number }

/** Upsert a batch of aggregated counts (added to existing rows). */
export async function addUnmetDemand(rows: UnmetDemandRow[]): Promise<number> {
  const ok = rows.filter((r) =>
    (r.country === "" || /^[A-Z]{2}$/.test(r.country)) && ["", "residential", "dc", "mobile"].includes(r.ipClass) &&
    Number.isInteger(r.requests) && r.requests > 0 && r.requests <= 2_000_000_000,
  ).slice(0, 5000);
  if (ok.length === 0) return 0;
  await query(
    `INSERT INTO unmet_demand_hourly (hour, country, ip_class, requests)
     SELECT h, c, k, n FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::int[]) AS u(h, c, k, n)
     ON CONFLICT (hour, country, ip_class) DO UPDATE
       SET requests = LEAST(2000000000, unmet_demand_hourly.requests + EXCLUDED.requests)`,
    [ok.map((r) => r.hour.toISOString()), ok.map((r) => r.country), ok.map((r) => r.ipClass), ok.map((r) => r.requests)],
  );
  return ok.length;
}

export async function purgeUnmetDemand(retentionDays: number): Promise<number> {
  const r = await query(`DELETE FROM unmet_demand_hourly WHERE hour < now() - make_interval(days => $1)`, [retentionDays]);
  return r.rowCount ?? 0;
}

export interface WantedRow { country: string | null; ipClass: string | null; requests: number }

/** Aggregated unmet demand over `days`, grouped by (country, class), groups with >= minRequests only. */
export async function listWanted(days: number, minRequests: number, limit = 100): Promise<WantedRow[]> {
  const r = await query<{ country: string; ip_class: string; requests: string }>(
    `SELECT country, ip_class, SUM(requests)::text AS requests FROM unmet_demand_hourly
     WHERE hour > now() - make_interval(days => $1)
     GROUP BY country, ip_class HAVING SUM(requests) >= $2
     ORDER BY SUM(requests) DESC, country, ip_class LIMIT $3`,
    [days, minRequests, limit],
  );
  return r.rows
    .filter((x) => !BLOCKED_COUNTRY_CODES.has(x.country))
    .map((x) => ({ country: x.country || null, ipClass: x.ip_class || null, requests: Number(x.requests) }));
}

// ─── Gateway liveness (public status availability) ──────────────────

/** Mark this gateway instance alive for the current UTC minute (idempotent). */
export async function recordGatewayHeartbeat(instanceId: string): Promise<void> {
  if (typeof instanceId !== "string" || instanceId.length < 1 || instanceId.length > 64) return;
  await query(
    `INSERT INTO gateway_heartbeats (minute, instance_id) VALUES (date_trunc('minute', now()), $1)
     ON CONFLICT (minute, instance_id) DO NOTHING`,
    [instanceId],
  );
}

export async function purgeGatewayHeartbeats(retentionDays = 8): Promise<number> {
  const r = await query(`DELETE FROM gateway_heartbeats WHERE minute < now() - make_interval(days => $1)`, [retentionDays]);
  return r.rowCount ?? 0;
}

export interface GatewayLiveness {
  /** Distinct gateway instances that heartbeated in the last 2 minutes. */
  instancesOnline: number;
  lastHeartbeatAt: Date | null;
  /** Share of whole minutes with at least one live gateway, in basis points; null before any data. */
  availability24hBps: number | null;
  availability7dBps: number | null;
}

/** Availability = minutes with any heartbeat / minutes in the window (window starts no earlier than the first heartbeat on record). */
export function availabilityBps(up: number, total: number): number | null {
  if (!Number.isFinite(up) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(10_000, Math.floor((up * 10_000) / total)));
}

export async function getGatewayLiveness(): Promise<GatewayLiveness> {
  const r = await query<{ online: string; last: Date | null; up24: string; tot24: string; up7: string; tot7: string }>(
    `WITH e AS (SELECT date_trunc('minute', now()) AS e, (SELECT MIN(minute) FROM gateway_heartbeats) AS first),
     w AS (SELECT e.e, GREATEST(e.e - interval '24 hours', COALESCE(e.first, e.e)) AS s24, GREATEST(e.e - interval '7 days', COALESCE(e.first, e.e)) AS s7 FROM e)
     SELECT (SELECT COUNT(DISTINCT instance_id) FROM gateway_heartbeats WHERE minute >= w.e - interval '2 minutes')::text AS online,
            (SELECT MAX(minute) FROM gateway_heartbeats) AS last,
            (SELECT COUNT(DISTINCT minute) FROM gateway_heartbeats WHERE minute >= w.s24 AND minute < w.e)::text AS up24,
            COALESCE(FLOOR(EXTRACT(EPOCH FROM (w.e - w.s24)) / 60), 0)::text AS tot24,
            (SELECT COUNT(DISTINCT minute) FROM gateway_heartbeats WHERE minute >= w.s7 AND minute < w.e)::text AS up7,
            COALESCE(FLOOR(EXTRACT(EPOCH FROM (w.e - w.s7)) / 60), 0)::text AS tot7
     FROM w`,
  );
  const x = r.rows[0];
  const n = (s: string | undefined) => { const v = parseInt(s ?? "0", 10); return Number.isFinite(v) ? v : 0; };
  return {
    instancesOnline: n(x?.online),
    lastHeartbeatAt: x?.last ?? null,
    availability24hBps: availabilityBps(n(x?.up24), n(x?.tot24)),
    availability7dBps: availabilityBps(n(x?.up7), n(x?.tot7)),
  };
}
