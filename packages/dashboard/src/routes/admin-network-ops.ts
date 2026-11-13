import { Router } from "express";
import type { Request, Response } from "express";
import { createLogger, getPool, payoutRepo, policyRepo, disputeResolutionRepo } from "@dominusnode/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import {
  HttpError, fail, money, gb, bigStr, page, enumParam, uuidParam, uuidPath, boolParam, countryParam, intParam,
  dateParam, searchParam, likeEscape, withAdminTx, audit, adminId, type TxClient,
} from "./admin-network-common.js";
import { ONLINE_SQL, IP_CLASSES } from "./admin-network-metrics.js";

/**
 * Admin control panel: nodes, agents, credits, payouts, disputes, abuse log
 * (docs/agent-network/ADMIN_API.md). Mounted at /api/admin/network.
 *
 * Never selected: nodes.node_key_hash, nodes.floor_hash, api key hashes,
 * payout_wallets.change_sig, relay_settle_retries.payload.
 */
const log = createLogger("api:admin-network");
const router = Router();
router.use(requireAuth, requireAdmin);

const q = <R>(sql: string, params: unknown[] = []) =>
  getPool().query(sql, params) as unknown as Promise<{ rows: R[] }>;

const NODE_STATUSES = ["pending", "active", "cooldown", "quarantined", "suspended", "revoked"] as const;

function reasonField(b: Record<string, unknown>, required: boolean, max = 500): string | null {
  const v = b["reason"];
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, "reason is required");
    return null;
  }
  if (typeof v !== "string" || v.length === 0 || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) {
    throw new HttpError(400, `reason must be 1..${max} printable chars`);
  }
  return v;
}

function body(req: Request): Record<string, unknown> {
  const b = req.body ?? {};
  if (typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "Body must be an object");
  return b as Record<string, unknown>;
}

// ─── Nodes ──────────────────────────────────────────────────────────

/** Node columns safe for the admin API (no node_key_hash / floor_hash). */
const NODE_SELECT = `n.id, n.owner_user_id, n.owner_wallet, n.node_pubkey, n.status, n.attestation_version,
  host(n.observed_ip) AS observed_ip, n.ip_prefix24::text AS ip_prefix24, n.asn, n.country, n.ip_class,
  n.declared_class, n.class_verified_at,
  (SELECT COUNT(*)::int FROM collusion_flags cf WHERE cf.node_id = n.id AND cf.kind = 'egress_mismatch' AND cf.status = 'open') AS egress_flags,
  n.max_streams, n.max_gb_day, n.reputation, n.byte_disputes, n.agent_version, n.last_seen_at, n.created_at,
  ${ONLINE_SQL} AS online`;

interface NodeRow {
  id: string; owner_user_id: string; owner_wallet: string; node_pubkey: string | null; status: string;
  attestation_version: number; observed_ip: string | null; ip_prefix24: string | null; asn: string | null;
  country: string | null; ip_class: string | null; declared_class?: string | null; class_verified_at?: Date | null;
  egress_flags?: number; max_streams: number; max_gb_day: number; reputation: number;
  byte_disputes: number; agent_version: string | null; last_seen_at: Date | null; created_at: Date; online: boolean;
}

function nodeOut(n: NodeRow) {
  return {
    id: n.id, ownerUserId: n.owner_user_id, ownerWallet: n.owner_wallet, nodePubkey: n.node_pubkey, status: n.status,
    attestationVersion: n.attestation_version, observedIp: n.observed_ip, ipPrefix: n.ip_prefix24,
    asn: n.asn === null ? null : Number(n.asn), country: n.country, ipClass: n.ip_class,
    // Verified (effective, gateway-classified) vs owner-declared exit class.
    verifiedClass: n.ip_class ?? "unknown", declaredClass: n.declared_class ?? null,
    classVerifiedAt: n.class_verified_at ?? null, openEgressMismatchFlags: n.egress_flags ?? 0,
    maxStreams: n.max_streams,
    maxGbDay: n.max_gb_day, reputation: n.reputation, byteDisputes: n.byte_disputes, agentVersion: n.agent_version,
    lastSeenAt: n.last_seen_at, createdAt: n.created_at, online: n.online,
  };
}

const NODE_SORTS = {
  reputation: "n.reputation", bytes: "COALESCE(st.bytes_30d, 0)", last_seen: "n.last_seen_at", created: "n.created_at",
} as const;

