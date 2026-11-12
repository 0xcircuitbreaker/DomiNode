import { Router } from "express";
import type { Request, Response } from "express";
import { getPool } from "@dominusnode/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import {
  HttpError, fail, money, gb, bigStr, page, enumParam, dateParam, periodStart, str, uuidParam,
} from "./admin-network-common.js";

/**
 * Admin control panel read API: overview, revenue, geo, health, audit
 * (docs/agent-network/ADMIN_API.md). Mounted at /api/admin/network.
 */
const router = Router();
router.use(requireAuth, requireAdmin);

/** A node is "online" while its gateway slot heartbeat is fresh (relay-limits-repo SLOT_TTL_SECONDS). */
export const ONLINE_SQL = `EXISTS (SELECT 1 FROM node_ip_slots s WHERE s.node_id = n.id AND s.heartbeat_at > now() - interval '90 seconds')`;

export const RAILS = ["wallet", "team", "agentic_wallet", "x402", "mpp", "free"] as const;
export const IP_CLASSES = ["residential", "dc", "mobile", "unknown"] as const;
const NODE_STATUSES = ["pending", "active", "cooldown", "quarantined", "suspended", "revoked"] as const;
const PAYOUT_STATUSES = ["pending", "held_tax", "held_frozen", "submitted", "confirmed", "failed", "reversed"] as const;

const q = <R>(sql: string, params: unknown[] = []) =>
  getPool().query(sql, params) as unknown as Promise<{ rows: R[] }>;

// ─── GET /overview ──────────────────────────────────────────────────

type Row = Record<string, unknown>;