router.get("/nodes", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req);
    const status = enumParam(req, "status", NODE_STATUSES);
    const country = countryParam(req);
    const asn = intParam(req, "asn", 0, 4294967295);
    const ipClass = enumParam(req, "ip_class", IP_CLASSES);
    const owner = uuidParam(req, "owner");
    const online = boolParam(req, "online");
    const quarantined = boolParam(req, "quarantined");
    const search = searchParam(req);
    const sort = enumParam(req, "sort", Object.keys(NODE_SORTS) as Array<keyof typeof NODE_SORTS>) ?? "created";
    const order = enumParam(req, "order", ["asc", "desc"] as const) ?? "desc";
    const params: unknown[] = [
      status ?? null, country ?? null, asn ?? null, ipClass ?? null, owner ?? null, online ?? null, quarantined ?? null,
      search === undefined ? null : `%${likeEscape(search.toLowerCase())}%`,
    ];
    const where = `WHERE ($1::text IS NULL OR n.status = $1) AND ($2::text IS NULL OR n.country = $2)
      AND ($3::bigint IS NULL OR n.asn = $3) AND ($4::text IS NULL OR COALESCE(n.ip_class, 'unknown') = $4)
      AND ($5::uuid IS NULL OR n.owner_user_id = $5) AND ($6::boolean IS NULL OR ${ONLINE_SQL} = $6)
      AND ($7::boolean IS NULL OR (n.status = 'quarantined') = $7)
      AND ($8::text IS NULL OR n.id::text LIKE $8 OR n.owner_wallet LIKE $8 OR host(n.observed_ip) LIKE $8
           OR lower(COALESCE(n.agent_version, '')) LIKE $8)`;
    const [rows, total] = await Promise.all([
      q<NodeRow & { bytes_24h: string | null; bytes_30d: string | null; owner_email: string | null; open_disputes: string }>(
        `SELECT ${NODE_SELECT}, u.email AS owner_email,
                COALESCE(st.bytes_24h, 0)::text AS bytes_24h, COALESCE(st.bytes_30d, 0)::text AS bytes_30d,
                (SELECT COUNT(*) FROM byte_disputes d WHERE d.node_id = n.id AND d.status = 'open')::text AS open_disputes
         FROM nodes n
         LEFT JOIN users u ON u.id = n.owner_user_id
         LEFT JOIN LATERAL (
           SELECT SUM(bytes) FILTER (WHERE day >= (now() AT TIME ZONE 'UTC')::date) AS bytes_24h, SUM(bytes) AS bytes_30d
           FROM node_daily_stats WHERE node_id = n.id AND day >= (now() AT TIME ZONE 'UTC')::date - 30
         ) st ON true
         ${where}
         ORDER BY ${NODE_SORTS[sort]} ${order === "asc" ? "ASC" : "DESC"} NULLS LAST, n.id
         LIMIT $9 OFFSET $10`, [...params, limit, offset]),
      q<{ count: string }>(`SELECT COUNT(*)::text AS count FROM nodes n ${where}`, params),
    ]);
    res.json({
      limit, offset, total: Number(total.rows[0]?.count ?? 0),
      items: rows.rows.map((n) => ({
        ...nodeOut(n), ownerEmail: n.owner_email, bytesToday: bigStr(n.bytes_24h), gbToday: gb(n.bytes_24h),
        bytes30d: bigStr(n.bytes_30d), gb30d: gb(n.bytes_30d), openDisputes: Number(n.open_disputes),
      })),
    });
  } catch (err) { fail(res, err, "Node list"); }
});