router.get("/overview", async (_req: Request, res: Response) => {
  try {
    const [nodes, online, agents, owners, rev, credits, payouts, disputes] = await Promise.all([
      q<{ status: string; total: string; online: string }>(
        `SELECT n.status, COUNT(*)::text AS total, COUNT(*) FILTER (WHERE ${ONLINE_SQL})::text AS online
         FROM nodes n GROUP BY n.status`),
      q<{ prefixes: string; asns: string; nodes: string }>(
        `SELECT COUNT(DISTINCT s.prefix24)::text AS prefixes, COUNT(DISTINCT s.asn)::text AS asns, COUNT(*)::text AS nodes
         FROM node_ip_slots s WHERE s.heartbeat_at > now() - interval '90 seconds'`),
      q<{ d1: string; d7: string; d30: string }>(
        `SELECT COUNT(DISTINCT requester_user_id) FILTER (WHERE created_at > now() - interval '24 hours')::text AS d1,
                COUNT(DISTINCT requester_user_id) FILTER (WHERE created_at > now() - interval '7 days')::text AS d7,
                COUNT(DISTINCT requester_user_id)::text AS d30
         FROM relay_charges WHERE created_at > now() - interval '30 days'`),
      q<{ owners: string; active_owners: string }>(
        `SELECT COUNT(DISTINCT owner_user_id) FILTER (WHERE status <> 'revoked')::text AS owners,
                COUNT(DISTINCT owner_user_id) FILTER (WHERE status = 'active')::text AS active_owners
         FROM nodes`),
      q<Row>(
        `SELECT
           ${["24 hours", "7 days", "30 days"].map((iv, i) => {
             const k = ["d1", "d7", "d30"][i];
             const f = `FILTER (WHERE created_at > now() - interval '${iv}')`;
             return `COALESCE(SUM(bytes_gateway) ${f}, 0)::text AS ${k}_bytes, COALESCE(SUM(gross_musd) ${f}, 0)::text AS ${k}_gross,
                     COALESCE(SUM(platform_musd) ${f}, 0)::text AS ${k}_platform, COALESCE(SUM(node_musd) ${f}, 0)::text AS ${k}_node,
                     COUNT(*) ${f}::text AS ${k}_charges`;
           }).join(",\n")},
           COALESCE(SUM(bytes_gateway), 0)::text AS all_bytes, COALESCE(SUM(gross_musd), 0)::text AS all_gross,
           COALESCE(SUM(platform_musd), 0)::text AS all_platform, COALESCE(SUM(node_musd), 0)::text AS all_node,
           COUNT(*)::text AS all_charges
         FROM relay_charges`),
      q<{ pending: string; available: string; accounts: string; frozen: string; frozen_available: string }>(
        `SELECT COALESCE(SUM(pending_musd), 0)::text AS pending, COALESCE(SUM(available_musd), 0)::text AS available,
                COUNT(*)::text AS accounts, COUNT(*) FILTER (WHERE frozen)::text AS frozen,
                COALESCE(SUM(available_musd + pending_musd) FILTER (WHERE frozen), 0)::text AS frozen_available
         FROM node_credit_accounts`),
      q<{ status: string; count: string; musd: string }>(
        `SELECT status, COUNT(*)::text AS count, COALESCE(SUM(amount_musd), 0)::text AS musd
         FROM node_payouts
         WHERE status IN ('pending','held_tax','held_frozen','submitted')
            OR (status IN ('confirmed','failed','reversed') AND updated_at > now() - interval '30 days')
         GROUP BY status`),
      q<{ open: string; open_nodes: string }>(
        `SELECT COUNT(*)::text AS open, COUNT(DISTINCT node_id)::text AS open_nodes FROM byte_disputes WHERE status = 'open'`),
    ]);

    const byStatus: Record<string, { total: number; online: number }> = {};
    for (const s of NODE_STATUSES) byStatus[s] = { total: 0, online: 0 };
    let total = 0;
    let onlineTotal = 0;
    for (const r of nodes.rows) {
      byStatus[r.status] = { total: Number(r.total), online: Number(r.online) };
      total += Number(r.total);
      onlineTotal += Number(r.online);
    }
    const r = rev.rows[0] ?? {};
    const window = (k: string) => ({
      bytes: bigStr(r[`${k}_bytes`]), gb: gb(r[`${k}_bytes`]), charges: Number(r[`${k}_charges`] ?? 0),
      gross: money(r[`${k}_gross`]), platform: money(r[`${k}_platform`]), node: money(r[`${k}_node`]),
    });
    const p: Record<string, { count: number; amount: ReturnType<typeof money> }> = {};
    for (const s of PAYOUT_STATUSES) p[s] = { count: 0, amount: money(0) };
    for (const row of payouts.rows) p[row.status] = { count: Number(row.count), amount: money(row.musd) };
    const c = credits.rows[0];
    res.json({
      generatedAt: new Date().toISOString(),
      nodes: {
        total, online: onlineTotal, byStatus,
        quarantined: byStatus["quarantined"]?.total ?? 0,
        uniquePrefixesOnline: Number(online.rows[0]?.prefixes ?? 0),
        uniqueAsnsOnline: Number(online.rows[0]?.asns ?? 0),
      },
      agents: {
        requestersActive24h: Number(agents.rows[0]?.d1 ?? 0),
        requestersActive7d: Number(agents.rows[0]?.d7 ?? 0),
        requestersActive30d: Number(agents.rows[0]?.d30 ?? 0),
        nodeOwners: Number(owners.rows[0]?.owners ?? 0),
        nodeOwnersWithActiveNode: Number(owners.rows[0]?.active_owners ?? 0),
      },
      traffic: { "24h": window("d1"), "7d": window("d7"), "30d": window("d30"), all: window("all") },
      credits: {
        accounts: Number(c?.accounts ?? 0), frozenAccounts: Number(c?.frozen ?? 0),
        pending: money(c?.pending), available: money(c?.available), frozenBalance: money(c?.frozen_available),
      },
      payouts: {
        pending: p["pending"], heldTax: p["held_tax"], heldFrozen: p["held_frozen"], submitted: p["submitted"],
        confirmed30d: p["confirmed"], failed30d: p["failed"], reversed30d: p["reversed"],
      },
      disputes: { open: Number(disputes.rows[0]?.open ?? 0), nodesWithOpen: Number(disputes.rows[0]?.open_nodes ?? 0) },
    });
  } catch (err) { fail(res, err, "Overview"); }
});