router.get("/nodes/:id", async (req: Request, res: Response) => {
  try {
    const id = uuidPath(req);
    const n = await q<NodeRow & { owner_email: string | null; owner_status: string | null; owner_tier: string | null }>(
      `SELECT ${NODE_SELECT}, u.email AS owner_email, u.status AS owner_status, t.name AS owner_tier
       FROM nodes n LEFT JOIN users u ON u.id = n.owner_user_id LEFT JOIN node_tiers t ON t.id = u.node_tier_id
       WHERE n.id = $1`, [id]);
    const node = n.rows[0];
    if (!node) throw new HttpError(404, "Node not found");
    const [daily, rep, disputes, chargesDaily, chargesRail, actions] = await Promise.all([
      q<{ day: string; bytes: string; streams: number; failures: number; burns: number }>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, bytes::text AS bytes, streams, failures, burns
         FROM node_daily_stats WHERE node_id = $1 AND day >= (now() AT TIME ZONE 'UTC')::date - 90
         ORDER BY day DESC LIMIT 90`, [id]),
      q<{ target_etld1: string; ok_count: number; burn_count: number; cooldown_until: Date | null }>(
        `SELECT target_etld1, ok_count, burn_count, cooldown_until FROM node_reputation
         WHERE node_id = $1 ORDER BY burn_count DESC, ok_count DESC, target_etld1 LIMIT 50`, [id]),
      q<{ id: string; relay_charge_id: string | null; bytes_gateway: string; bytes_node: string; status: string; created_at: Date; resolved_at: Date | null }>(
        `SELECT id::text AS id, relay_charge_id, bytes_gateway::text AS bytes_gateway, bytes_node::text AS bytes_node,
                status, created_at, resolved_at
         FROM byte_disputes WHERE node_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
      q<{ day: string; gross: string; node: string; platform: string; bytes: string; charges: string; requesters: string }>(
        `SELECT to_char(date_trunc('day', created_at, 'UTC'), 'YYYY-MM-DD') AS day,
                SUM(gross_musd)::text AS gross, SUM(node_musd)::text AS node, SUM(platform_musd)::text AS platform,
                SUM(bytes_gateway)::text AS bytes, COUNT(*)::text AS charges, COUNT(DISTINCT requester_user_id)::text AS requesters
         FROM relay_charges WHERE node_id = $1 AND created_at > now() - interval '30 days'
         GROUP BY 1 ORDER BY 1 DESC`, [id]),
      q<{ rail: string; gross: string; node: string; bytes: string; charges: string; disputed: string; zero: string }>(
        `SELECT payment_rail AS rail, SUM(gross_musd)::text AS gross, SUM(node_musd)::text AS node,
                SUM(bytes_gateway)::text AS bytes, COUNT(*)::text AS charges,
                COUNT(*) FILTER (WHERE disputed)::text AS disputed, COUNT(*) FILTER (WHERE zero_reason IS NOT NULL)::text AS zero
         FROM relay_charges WHERE node_id = $1 AND created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`, [id]),
      q<{ id: string; user_id: string | null; action: string; details: unknown; created_at: Date }>(
        `SELECT id, user_id, action, details, created_at FROM audit_events
         WHERE resource = 'node' AND resource_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
    ]);
    res.json({
      node: { ...nodeOut(node), ownerEmail: node.owner_email, ownerStatus: node.owner_status, ownerTier: node.owner_tier },
      dailyStats: daily.rows.map((d) => ({ day: d.day, bytes: d.bytes, gb: gb(d.bytes), streams: d.streams, failures: d.failures, burns: d.burns })),
      reputationByTarget: rep.rows.map((r) => ({ target: r.target_etld1, okCount: r.ok_count, burnCount: r.burn_count, cooldownUntil: r.cooldown_until })),
      disputes: disputes.rows.map((d) => ({
        id: d.id, relayChargeId: d.relay_charge_id, bytesGateway: d.bytes_gateway, bytesNode: d.bytes_node,
        status: d.status, createdAt: d.created_at, resolvedAt: d.resolved_at,
      })),
      chargesDaily: chargesDaily.rows.map((c) => ({
        day: c.day, gross: money(c.gross), node: money(c.node), platform: money(c.platform),
        bytes: c.bytes, gb: gb(c.bytes), charges: Number(c.charges), requesters: Number(c.requesters),
      })),
      chargesByRail30d: chargesRail.rows.map((c) => ({
        rail: c.rail, gross: money(c.gross), node: money(c.node), bytes: c.bytes, gb: gb(c.bytes),
        charges: Number(c.charges), disputed: Number(c.disputed), zeroShare: Number(c.zero),
      })),
      adminActions: actions.rows.map((a) => ({ id: a.id, adminUserId: a.user_id, action: a.action, details: a.details, createdAt: a.created_at })),
    });
  } catch (err) { fail(res, err, "Node detail"); }
});

/** Allowed source statuses per node action. Revoked is terminal. */
const NODE_ACTIONS = {
  quarantine: { to: "quarantined", from: ["pending", "active", "cooldown", "suspended"] },
  activate: { to: "active", from: ["pending", "cooldown", "quarantined", "suspended"] },
  revoke: { to: "revoked", from: ["pending", "active", "cooldown", "quarantined", "suspended"] },
} as const;

for (const [action, spec] of Object.entries(NODE_ACTIONS)) {
  router.post(`/nodes/:id/${action}`, async (req: Request, res: Response) => {
    try {
      const id = uuidPath(req);
      const reason = reasonField(body(req), action !== "activate");
      const out = await withAdminTx(adminId(req), async (c) => {
        const r = await c.query<{ status: string; owner_status: string | null }>(
          `SELECT n.status, u.status AS owner_status FROM nodes n LEFT JOIN users u ON u.id = n.owner_user_id
           WHERE n.id = $1 FOR UPDATE OF n`, [id]);
        const cur = r.rows[0];
        if (!cur) throw new HttpError(404, "Node not found");
        if (cur.status === spec.to) return { from: cur.status, changed: false };
        if (!(spec.from as readonly string[]).includes(cur.status)) {
          throw new HttpError(409, `Cannot ${action} a node in status ${cur.status}`);
        }
        if (action === "activate" && cur.owner_status !== "active") throw new HttpError(409, "Node owner is not active");
        await c.query(`UPDATE nodes SET status = $2 WHERE id = $1 AND status <> 'revoked'`, [id, spec.to]);
        await audit(c, req, `node_${action}`, "node", id, { from: cur.status, to: spec.to, reason });
        return { from: cur.status, changed: true };
      });
      log.info(`node ${action}`, { nodeId: id, from: out.from, changed: out.changed, by: adminId(req) });
      res.json({
        nodeId: id, previousStatus: out.from, status: spec.to, changed: out.changed,
        // The gateway's node-status-sync job (30 s) closes revoked tunnels and stops routing to non-active nodes.
        gatewayEffect: "within_sync_interval",
      });
    } catch (err) { fail(res, err, `Node ${action}`); }
  });
}

// ─── Agents ─────────────────────────────────────────────────────────

const AGENT_CTE = `
  WITH ids AS (
    SELECT owner_user_id AS uid FROM nodes
    UNION SELECT requester_user_id FROM relay_charges WHERE requester_user_id IS NOT NULL
    UNION SELECT user_id FROM node_credit_accounts
  ),
  spend AS (
    SELECT requester_user_id AS uid, SUM(gross_musd) AS total, SUM(gross_musd) FILTER (WHERE created_at > now() - interval '30 days') AS d30,
           SUM(bytes_gateway) AS bytes, MAX(created_at) AS last_at
    FROM relay_charges WHERE requester_user_id IS NOT NULL GROUP BY 1
  ),
  earn AS (
    SELECT node_owner_user_id AS uid, SUM(node_musd) AS total, SUM(node_musd) FILTER (WHERE created_at > now() - interval '30 days') AS d30
    FROM relay_charges WHERE node_owner_user_id IS NOT NULL GROUP BY 1
  ),
  nc AS (
    SELECT n.owner_user_id AS uid, COUNT(*) FILTER (WHERE n.status <> 'revoked') AS nodes,
           COUNT(*) FILTER (WHERE n.status = 'active') AS active, COUNT(*) FILTER (WHERE ${ONLINE_SQL}) AS online
    FROM nodes n GROUP BY 1
  )`;

const AGENT_COLS = `u.id, u.email, u.wallet_address, u.status, u.created_at, t.name AS tier, u.node_tier_id,
  COALESCE(spend.total, 0)::text AS spend_total, COALESCE(spend.d30, 0)::text AS spend_30d,
  COALESCE(spend.bytes, 0)::text AS bytes_total, spend.last_at AS last_request_at,
  COALESCE(earn.total, 0)::text AS earn_total, COALESCE(earn.d30, 0)::text AS earn_30d,
  COALESCE(nc.nodes, 0)::int AS nodes, COALESCE(nc.active, 0)::int AS active_nodes, COALESCE(nc.online, 0)::int AS online_nodes,
  COALESCE(a.pending_musd, 0)::text AS credit_pending, COALESCE(a.available_musd, 0)::text AS credit_available,
  COALESCE(a.frozen, false) AS frozen, w.balance_cents AS wallet_cents`;

const AGENT_FROM = `FROM ids JOIN users u ON u.id = ids.uid
  LEFT JOIN spend ON spend.uid = u.id LEFT JOIN earn ON earn.uid = u.id LEFT JOIN nc ON nc.uid = u.id
  LEFT JOIN node_credit_accounts a ON a.user_id = u.id LEFT JOIN wallets w ON w.user_id = u.id
  LEFT JOIN node_tiers t ON t.id = u.node_tier_id`;

interface AgentRow {
  id: string; email: string | null; wallet_address: string | null; status: string; created_at: Date; tier: string | null;
  node_tier_id: number | null; spend_total: string; spend_30d: string; bytes_total: string; last_request_at: Date | null;
  earn_total: string; earn_30d: string; nodes: number; active_nodes: number; online_nodes: number;
  credit_pending: string; credit_available: string; frozen: boolean; wallet_cents: number | null;
}

function agentOut(a: AgentRow) {
  return {
    userId: a.id, email: a.email, walletAddress: a.wallet_address, status: a.status, createdAt: a.created_at,
    tier: a.tier, tierId: a.node_tier_id,
    isRequester: a.spend_total !== "0" || a.last_request_at !== null, isNodeOwner: a.nodes > 0,
    spend: money(a.spend_total), spend30d: money(a.spend_30d), bytesRequested: a.bytes_total, gbRequested: gb(a.bytes_total),
    lastRequestAt: a.last_request_at,
    earnings: money(a.earn_total), earnings30d: money(a.earn_30d),
    nodes: a.nodes, activeNodes: a.active_nodes, onlineNodes: a.online_nodes,
    credits: { pending: money(a.credit_pending), available: money(a.credit_available), frozen: a.frozen },
    walletBalance: a.wallet_cents === null ? null : money(BigInt(a.wallet_cents) * 10_000n),
  };
}

const AGENT_SORTS = {
  spend: "COALESCE(spend.total, 0)", spend_30d: "COALESCE(spend.d30, 0)", earnings: "COALESCE(earn.total, 0)",
  earnings_30d: "COALESCE(earn.d30, 0)", nodes: "COALESCE(nc.nodes, 0)", created: "u.created_at", last_request: "spend.last_at",
} as const;

router.get("/agents", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req);
    const role = enumParam(req, "role", ["requester", "node_owner"] as const);
    const frozen = boolParam(req, "frozen");
    const status = enumParam(req, "status", ["active", "suspended", "deleted"] as const);
    const tierId = intParam(req, "tier", 1, 100);
    const search = searchParam(req);
    const sort = enumParam(req, "sort", Object.keys(AGENT_SORTS) as Array<keyof typeof AGENT_SORTS>) ?? "spend";
    const order = enumParam(req, "order", ["asc", "desc"] as const) ?? "desc";
    const params: unknown[] = [
      role ?? null, frozen ?? null, status ?? null, tierId ?? null,
      search === undefined ? null : `%${likeEscape(search.toLowerCase())}%`,
    ];
    const where = `WHERE ($1::text IS NULL OR ($1 = 'requester' AND spend.uid IS NOT NULL) OR ($1 = 'node_owner' AND COALESCE(nc.nodes, 0) > 0))
      AND ($2::boolean IS NULL OR COALESCE(a.frozen, false) = $2) AND ($3::text IS NULL OR u.status = $3)
      AND ($4::int IS NULL OR u.node_tier_id = $4)
      AND ($5::text IS NULL OR lower(u.email) LIKE $5 OR lower(COALESCE(u.wallet_address, '')) LIKE $5 OR u.id::text LIKE $5)`;
    const r = await q<AgentRow & { total: string }>(
      `${AGENT_CTE}
       SELECT ${AGENT_COLS}, COUNT(*) OVER ()::text AS total ${AGENT_FROM} ${where}
       ORDER BY ${AGENT_SORTS[sort]} ${order === "asc" ? "ASC" : "DESC"} NULLS LAST, u.id
       LIMIT $6 OFFSET $7`, [...params, limit, offset]);
    res.json({ limit, offset, total: Number(r.rows[0]?.total ?? 0), items: r.rows.map(agentOut) });
  } catch (err) { fail(res, err, "Agent list"); }
});

router.get("/agents/:id", async (req: Request, res: Response) => {
  try {
    const id = uuidPath(req);
    const r = await q<AgentRow>(`${AGENT_CTE} SELECT ${AGENT_COLS} ${AGENT_FROM} WHERE u.id = $1`, [id]);
    const a = r.rows[0];
    if (!a) throw new HttpError(404, "Agent not found");
    const [nodes, acct, payouts, txs, rails] = await Promise.all([
      q<NodeRow>(`SELECT ${NODE_SELECT} FROM nodes n WHERE n.owner_user_id = $1 ORDER BY n.created_at DESC LIMIT 100`, [id]),
      q<{ auto_convert_pct: number; tax_form_status: string; tax_form_type: string | null; tax_year: number | null; ytd_paid_musd: string; updated_at: Date }>(
        `SELECT auto_convert_pct, tax_form_status, tax_form_type, tax_year, ytd_paid_musd::text AS ytd_paid_musd, updated_at
         FROM node_credit_accounts WHERE user_id = $1`, [id]),
      q<PayoutRow>(`SELECT ${PAYOUT_COLS} ${PAYOUT_FROM} WHERE p.user_id = $1 ORDER BY p.created_at DESC LIMIT 20`, [id]),
      q<{ id: string; type: string; amount_musd: string; relay_charge_id: string | null; external_ref: string | null; created_by: string | null; created_at: Date }>(
        `SELECT id::text AS id, type, amount_musd::text AS amount_musd, relay_charge_id, external_ref, created_by, created_at
         FROM node_credit_transactions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`, [id]),
      q<{ rail: string; gross: string; bytes: string; charges: string }>(
        `SELECT payment_rail AS rail, SUM(gross_musd)::text AS gross, SUM(bytes_gateway)::text AS bytes, COUNT(*)::text AS charges
         FROM relay_charges WHERE requester_user_id = $1 AND created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`, [id]),
    ]);
    const ac = acct.rows[0];
    res.json({
      agent: agentOut(a),
      creditAccount: ac ? {
        autoConvertPct: ac.auto_convert_pct, taxFormStatus: ac.tax_form_status, taxFormType: ac.tax_form_type,
        taxYear: ac.tax_year, ytdPaid: money(ac.ytd_paid_musd), updatedAt: ac.updated_at,
      } : null,
      nodes: nodes.rows.map(nodeOut),
      recentPayouts: payouts.rows.map(payoutOut),
      recentCreditTransactions: txs.rows.map((t) => ({
        id: t.id, type: t.type, amount: money(t.amount_musd), relayChargeId: t.relay_charge_id,
        externalRef: t.external_ref, createdBy: t.created_by, createdAt: t.created_at,
      })),
      spendByRail30d: rails.rows.map((x) => ({ rail: x.rail, gross: money(x.gross), bytes: x.bytes, gb: gb(x.bytes), charges: Number(x.charges) })),
    });
  } catch (err) { fail(res, err, "Agent detail"); }
});

// ─── Credit accounts ────────────────────────────────────────────────

const ACCOUNT_SORTS = { available: "a.available_musd", pending: "a.pending_musd", updated: "a.updated_at" } as const;

router.get("/credits/accounts", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req);
    const frozen = boolParam(req, "frozen");
    const user = uuidParam(req, "userId");
    const sort = enumParam(req, "sort", Object.keys(ACCOUNT_SORTS) as Array<keyof typeof ACCOUNT_SORTS>) ?? "available";
    const params = [frozen ?? null, user ?? null];
    const where = `WHERE ($1::boolean IS NULL OR a.frozen = $1) AND ($2::uuid IS NULL OR a.user_id = $2)`;
    const [rows, total] = await Promise.all([
      q<{ user_id: string; email: string | null; wallet_address: string | null; pending_musd: string; available_musd: string; frozen: boolean; auto_convert_pct: number; tax_form_status: string; ytd_paid_musd: string; updated_at: Date; held_payouts: string }>(
        `SELECT a.user_id, u.email, u.wallet_address, a.pending_musd::text AS pending_musd, a.available_musd::text AS available_musd,
                a.frozen, a.auto_convert_pct, a.tax_form_status, a.ytd_paid_musd::text AS ytd_paid_musd, a.updated_at,
                (SELECT COALESCE(SUM(p.amount_musd), 0) FROM node_payouts p WHERE p.user_id = a.user_id AND p.status IN ('held_tax','held_frozen'))::text AS held_payouts
         FROM node_credit_accounts a LEFT JOIN users u ON u.id = a.user_id ${where}
         ORDER BY ${ACCOUNT_SORTS[sort]} DESC, a.user_id LIMIT $3 OFFSET $4`, [...params, limit, offset]),
      q<{ count: string }>(`SELECT COUNT(*)::text AS count FROM node_credit_accounts a ${where}`, params),
    ]);
    res.json({
      limit, offset, total: Number(total.rows[0]?.count ?? 0),
      items: rows.rows.map((a) => ({
        userId: a.user_id, email: a.email, walletAddress: a.wallet_address, pending: money(a.pending_musd),
        available: money(a.available_musd), frozen: a.frozen, autoConvertPct: a.auto_convert_pct,
        taxFormStatus: a.tax_form_status, ytdPaid: money(a.ytd_paid_musd), heldPayouts: money(a.held_payouts), updatedAt: a.updated_at,
      })),
    });
  } catch (err) { fail(res, err, "Credit account list"); }
});

router.post("/accounts/:userId/freeze", async (req: Request, res: Response) => {
  try {
    const target = uuidPath(req, "userId");
    const reason = reasonField(body(req), true);
    const out = await withAdminTx(adminId(req), async (c) => {
      const u = await c.query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [target]);
      if (!u.rows[0]) throw new HttpError(404, "User not found");
      const prev = await c.query<{ frozen: boolean }>(`SELECT frozen FROM node_credit_accounts WHERE user_id = $1`, [target]);
      const held = await payoutRepo.freezeAccountTx(c as unknown as Parameters<typeof payoutRepo.freezeAccountTx>[0], target);
      await audit(c, req, "node_credit_freeze", "node_credit_account", target, { reason, heldPayouts: held, wasFrozen: prev.rows[0]?.frozen ?? false });
      return { held, wasFrozen: prev.rows[0]?.frozen ?? false };
    });
    log.info("node credit account frozen", { target, heldPayouts: out.held, by: adminId(req) });
    res.json({ userId: target, frozen: true, wasFrozen: out.wasFrozen, heldPayouts: out.held });
  } catch (err) { fail(res, err, "Account freeze"); }
});

// ─── Payouts ────────────────────────────────────────────────────────

const PAYOUT_STATUSES = ["pending", "held_tax", "held_frozen", "submitted", "confirmed", "failed", "reversed"] as const;
const PAYOUT_COLS = `p.id, p.user_id, u.email, p.amount_musd::text AS amount_musd, p.trigger, p.status, p.batch_id, p.tx_hash,
  p.failure_reason, p.created_at, p.updated_at, w.address AS wallet_address, w.chain, w.status AS wallet_status`;
const PAYOUT_FROM = `FROM node_payouts p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN payout_wallets w ON w.id = p.payout_wallet_id`;

interface PayoutRow {
  id: string; user_id: string | null; email: string | null; amount_musd: string; trigger: string; status: string;
  batch_id: string | null; tx_hash: string | null; failure_reason: string | null; created_at: Date; updated_at: Date;
  wallet_address: string | null; chain: string | null; wallet_status: string | null;
}

function payoutOut(p: PayoutRow) {
  return {
    id: p.id, userId: p.user_id, email: p.email, amount: money(p.amount_musd), trigger: p.trigger, status: p.status,
    batchId: p.batch_id, txHash: p.tx_hash, failureReason: p.failure_reason, createdAt: p.created_at, updatedAt: p.updated_at,
    payoutWallet: p.wallet_address ? { address: p.wallet_address, chain: p.chain, status: p.wallet_status } : null,
  };
}

router.get("/payouts", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req);
    const status = enumParam(req, "status", PAYOUT_STATUSES);
    const user = uuidParam(req, "userId");
    const from = dateParam(req, "from");
    const to = dateParam(req, "to");
    const params = [status ?? null, user ?? null, from?.toISOString() ?? null, to?.toISOString() ?? null];
    const where = `WHERE ($1::text IS NULL OR p.status = $1) AND ($2::uuid IS NULL OR p.user_id = $2)
      AND ($3::timestamptz IS NULL OR p.created_at >= $3) AND ($4::timestamptz IS NULL OR p.created_at < $4)`;
    const [rows, total] = await Promise.all([
      q<PayoutRow>(`SELECT ${PAYOUT_COLS} ${PAYOUT_FROM} ${where} ORDER BY p.created_at DESC, p.id LIMIT $5 OFFSET $6`, [...params, limit, offset]),
      q<{ count: string; musd: string }>(`SELECT COUNT(*)::text AS count, COALESCE(SUM(p.amount_musd), 0)::text AS musd FROM node_payouts p ${where}`, params),
    ]);
    res.json({
      limit, offset, total: Number(total.rows[0]?.count ?? 0), totalAmount: money(total.rows[0]?.musd),
      items: rows.rows.map(payoutOut),
    });
  } catch (err) { fail(res, err, "Payout list"); }
});

router.post("/payouts/:id/reverse", async (req: Request, res: Response) => {
  try {
    const id = uuidPath(req);
    const reason = reasonField(body(req), true, 200)!;
    // Role re-check, reversal (FOR UPDATE on the payout + account), re-credit and
    // audit all run in the one admin tx and commit or roll back together.
    const p = await withAdminTx(adminId(req), async (c: TxClient) => {
      let r;
      try {
        r = await payoutRepo.markPayoutReversedTx(
          c as unknown as Parameters<typeof payoutRepo.markPayoutReversedTx>[0], id, `admin: ${reason}`);
      } catch (err) {
        const m = err instanceof Error ? err.message : "";
        if (m === "Payout not found") throw new HttpError(404, m);
        if (m.startsWith("Cannot reverse")) throw new HttpError(409, m.slice(0, 200));
        throw err;
      }
      await audit(c, req, "node_payout_reverse", "node_payout", id, { reason, userId: r.userId, amountMusd: r.amountMusd.toString() });
      return r;
    });
    log.info("payout reversed", { payoutId: id, by: adminId(req) });
    res.json({ id: p.id, userId: p.userId, status: p.status, amount: money(p.amountMusd), txHash: p.txHash });
  } catch (err) { fail(res, err, "Payout reverse"); }
});

// ─── Byte disputes ──────────────────────────────────────────────────

const DISPUTE_STATUSES = ["open", "resolved_gateway", "resolved_node", "dismissed"] as const;

router.get("/disputes", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req);
    const status = enumParam(req, "status", DISPUTE_STATUSES);
    const node = uuidParam(req, "nodeId");
    const params = [status ?? null, node ?? null];
    const where = `WHERE ($1::text IS NULL OR d.status = $1) AND ($2::uuid IS NULL OR d.node_id = $2)`;
    const [rows, total] = await Promise.all([
      q<{ id: string; relay_charge_id: string | null; node_id: string | null; owner_user_id: string | null; bytes_gateway: string; bytes_node: string; status: string; created_at: Date; resolved_at: Date | null; gross_musd: string | null; node_musd: string | null; payment_rail: string | null; requester_user_id: string | null }>(
        `SELECT d.id::text AS id, d.relay_charge_id, d.node_id, n.owner_user_id, d.bytes_gateway::text AS bytes_gateway,
                d.bytes_node::text AS bytes_node, d.status, d.created_at, d.resolved_at,
                rc.gross_musd::text AS gross_musd, rc.node_musd::text AS node_musd, rc.payment_rail, rc.requester_user_id
         FROM byte_disputes d LEFT JOIN nodes n ON n.id = d.node_id LEFT JOIN relay_charges rc ON rc.id = d.relay_charge_id
         ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT $3 OFFSET $4`, [...params, limit, offset]),
      q<{ count: string }>(`SELECT COUNT(*)::text AS count FROM byte_disputes d ${where}`, params),
    ]);
    res.json({
      limit, offset, total: Number(total.rows[0]?.count ?? 0),
      items: rows.rows.map((d) => {
        const g = BigInt(d.bytes_gateway);
        const n = BigInt(d.bytes_node);
        const diff = g > n ? g - n : n - g;
        return {
          id: d.id, relayChargeId: d.relay_charge_id, nodeId: d.node_id, nodeOwnerUserId: d.owner_user_id,
          requesterUserId: d.requester_user_id, paymentRail: d.payment_rail,
          bytesGateway: d.bytes_gateway, bytesNode: d.bytes_node, bytesDiff: diff.toString(),
          diffBps: g === 0n ? null : Number((diff * 10_000n) / g),
          gross: d.gross_musd === null ? null : money(d.gross_musd), nodeShare: d.node_musd === null ? null : money(d.node_musd),
          status: d.status, createdAt: d.created_at, resolvedAt: d.resolved_at,
        };
      }),
    });
  } catch (err) { fail(res, err, "Dispute list"); }
});

const RESOLUTIONS = ["resolved_gateway", "resolved_node", "dismissed"] as const;

router.post("/disputes/:id/resolve", async (req: Request, res: Response) => {
  try {
    const raw = String(req.params["id"] ?? "");
    if (!/^\d{1,18}$/.test(raw)) throw new HttpError(400, "Invalid id");
    const b = body(req);
    const resolution = b["resolution"];
    if (typeof resolution !== "string" || !(RESOLUTIONS as readonly string[]).includes(resolution)) {
      throw new HttpError(400, `resolution must be one of ${RESOLUTIONS.join("|")}`);
    }
    const reason = reasonField(b, false);
    const out = await withAdminTx(adminId(req), async (c) => {
      const d = await c.query<{ status: string; relay_charge_id: string | null; node_id: string | null }>(
        `SELECT status, relay_charge_id, node_id FROM byte_disputes WHERE id = $1 FOR UPDATE`, [raw]);
      const row = d.rows[0];
      if (!row) throw new HttpError(404, "Dispute not found");
      if (row.status !== "open") throw new HttpError(409, `Dispute already ${row.status}`);
      await c.query(`UPDATE byte_disputes SET status = $2, resolved_at = now() WHERE id = $1`, [raw, resolution]);
      // Gateway count upheld or dispute dismissed: release the charge so its node share can mature.
      // resolved_node: re-split the charge at the node's byte count first (claw back the node
      // share difference, refund the requester), then release what is left the same way.
      let chargeReleased = false;
      let resplit: Awaited<ReturnType<typeof disputeResolutionRepo.resplitAtNodeBytesTx>> | null = null;
      if (row.relay_charge_id && resolution === "resolved_node") {
        resplit = await disputeResolutionRepo.resplitAtNodeBytesTx(c as never, row.relay_charge_id, adminId(req));
      }
      if (row.relay_charge_id) {
        const open = await c.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM byte_disputes WHERE relay_charge_id = $1 AND status = 'open' AND id <> $2`,
          [row.relay_charge_id, raw]);
        if (Number(open.rows[0]?.n ?? 0) === 0) {
          await c.query(`UPDATE relay_charges SET disputed = false WHERE id = $1`, [row.relay_charge_id]);
          chargeReleased = true;
        }
      }
      const adjustment = resplit && resplit.adjusted ? {
        grossBefore: resplit.grossBeforeMusd.toString(), grossAfter: resplit.grossAfterMusd.toString(),
        nodeClawbackMusd: resplit.nodeClawbackMusd.toString(), refundCents: resplit.refundCents,
        overflowCents: resplit.overflowCents, unrefundedMusd: resplit.unrefundedMusd.toString(),
      } : null;
      await audit(c, req, "byte_dispute_resolve", "byte_dispute", raw, { resolution, reason, relayChargeId: row.relay_charge_id, nodeId: row.node_id, chargeReleased, adjustment });
      return { chargeReleased, relayChargeId: row.relay_charge_id, adjustment };
    });
    res.json({ id: raw, status: resolution, relayChargeId: out.relayChargeId, chargeReleased: out.chargeReleased, adjustment: out.adjustment });
  } catch (err) { fail(res, err, "Dispute resolve"); }
});