// ─── GET /revenue ───────────────────────────────────────────────────

const BUCKETS = ["hour", "day", "week"] as const;
const BUCKET_MAX_MS: Record<(typeof BUCKETS)[number], number> = {
  hour: 31 * 86_400_000, day: 366 * 86_400_000, week: 3 * 366 * 86_400_000,
};

function range(req: Request, defDays: number, maxMs: number): { from: Date; to: Date } {
  const to = dateParam(req, "to") ?? new Date();
  const from = dateParam(req, "from") ?? new Date(to.getTime() - defDays * 86_400_000);
  if (from.getTime() >= to.getTime()) throw new HttpError(400, "from must be before to");
  if (to.getTime() - from.getTime() > maxMs) throw new HttpError(400, `range too large (max ${Math.floor(maxMs / 86_400_000)} days)`);
  return { from, to };
}

interface Acc { gross: bigint; platform: bigint; node: bigint; bytes: bigint; charges: number }
const acc0 = (): Acc => ({ gross: 0n, platform: 0n, node: 0n, bytes: 0n, charges: 0 });
const addAcc = (a: Acc, r: { gross: string; platform: string; node: string; bytes: string; charges: string }) => {
  a.gross += BigInt(r.gross); a.platform += BigInt(r.platform); a.node += BigInt(r.node);
  a.bytes += BigInt(r.bytes); a.charges += Number(r.charges);
};
const accOut = (a: Acc) => ({
  gross: money(a.gross), platform: money(a.platform), node: money(a.node),
  bytes: a.bytes.toString(), gb: gb(a.bytes), charges: a.charges,
});

router.get("/revenue", async (req: Request, res: Response) => {
  try {
    const bucket = enumParam(req, "bucket", BUCKETS) ?? "day";
    const { from, to } = range(req, bucket === "hour" ? 2 : 30, BUCKET_MAX_MS[bucket]);
    const r = await q<{ bucket: Date; rail: string; ip_class: string; gross: string; platform: string; node: string; bytes: string; charges: string }>(
      `SELECT date_trunc($3, rc.created_at, 'UTC') AS bucket, rc.payment_rail AS rail,
              COALESCE(n.ip_class, 'unknown') AS ip_class,
              SUM(rc.gross_musd)::text AS gross, SUM(rc.platform_musd)::text AS platform, SUM(rc.node_musd)::text AS node,
              SUM(rc.bytes_gateway)::text AS bytes, COUNT(*)::text AS charges
       FROM relay_charges rc LEFT JOIN nodes n ON n.id = rc.node_id
       WHERE rc.created_at >= $1 AND rc.created_at < $2
       GROUP BY 1, 2, 3 ORDER BY 1`,
      [from.toISOString(), to.toISOString(), bucket],
    );
    const series = new Map<string, { total: Acc; byRail: Record<string, Acc>; byClass: Record<string, Acc> }>();
    const totals = acc0();
    const byRail: Record<string, Acc> = Object.fromEntries(RAILS.map((x) => [x, acc0()]));
    const byClass: Record<string, Acc> = Object.fromEntries(IP_CLASSES.map((x) => [x, acc0()]));
    for (const row of r.rows) {
      const key = new Date(row.bucket).toISOString();
      let s = series.get(key);
      if (!s) {
        s = { total: acc0(), byRail: Object.fromEntries(RAILS.map((x) => [x, acc0()])), byClass: Object.fromEntries(IP_CLASSES.map((x) => [x, acc0()])) };
        series.set(key, s);
      }
      addAcc(s.total, row);
      addAcc(s.byRail[row.rail] ??= acc0(), row);
      addAcc(s.byClass[row.ip_class] ??= acc0(), row);
      addAcc(totals, row);
      addAcc(byRail[row.rail] ??= acc0(), row);
      addAcc(byClass[row.ip_class] ??= acc0(), row);
    }
    const mapOut = (m: Record<string, Acc>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, accOut(v)]));
    res.json({
      from: from.toISOString(), to: to.toISOString(), bucket,
      series: [...series.entries()].map(([t, s]) => ({ t, ...accOut(s.total), byRail: mapOut(s.byRail), byClass: mapOut(s.byClass) })),
      totals: { ...accOut(totals), byRail: mapOut(byRail), byClass: mapOut(byClass) },
    });
  } catch (err) { fail(res, err, "Revenue"); }
});

router.get("/revenue/top-requesters", async (req: Request, res: Response) => {
  try {
    const { period, since } = periodStart(req);
    const { limit, offset } = page(req, 20);
    const r = await q<{ user_id: string; email: string | null; wallet_address: string | null; gross: string; platform: string; node: string; bytes: string; charges: string; last_at: Date; total: string }>(
      `SELECT rc.requester_user_id AS user_id, u.email, u.wallet_address,
              SUM(rc.gross_musd)::text AS gross, SUM(rc.platform_musd)::text AS platform, SUM(rc.node_musd)::text AS node,
              SUM(rc.bytes_gateway)::text AS bytes, COUNT(*)::text AS charges, MAX(rc.created_at) AS last_at,
              COUNT(*) OVER ()::text AS total
       FROM relay_charges rc LEFT JOIN users u ON u.id = rc.requester_user_id
       WHERE rc.requester_user_id IS NOT NULL AND ($1::timestamptz IS NULL OR rc.created_at >= $1)
       GROUP BY rc.requester_user_id, u.email, u.wallet_address
       ORDER BY SUM(rc.gross_musd) DESC, rc.requester_user_id
       LIMIT $2 OFFSET $3`,
      [since?.toISOString() ?? null, limit, offset],
    );
    res.json({
      period, limit, offset, total: Number(r.rows[0]?.total ?? 0),
      items: r.rows.map((x) => ({
        userId: x.user_id, email: x.email, walletAddress: x.wallet_address,
        gross: money(x.gross), platform: money(x.platform), node: money(x.node),
        bytes: bigStr(x.bytes), gb: gb(x.bytes), charges: Number(x.charges), lastChargeAt: x.last_at,
      })),
    });
  } catch (err) { fail(res, err, "Top requesters"); }
});

router.get("/revenue/top-node-owners", async (req: Request, res: Response) => {
  try {
    const { period, since } = periodStart(req);
    const { limit, offset } = page(req, 20);
    const r = await q<{ user_id: string; email: string | null; wallet_address: string | null; tier: string | null; gross: string; platform: string; node: string; bytes: string; charges: string; nodes: string; total: string }>(
      `SELECT rc.node_owner_user_id AS user_id, u.email, u.wallet_address, t.name AS tier,
              SUM(rc.gross_musd)::text AS gross, SUM(rc.platform_musd)::text AS platform, SUM(rc.node_musd)::text AS node,
              SUM(rc.bytes_gateway)::text AS bytes, COUNT(*)::text AS charges, COUNT(DISTINCT rc.node_id)::text AS nodes,
              COUNT(*) OVER ()::text AS total
       FROM relay_charges rc
       LEFT JOIN users u ON u.id = rc.node_owner_user_id
       LEFT JOIN node_tiers t ON t.id = u.node_tier_id
       WHERE rc.node_owner_user_id IS NOT NULL AND ($1::timestamptz IS NULL OR rc.created_at >= $1)
       GROUP BY rc.node_owner_user_id, u.email, u.wallet_address, t.name
       ORDER BY SUM(rc.node_musd) DESC, rc.node_owner_user_id
       LIMIT $2 OFFSET $3`,
      [since?.toISOString() ?? null, limit, offset],
    );
    res.json({
      period, limit, offset, total: Number(r.rows[0]?.total ?? 0),
      items: r.rows.map((x) => ({
        userId: x.user_id, email: x.email, walletAddress: x.wallet_address, tier: x.tier,
        earnings: money(x.node), gross: money(x.gross), platform: money(x.platform),
        bytes: bigStr(x.bytes), gb: gb(x.bytes), charges: Number(x.charges), nodesWithTraffic: Number(x.nodes),
      })),
    });
  } catch (err) { fail(res, err, "Top node owners"); }
});