// ─── Abuse log (metadata only) ──────────────────────────────────────

const ABUSE_MAX_WINDOW_MS = 31 * 86_400_000;

router.get("/abuse-log", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req);
    const node = uuidParam(req, "nodeId");
    const requester = uuidParam(req, "requesterId");
    const host = searchParam(req, "host", 253);
    if (host !== undefined && !/^[a-z0-9.\-:[\]]+$/i.test(host)) throw new HttpError(400, "host must be a hostname or IP");
    const to = dateParam(req, "to") ?? new Date();
    const from = dateParam(req, "from") ?? new Date(to.getTime() - 86_400_000);
    if (from.getTime() >= to.getTime()) throw new HttpError(400, "from must be before to");
    if (to.getTime() - from.getTime() > ABUSE_MAX_WINDOW_MS) throw new HttpError(400, "window must be at most 31 days");
    let retentionDays = 90;
    try {
      const d = (await policyRepo.getActivePolicy()).body.logRetentionDays;
      if (Number.isInteger(d) && d > 0 && d < retentionDays) retentionDays = d;
    } catch { /* default retention */ }
    const params = [
      from.toISOString(), to.toISOString(), retentionDays, node ?? null, requester ?? null, host?.toLowerCase() ?? null,
    ];
    const where = `WHERE l.ts >= $1 AND l.ts < $2 AND l.ts >= now() - make_interval(days => $3)
      AND ($4::uuid IS NULL OR l.node_id = $4) AND ($5::uuid IS NULL OR l.requester_user_id = $5)
      AND ($6::text IS NULL OR l.dest_host = $6)`;
    // Every access is audited (DESIGN.md §10) in the same tx as the read.
    const out = await withAdminTx(adminId(req), async (c) => {
      await audit(c, req, "relay_abuse_log_access", "relay_abuse_log", node ?? requester ?? host ?? "all", {
        from: from.toISOString(), to: to.toISOString(), nodeId: node ?? null, requesterId: requester ?? null, host: host ?? null, limit, offset,
      });
      const rows = await c.query<{ id: string; ts: Date; session_id: string; requester_user_id: string; node_id: string; dest_host: string; dest_port: number; bytes: string }>(
        `SELECT l.id::text AS id, l.ts, l.session_id, l.requester_user_id, l.node_id, l.dest_host, l.dest_port, l.bytes::text AS bytes
         FROM relay_abuse_log l ${where} ORDER BY l.ts DESC, l.id DESC LIMIT $7 OFFSET $8`, [...params, limit, offset]);
      const total = await c.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM relay_abuse_log l ${where}`, params);
      return { rows: rows.rows, total: Number(total.rows[0]?.count ?? 0) };
    });
    res.json({
      from: from.toISOString(), to: to.toISOString(), retentionDays, limit, offset, total: out.total,
      items: out.rows.map((l) => ({
        id: l.id, ts: l.ts, sessionId: l.session_id, requesterUserId: l.requester_user_id, nodeId: l.node_id,
        destHost: l.dest_host, destPort: l.dest_port, bytes: l.bytes,
      })),
    });
  } catch (err) { fail(res, err, "Abuse log"); }
});

export default router;