// ─── GET /network/geo ───────────────────────────────────────────────

router.get("/network/geo", async (req: Request, res: Response) => {
  try {
    const { period, since } = periodStart(req);
    const asnLimit = 100;
    const nodeAgg = (key: string) => `
      SELECT ${key} AS k, COUNT(*) FILTER (WHERE n.status <> 'revoked')::text AS nodes,
             COUNT(*) FILTER (WHERE n.status = 'active')::text AS active,
             COUNT(*) FILTER (WHERE ${ONLINE_SQL})::text AS online
      FROM nodes n GROUP BY 1`;
    const trafficAgg = (key: string) => `
      SELECT ${key} AS k, SUM(rc.bytes_gateway)::text AS bytes, SUM(rc.gross_musd)::text AS gross, SUM(rc.node_musd)::text AS node
      FROM relay_charges rc JOIN nodes n ON n.id = rc.node_id
      WHERE ($1::timestamptz IS NULL OR rc.created_at >= $1) GROUP BY 1`;
    type NA = { k: string | null; nodes: string; active: string; online: string };
    type TA = { k: string | null; bytes: string; gross: string; node: string };
    const [nc, tc, na, ta] = await Promise.all([
      q<NA>(nodeAgg("n.country")),
      q<TA>(trafficAgg("n.country"), [since?.toISOString() ?? null]),
      q<NA>(nodeAgg("n.asn::text")),
      q<TA>(trafficAgg("n.asn::text"), [since?.toISOString() ?? null]),
    ]);
    const merge = (nodes: NA[], traffic: TA[]) => {
      const m = new Map<string, { nodes: number; active: number; online: number; bytes: string; gross: string; node: string }>();
      const get = (k: string) => m.get(k) ?? (m.set(k, { nodes: 0, active: 0, online: 0, bytes: "0", gross: "0", node: "0" }), m.get(k)!);
      for (const r of nodes) Object.assign(get(r.k ?? "unknown"), { nodes: Number(r.nodes), active: Number(r.active), online: Number(r.online) });
      for (const r of traffic) Object.assign(get(r.k ?? "unknown"), { bytes: r.bytes, gross: r.gross, node: r.node });
      return [...m.entries()]
        .filter(([, v]) => v.nodes > 0 || v.bytes !== "0")
        .sort((a, b) => (BigInt(b[1].bytes) > BigInt(a[1].bytes) ? 1 : BigInt(b[1].bytes) < BigInt(a[1].bytes) ? -1 : b[1].nodes - a[1].nodes));
    };
    const out = (k: string, v: { nodes: number; active: number; online: number; bytes: string; gross: string; node: string }) => ({
      nodes: v.nodes, activeNodes: v.active, onlineNodes: v.online, bytes: bigStr(v.bytes), gb: gb(v.bytes),
      gross: money(v.gross), nodeEarnings: money(v.node), key: k,
    });
    res.json({
      period,
      byCountry: merge(nc.rows, tc.rows).map(([k, v]) => { const { key: _k, ...o } = out(k, v); return { country: k, ...o }; }),
      byAsn: merge(na.rows, ta.rows).slice(0, asnLimit).map(([k, v]) => {
        const { key: _k, ...o } = out(k, v);
        return { asn: k === "unknown" ? null : Number(k), ...o };
      }),
    });
  } catch (err) { fail(res, err, "Geo"); }
});

// ─── GET /health ────────────────────────────────────────────────────

/** Default job intervals (ms), for staleness. Jobs not listed have no staleness check. */
export const JOB_INTERVALS_MS: Record<string, number> = {
  "node-status-sync": 30_000,
  "relay-settle-retry": 60_000,
  "reputation-flush": 60_000,
  probes: 900_000,
  maturity: 3_600_000,
  retention: 3_600_000,
  tiers: 86_400_000,
  payouts: 86_400_000,
  "starter-expiry": 3_600_000,
  genesis: 3_600_000,
  "network-snapshot": 3_600_000,
};

router.get("/health", async (_req: Request, res: Response) => {
  try {
    const pool = getPool() as unknown as { totalCount?: number; idleCount?: number; waitingCount?: number };
    const [jobs, retry, slots] = await Promise.all([
      q<{ job_name: string; instance_id: string; last_started_at: Date; last_finished_at: Date; last_ok: boolean; last_error: string | null; last_duration_ms: number; last_success_at: Date | null; run_count: string; fail_count: string }>(
        `SELECT job_name, instance_id, last_started_at, last_finished_at, last_ok, last_error, last_duration_ms,
                last_success_at, run_count::text AS run_count, fail_count::text AS fail_count
         FROM job_runs ORDER BY job_name LIMIT 100`),
      q<{ pending: string; due: string; dead: string; oldest: Date | null; max_attempts: number | null }>(
        `SELECT COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
                COUNT(*) FILTER (WHERE status = 'pending' AND next_attempt_at <= now())::text AS due,
                COUNT(*) FILTER (WHERE status = 'dead')::text AS dead,
                MIN(created_at) FILTER (WHERE status = 'pending') AS oldest,
                MAX(attempts) FILTER (WHERE status = 'pending') AS max_attempts
         FROM relay_settle_retries`),
      q<{ instances: string; nodes: string; last_hb: Date | null }>(
        `SELECT COUNT(DISTINCT instance_id)::text AS instances, COUNT(*)::text AS nodes, MAX(heartbeat_at) AS last_hb
         FROM node_ip_slots WHERE heartbeat_at > now() - interval '90 seconds'`),
    ]);
    const now = Date.now();
    const seen = new Set<string>();
    interface JobOut {
      name: string; instanceId: string | null; lastStartedAt: Date | null; lastFinishedAt: Date | null;
      lastOk: boolean | null; lastError: string | null; lastDurationMs: number | null; lastSuccessAt: Date | null;
      runCount: number; failCount: number; expectedIntervalMs: number | null; stale: boolean;
    }
    const jobOut: JobOut[] = jobs.rows.map((j) => {
      seen.add(j.job_name);
      const iv = JOB_INTERVALS_MS[j.job_name] ?? null;
      const ageMs = now - new Date(j.last_finished_at).getTime();
      return {
        name: j.job_name, instanceId: j.instance_id, lastStartedAt: j.last_started_at, lastFinishedAt: j.last_finished_at,
        lastOk: j.last_ok, lastError: j.last_error, lastDurationMs: j.last_duration_ms, lastSuccessAt: j.last_success_at,
        runCount: Number(j.run_count), failCount: Number(j.fail_count), expectedIntervalMs: iv,
        stale: iv !== null && ageMs > 3 * iv,
      };
    });
    for (const name of Object.keys(JOB_INTERVALS_MS)) {
      if (!seen.has(name)) {
        jobOut.push({
          name, instanceId: null, lastStartedAt: null, lastFinishedAt: null,
          lastOk: null, lastError: null, lastDurationMs: null, lastSuccessAt: null,
          runCount: 0, failCount: 0, expectedIntervalMs: JOB_INTERVALS_MS[name], stale: true,
        });
      }
    }
    const rr = retry.rows[0];
    const sl = slots.rows[0];
    res.json({
      generatedAt: new Date(now).toISOString(),
      jobs: jobOut,
      settleRetryQueue: {
        pending: Number(rr?.pending ?? 0), due: Number(rr?.due ?? 0), dead: Number(rr?.dead ?? 0),
        oldestPendingAt: rr?.oldest ?? null, maxAttempts: rr?.max_attempts ?? 0,
      },
      gateway: { liveInstances: Number(sl?.instances ?? 0), connectedNodes: Number(sl?.nodes ?? 0), lastHeartbeatAt: sl?.last_hb ?? null },
      dbPool: { total: pool.totalCount ?? null, idle: pool.idleCount ?? null, waiting: pool.waitingCount ?? null },
    });
  } catch (err) { fail(res, err, "Health"); }
});

// ─── GET /audit ─────────────────────────────────────────────────────

/** audit_events actions written by /api/admin/network and the legacy /api/admin routes. */
export const NETWORK_AUDIT_ACTIONS = [
  "node_credit_unfreeze", "node_credit_freeze", "node_quarantine", "node_activate", "node_revoke",
  "node_payout_reverse", "byte_dispute_resolve", "relay_abuse_log_access",
  "network_policy_publish", "network_pricing_update", "revenue_split_append", "node_tier_update",
  "node_credit_auto_freeze", "collusion_flag_dismiss", "collusion_flag_confirm", "collusion_settings_update",
  // Legacy /api/admin (admin.ts)
  "user_suspend", "user_activate", "user_delete", "user_plan_set", "admin_role_set",
  "wallet_credit", "team_wallet_credit", "bug_report_approve", "bug_report_reject",
  "promo_create", "promo_disable", "waitlist_approve", "waitlist_bulk_approve", "waitlist_cancel",
  "loyalty_process", "commissions_process",
] as const;

router.get("/audit", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req);
    const action = enumParam(req, "action", NETWORK_AUDIT_ACTIONS);
    const adminUser = uuidParam(req, "adminUserId");
    const resourceId = str(req.query["resourceId"]);
    if (resourceId !== undefined && resourceId.length > 128) throw new HttpError(400, "resourceId too long");
    const from = dateParam(req, "from");
    const to = dateParam(req, "to");
    const params = [
      action ? [action] : [...NETWORK_AUDIT_ACTIONS], adminUser ?? null, resourceId ?? null,
      from?.toISOString() ?? null, to?.toISOString() ?? null,
    ];
    const where = `WHERE a.action = ANY($1::text[]) AND ($2::uuid IS NULL OR a.user_id = $2)
      AND ($3::text IS NULL OR a.resource_id = $3)
      AND ($4::timestamptz IS NULL OR a.created_at >= $4) AND ($5::timestamptz IS NULL OR a.created_at < $5)`;
    const [rows, total] = await Promise.all([
      q<{ id: string; user_id: string | null; email: string | null; action: string; resource: string; resource_id: string | null; ip_address: string | null; details: unknown; created_at: Date }>(
        `SELECT a.id, a.user_id, u.email, a.action, a.resource, a.resource_id, a.ip_address, a.details, a.created_at
         FROM audit_events a LEFT JOIN users u ON u.id = a.user_id ${where}
         ORDER BY a.created_at DESC, a.id LIMIT $6 OFFSET $7`, [...params, limit, offset]),
      q<{ count: string }>(`SELECT COUNT(*)::text AS count FROM audit_events a ${where}`, params),
    ]);
    res.json({
      limit, offset, total: Number(total.rows[0]?.count ?? 0),
      items: rows.rows.map((a) => ({
        id: a.id, adminUserId: a.user_id, adminEmail: a.email, action: a.action, resource: a.resource,
        resourceId: a.resource_id, ipAddress: a.ip_address, details: a.details, createdAt: a.created_at,
      })),
    });
  } catch (err) { fail(res, err, "Audit"); }
});

export default router;
