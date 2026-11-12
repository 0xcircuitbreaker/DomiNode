import { Router } from "express";
import type { Request, Response } from "express";
import { createLogger, getPool, starterCreditRepo, genesisRepo, networkStatusRepo, rpcUrlFromEnv } from "@dominusnode/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { HttpError, fail, money, page, enumParam, uuidParam, withAdminTx, audit, adminId, UUID_RE } from "./admin-network-common.js";

/**
 * Launch-readiness admin controls (docs/agent-network/ADMIN_API.md §14):
 * seed nodes, starter credits, genesis boost, buyer discounts, incidents,
 * unmet demand, abuse reports and the contribution allowlist.
 * Mounted at /api/admin/network.
 */
const log = createLogger("api:admin-network-launch");
const router = Router();
router.use(requireAuth, requireAdmin);

export const q = <R>(sql: string, params: unknown[] = []) =>
  getPool().query(sql, params) as unknown as Promise<{ rows: R[] }>;

export function body(req: Request): Record<string, unknown> {
  const b = req.body ?? {};
  if (typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "Body must be an object");
  return b as Record<string, unknown>;
}

const PRINTABLE = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

export function optText(v: unknown, name: string, max: number, required = false): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${name} is required`);
    return null;
  }
  if (typeof v !== "string" || v.length > max || !PRINTABLE.test(v)) throw new HttpError(400, `${name} must be at most ${max} printable chars`);
  return v;
}

function idParam(req: Request): string {
  const id = String(req.params["id"] ?? "");
  if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a UUID");
  return id;
}

// ─── Seed nodes (operator_run) ──────────────────────────────────────

// POST /nodes/:id/operator-run {operatorRun: boolean, reason?}
router.post("/nodes/:id/operator-run", async (req: Request, res: Response) => {
  try {
    const id = idParam(req);
    const b = body(req);
    if (typeof b["operatorRun"] !== "boolean") throw new HttpError(400, "operatorRun must be a boolean");
    const reason = optText(b["reason"], "reason", 500);
    const value = b["operatorRun"];
    const out = await withAdminTx(adminId(req), async (c) => {
      const r = await c.query<{ id: string; prev: boolean }>(
        `UPDATE nodes n SET operator_run = $2 FROM (SELECT id, operator_run AS prev FROM nodes WHERE id = $1 FOR UPDATE) o
         WHERE n.id = o.id RETURNING n.id, o.prev`,
        [id, value],
      );
      const row = r.rows[0];
      if (!row) throw new HttpError(404, "Node not found");
      await audit(c, req, "node_operator_run_set", "node", id, { operatorRun: value, previous: row.prev, reason });
      return row;
    });
    log.info("node operator_run set", { nodeId: id, operatorRun: value, by: adminId(req) });
    res.json({ nodeId: out.id, operatorRun: value, previous: out.prev, gatewayEffect: "next_tunnel_reconnect" });
  } catch (err) { fail(res, err, "Operator-run update"); }
});

// GET /seed-summary — seed vs community counts and paid traffic (24h, 30d)
router.get("/seed-summary", async (_req: Request, res: Response) => {
  try {
    const [nodes, traffic] = await Promise.all([
      q<{ operator_run: boolean; total: string; online: string; countries: string; asns: string }>(
        `SELECT operator_run, COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE status = 'active' AND last_seen_at > now() - interval '5 minutes')::text AS online,
                COUNT(DISTINCT country)::text AS countries, COUNT(DISTINCT asn)::text AS asns
         FROM nodes WHERE status <> 'revoked' GROUP BY operator_run`,
      ),
      q<{ operator_run: boolean; bytes_24h: string | null; gross_24h: string | null; bytes_30d: string | null; gross_30d: string | null }>(
        `SELECT n.operator_run,
                SUM(rc.bytes_gateway) FILTER (WHERE rc.created_at > now() - interval '24 hours')::text AS bytes_24h,
                SUM(rc.gross_musd)    FILTER (WHERE rc.created_at > now() - interval '24 hours')::text AS gross_24h,
                SUM(rc.bytes_gateway)::text AS bytes_30d, SUM(rc.gross_musd)::text AS gross_30d
         FROM relay_charges rc JOIN nodes n ON n.id = rc.node_id
         WHERE rc.created_at > now() - interval '30 days' AND rc.gross_musd > 0
         GROUP BY n.operator_run`,
      ),
    ]);
    const empty = () => ({ total: 0, online: 0, countries: 0, asns: 0, paidBytes24h: "0", paid24h: money(0), paidBytes30d: "0", paid30d: money(0) });
    const out = { seed: empty(), community: empty() };
    for (const r of nodes.rows) {
      const k = r.operator_run ? "seed" : "community";
      Object.assign(out[k], { total: Number(r.total), online: Number(r.online), countries: Number(r.countries), asns: Number(r.asns) });
    }
    for (const r of traffic.rows) {
      const k = r.operator_run ? "seed" : "community";
      Object.assign(out[k], {
        paidBytes24h: r.bytes_24h ?? "0", paid24h: money(r.gross_24h), paidBytes30d: r.bytes_30d ?? "0", paid30d: money(r.gross_30d),
      });
    }
    res.json(out);
  } catch (err) { fail(res, err, "Seed summary"); }
});

// ─── Singleton settings helper ──────────────────────────────────────

type FieldSpec = [col: string, kind: "int" | "musd" | "bool", min: bigint, max: bigint];

/**
 * Validate a PATCH-style body against `spec` and UPDATE the singleton row
 * `table` (id = 1) in an admin transaction with an audit row.
 */
async function updateSingleton(req: Request, table: string, action: string, spec: Record<string, FieldSpec>,
  check?: (b: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
  const b = body(req);
  for (const k of Object.keys(b)) if (!(k in spec)) throw new HttpError(400, `${k}: unknown field`);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const changes: Record<string, unknown> = {};
  for (const [k, [col, kind, min, max]] of Object.entries(spec)) {
    const v = b[k];
    if (v === undefined) continue;
    if (kind === "bool") {
      if (typeof v !== "boolean") throw new HttpError(400, `${k} must be a boolean`);
      vals.push(v);
    } else if (kind === "int") {
      if (typeof v !== "number" || !Number.isInteger(v) || BigInt(v) < min || BigInt(v) > max) throw new HttpError(400, `${k} must be an integer in [${min}, ${max}]`);
      vals.push(v);
    } else {
      if (typeof v !== "string" || !/^\d{1,15}$/.test(v) || BigInt(v) < min || BigInt(v) > max) throw new HttpError(400, `${k} must be a digit string in [${min}, ${max}]`);
      vals.push(v);
    }
    sets.push(`${col} = $${vals.length}${kind === "musd" ? "::bigint" : ""}`);
    changes[k] = v;
  }
  if (sets.length === 0) throw new HttpError(400, "No fields to update");
  check?.(b);
  await withAdminTx(adminId(req), async (c) => {
    // table names are compile-time constants from this file, never user input
    await c.query(`INSERT INTO ${table} (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    vals.push(adminId(req));
    await c.query(`UPDATE ${table} SET ${sets.join(", ")}, updated_by = $${vals.length}, updated_at = now() WHERE id = 1`, vals);
    await audit(c, req, action, table, "1", changes);
  });
  log.info(`${table} updated`, { by: adminId(req), fields: Object.keys(changes) });
  return changes;
}

// ─── Starter credits ────────────────────────────────────────────────

function starterOut(s: Awaited<ReturnType<typeof starterCreditRepo.getSettings>>) {
  return {
    enabled: s.enabled, amount: money(s.amountMusd.toString()), dailyBudget: money(s.dailyBudgetMusd.toString()),
    perPrefixCap: s.perPrefixCap, perFundingSourceCap: s.perFundingSourceCap, capWindowDays: s.capWindowDays,
    expiryDays: s.expiryDays, seedNodesOnly: s.seedNodesOnly, seedOnlyDays: s.seedOnlyDays,
    requireFunding: s.requireFunding, minTopupCents: s.minTopupCents, rpcConfigured: rpcUrlFromEnv() !== null,
    updatedBy: s.updatedBy, updatedAt: s.updatedAt,
  };
}

router.get("/starter-credits/settings", async (_req: Request, res: Response) => {
  try {
    const [s, today] = await Promise.all([
      starterCreditRepo.getSettings(),
      q<{ musd: string | null; n: string }>(
        `SELECT SUM(amount_musd)::text AS musd, COUNT(*)::text AS n FROM starter_credit_grants
         WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      ),
    ]);
    res.json({ ...starterOut(s), grantedToday: { count: Number(today.rows[0]?.n ?? 0), amount: money(today.rows[0]?.musd ?? 0) } });
  } catch (err) { fail(res, err, "Starter credit settings"); }
});

const STARTER_SPEC: Record<string, FieldSpec> = {
  enabled: ["enabled", "bool", 0n, 0n],
  amountMusd: ["amount_musd", "musd", 10_000n, 100_000_000n],
  dailyBudgetMusd: ["daily_budget_musd", "musd", 0n, 100_000_000_000n],
  perPrefixCap: ["per_prefix_cap", "int", 0n, 1000n],
  perFundingSourceCap: ["per_funding_source_cap", "int", 0n, 1000n],
  capWindowDays: ["cap_window_days", "int", 1n, 3650n],
  expiryDays: ["expiry_days", "int", 1n, 365n],
  seedNodesOnly: ["seed_nodes_only", "bool", 0n, 0n],
  seedOnlyDays: ["seed_only_days", "int", 0n, 365n],
  requireFunding: ["require_funding", "bool", 0n, 0n],
  minTopupCents: ["min_topup_cents", "int", 1n, 100_000n],
};

router.put("/starter-credits/settings", async (req: Request, res: Response) => {
  try {
    await updateSingleton(req, "starter_credit_settings", "starter_credit_settings_update", STARTER_SPEC, (b) => {
      if (typeof b["amountMusd"] === "string" && BigInt(b["amountMusd"]) % 10_000n !== 0n) {
        throw new HttpError(400, "amountMusd must be whole cents (a multiple of 10000)");
      }
    });
    res.json(starterOut(await starterCreditRepo.getSettings()));
  } catch (err) { fail(res, err, "Starter credit settings update"); }
});

const GRANT_STATUSES = ["active", "exhausted", "expired", "revoked"] as const;

router.get("/starter-credits/grants", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req);
    const status = enumParam(req, "status", GRANT_STATUSES) ?? null;
    const user = uuidParam(req, "userId") ?? null;
    const where = `WHERE ($1::text IS NULL OR g.status = $1) AND ($2::uuid IS NULL OR g.user_id = $2)`;
    const [rows, total] = await Promise.all([
      q<{ id: string; user_id: string; wallet_address: string | null; amount_musd: string; remaining_musd: string; ip_prefix: string | null;
          status: string; expires_at: Date; created_at: Date; closed_at: Date | null }>(
        `SELECT g.id, g.user_id, u.wallet_address, g.amount_musd::text AS amount_musd, g.remaining_musd::text AS remaining_musd,
                host(g.ip_prefix) || '/' || masklen(g.ip_prefix) AS ip_prefix, g.status, g.expires_at, g.created_at, g.closed_at
         FROM starter_credit_grants g LEFT JOIN users u ON u.id = g.user_id ${where}
         ORDER BY g.created_at DESC, g.id LIMIT $3 OFFSET $4`, [status, user, limit, offset]),
      q<{ count: string }>(`SELECT COUNT(*)::text AS count FROM starter_credit_grants g ${where}`, [status, user]),
    ]);
    res.json({
      limit, offset, total: Number(total.rows[0]?.count ?? 0),
      items: rows.rows.map((g) => ({
        id: g.id, userId: g.user_id, walletAddress: g.wallet_address, amount: money(g.amount_musd), remaining: money(g.remaining_musd),
        ipPrefix: g.ip_prefix, status: g.status, expiresAt: g.expires_at, createdAt: g.created_at, closedAt: g.closed_at,
      })),
    });
  } catch (err) { fail(res, err, "Starter credit grants"); }
});

// POST /starter-credits/grants/:id/revoke {reason}
router.post("/starter-credits/grants/:id/revoke", async (req: Request, res: Response) => {
  try {
    const id = idParam(req);
    const reason = optText(body(req)["reason"], "reason", 500, true);
    const out = await withAdminTx(adminId(req), async (c) => {
      const r = await starterCreditRepo.closeGrantTx(c as never, id, "revoked", adminId(req));
      if (!r) throw new HttpError(404, "Active grant not found");
      await audit(c, req, "starter_credit_revoke", "starter_credit_grant", id, { reason, removedCents: r.removedCents.toString() });
      return r;
    });
    res.json({ id, status: "revoked", removed: money(out.removedCents * 10_000n) });
  } catch (err) { fail(res, err, "Starter credit revoke"); }
});

// ─── Genesis boost ──────────────────────────────────────────────────

function genesisOut(s: Awaited<ReturnType<typeof genesisRepo.getSettings>>) {
  return {
    enabled: s.enabled, maxOwners: s.maxOwners, bonusBps: s.bonusBps, boostDays: s.boostDays,
    credit: money(s.creditMusd.toString()), creditThresholdBytes: s.creditThresholdBytes.toString(),
    minDistinctPayers: s.minDistinctPayers,
    updatedBy: s.updatedBy, updatedAt: s.updatedAt,
  };
}

router.get("/genesis/settings", async (_req: Request, res: Response) => {
  try {
    const [s, n] = await Promise.all([genesisRepo.getSettings(), q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM genesis_members`)]);
    res.json({ ...genesisOut(s), members: Number(n.rows[0]?.n ?? 0) });
  } catch (err) { fail(res, err, "Genesis settings"); }
});

const GENESIS_SPEC: Record<string, FieldSpec> = {
  enabled: ["enabled", "bool", 0n, 0n],
  maxOwners: ["max_owners", "int", 0n, 100_000n],
  bonusBps: ["bonus_bps", "int", 0n, 5000n],
  boostDays: ["boost_days", "int", 1n, 3650n],
  creditMusd: ["credit_musd", "musd", 0n, 1_000_000_000n],
  creditThresholdBytes: ["credit_threshold_bytes", "musd", 0n, 1_000_000_000_000_000n],
  minDistinctPayers: ["min_distinct_payers", "int", 1n, 1000n],
};

router.put("/genesis/settings", async (req: Request, res: Response) => {
  try {
    await updateSingleton(req, "genesis_settings", "genesis_settings_update", GENESIS_SPEC);
    res.json(genesisOut(await genesisRepo.getSettings()));
  } catch (err) { fail(res, err, "Genesis settings update"); }
});

router.get("/genesis/members", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req);
    const [rows, total] = await Promise.all([
      q<{ owner_user_id: string; wallet_address: string | null; seq: number; enrolled_at: Date; boost_until: Date; credit_status: string;
          credit_musd: string | null; credit_granted_at: Date | null; credit_matures_at: Date | null; qualifying_bytes: string }>(
        `SELECT m.owner_user_id, u.wallet_address, m.seq, m.enrolled_at, m.boost_until, m.credit_status,
                m.credit_musd::text AS credit_musd, m.credit_granted_at, m.credit_matures_at,
                (SELECT COALESCE(SUM(rc.bytes_gateway), 0) FROM relay_charges rc
                  WHERE rc.node_owner_user_id = m.owner_user_id AND rc.matured AND NOT rc.disputed AND rc.node_musd > 0
                    AND rc.starter_musd = 0 AND rc.requester_user_id IS DISTINCT FROM m.owner_user_id)::text AS qualifying_bytes
         FROM genesis_members m LEFT JOIN users u ON u.id = m.owner_user_id
         ORDER BY m.seq LIMIT $1 OFFSET $2`, [limit, offset]),
      q<{ count: string }>(`SELECT COUNT(*)::text AS count FROM genesis_members`),
    ]);
    res.json({
      limit, offset, total: Number(total.rows[0]?.count ?? 0),
      items: rows.rows.map((r) => ({
        ownerUserId: r.owner_user_id, walletAddress: r.wallet_address, seq: r.seq, enrolledAt: r.enrolled_at, boostUntil: r.boost_until,
        creditStatus: r.credit_status, credit: r.credit_musd ? money(r.credit_musd) : null, creditGrantedAt: r.credit_granted_at,
        creditMaturesAt: r.credit_matures_at, qualifyingBytes: r.qualifying_bytes,
      })),
    });
  } catch (err) { fail(res, err, "Genesis members"); }
});

// POST /genesis/members/:id/clawback {reason} — claw back a still-held genesis credit
router.post("/genesis/members/:id/clawback", async (req: Request, res: Response) => {
  try {
    const owner = idParam(req);
    const reason = optText(body(req)["reason"], "reason", 500, true);
    const taken = await withAdminTx(adminId(req), async (c) => {
      const t = await genesisRepo.clawbackCreditTx(c as never, owner, adminId(req));
      if (t === null) throw new HttpError(404, "No held genesis credit for this owner");
      await audit(c, req, "genesis_credit_clawback", "user", owner, { reason, musd: t.toString() });
      return t;
    });
    res.json({ ownerUserId: owner, creditStatus: "clawed_back", amount: money(taken.toString()) });
  } catch (err) { fail(res, err, "Genesis clawback"); }
});

// ─── Buyer discount settings (margin floor) ─────────────────────────

router.get("/buyer-discounts/settings", async (_req: Request, res: Response) => {
  try {
    const r = await q<{ enabled: boolean; min_platform_margin_bps: number; updated_by: string | null; updated_at: Date | null }>(
      `SELECT enabled, min_platform_margin_bps, updated_by, updated_at FROM buyer_discount_settings WHERE id = 1`);
    const row = r.rows[0];
    res.json({ enabled: row?.enabled ?? true, minPlatformMarginBps: row?.min_platform_margin_bps ?? 2500, updatedBy: row?.updated_by ?? null, updatedAt: row?.updated_at ?? null });
  } catch (err) { fail(res, err, "Buyer discount settings"); }
});

router.put("/buyer-discounts/settings", async (req: Request, res: Response) => {
  try {
    const changes = await updateSingleton(req, "buyer_discount_settings", "buyer_discount_settings_update", {
      enabled: ["enabled", "bool", 0n, 0n],
      minPlatformMarginBps: ["min_platform_margin_bps", "int", 0n, 10_000n],
    });
    res.json({ updated: changes });
  } catch (err) { fail(res, err, "Buyer discount settings update"); }
});

// ─── Incidents (public status page) ─────────────────────────────────

const SEVERITIES = ["minor", "major", "critical", "maintenance"] as const;
const INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;

function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new HttpError(400, `${name} must be one of ${allowed.join("|")}`);
  return v as T;
}

router.get("/incidents", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req);
    const [items, total] = await Promise.all([
      networkStatusRepo.listIncidents(limit, offset),
      q<{ count: string }>(`SELECT COUNT(*)::text AS count FROM network_incidents`),
    ]);
    res.json({ limit, offset, total: Number(total.rows[0]?.count ?? 0), items });
  } catch (err) { fail(res, err, "Incident list"); }
});

// POST /incidents {title, body?, severity, status?, startedAt?}
router.post("/incidents", async (req: Request, res: Response) => {
  try {
    const b = body(req);
    const title = optText(b["title"], "title", 200, true) as string;
    const text = optText(b["body"], "body", 5000) ?? "";
    const severity = oneOf(b["severity"], "severity", SEVERITIES);
    const status = b["status"] === undefined ? "investigating" : oneOf(b["status"], "status", INCIDENT_STATUSES);
    const startedAt = b["startedAt"] === undefined ? null : new Date(String(b["startedAt"]));
    if (startedAt && Number.isNaN(startedAt.getTime())) throw new HttpError(400, "startedAt must be an ISO date");
    const row = await withAdminTx(adminId(req), async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO network_incidents (title, body, severity, status, started_at, resolved_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), CASE WHEN $4 = 'resolved' THEN now() END, $6, $6)
         RETURNING id`,
        [title, text, severity, status, startedAt ? startedAt.toISOString() : null, adminId(req)],
      );
      const id = r.rows[0]?.id as string;
      await audit(c, req, "network_incident_create", "network_incident", id, { title, severity, status });
      return { id };
    });
    res.status(201).json({ id: row.id, title, severity, status });
  } catch (err) { fail(res, err, "Incident create"); }
});

// PATCH /incidents/:id {title?, body?, severity?, status?}
router.patch("/incidents/:id", async (req: Request, res: Response) => {
  try {
    const id = idParam(req);
    const b = body(req);
    for (const k of Object.keys(b)) if (!["title", "body", "severity", "status"].includes(k)) throw new HttpError(400, `${k}: unknown field`);
    const sets: string[] = [];
    const vals: unknown[] = [id];
    if (b["title"] !== undefined) { vals.push(optText(b["title"], "title", 200, true)); sets.push(`title = $${vals.length}`); }
    if (b["body"] !== undefined) { vals.push(optText(b["body"], "body", 5000) ?? ""); sets.push(`body = $${vals.length}`); }
    if (b["severity"] !== undefined) { vals.push(oneOf(b["severity"], "severity", SEVERITIES)); sets.push(`severity = $${vals.length}`); }
    if (b["status"] !== undefined) {
      vals.push(oneOf(b["status"], "status", INCIDENT_STATUSES));
      sets.push(`status = $${vals.length}`, `resolved_at = CASE WHEN $${vals.length} = 'resolved' THEN COALESCE(resolved_at, now()) ELSE NULL END`);
    }
    if (sets.length === 0) throw new HttpError(400, "No fields to update");
    vals.push(adminId(req));
    await withAdminTx(adminId(req), async (c) => {
      const r = await c.query<{ id: string }>(
        `UPDATE network_incidents SET ${sets.join(", ")}, updated_by = $${vals.length}, updated_at = now() WHERE id = $1 RETURNING id`, vals);
      if (!r.rows[0]) throw new HttpError(404, "Incident not found");
      await audit(c, req, "network_incident_update", "network_incident", id, { fields: Object.keys(b), status: b["status"] ?? null });
    });
    res.json({ id, updated: Object.keys(b) });
  } catch (err) { fail(res, err, "Incident update"); }
});

// ─── Announcements (GET /v1/announcements feed) ─────────────────────

const ANN_CATEGORIES = ["policy", "pricing", "payments", "api", "network", "news"] as const;
const ANN_FIELDS = ["title", "body", "category", "url", "published", "publishedAt"];

function annUrl(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || v.length > 500 || !/^https:\/\/\S+$/.test(v)) throw new HttpError(400, "url must be an https URL (<= 500 chars) or null");
  return v;
}

function annDate(v: unknown): string {
  const d = new Date(String(v));
  if (typeof v !== "string" || Number.isNaN(d.getTime())) throw new HttpError(400, "publishedAt must be an ISO date");
  return d.toISOString();
}

function annBool(v: unknown): boolean {
  if (typeof v !== "boolean") throw new HttpError(400, "published must be a boolean");
  return v;
}

router.get("/announcements", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req);
    const [rows, total] = await Promise.all([
      q<{ id: string; title: string; body: string; category: string; url: string | null; published: boolean; published_at: Date; updated_at: Date }>(
        `SELECT id, title, body, category, url, published, published_at, updated_at FROM network_announcements
         ORDER BY published_at DESC, id LIMIT $1 OFFSET $2`, [limit, offset]),
      q<{ count: string }>(`SELECT COUNT(*)::text AS count FROM network_announcements`),
    ]);
    res.json({
      limit, offset, total: Number(total.rows[0]?.count ?? 0),
      items: rows.rows.map((a) => ({ id: a.id, title: a.title, body: a.body, category: a.category, url: a.url, published: a.published, publishedAt: a.published_at, updatedAt: a.updated_at })),
    });
  } catch (err) { fail(res, err, "Announcement list"); }
});

// POST /announcements {title, body?, category?, url?, published?, publishedAt?}
router.post("/announcements", async (req: Request, res: Response) => {
  try {
    const b = body(req);
    for (const k of Object.keys(b)) if (!ANN_FIELDS.includes(k)) throw new HttpError(400, `${k}: unknown field`);
    const title = optText(b["title"], "title", 200, true) as string;
    const text = optText(b["body"], "body", 10_000) ?? "";
    const category = b["category"] === undefined ? "news" : oneOf(b["category"], "category", ANN_CATEGORIES);
    const url = b["url"] === undefined ? null : annUrl(b["url"]);
    const published = b["published"] === undefined ? true : annBool(b["published"]);
    const publishedAt = b["publishedAt"] === undefined ? null : annDate(b["publishedAt"]);
    const id = await withAdminTx(adminId(req), async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO network_announcements (title, body, category, url, published, published_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7, $7) RETURNING id`,
        [title, text, category, url, published, publishedAt, adminId(req)]);
      const nid = r.rows[0]?.id as string;
      await audit(c, req, "announcement_create", "network_announcement", nid, { title, category, published });
      return nid;
    });
    res.status(201).json({ id, title, category, published });
  } catch (err) { fail(res, err, "Announcement create"); }
});

// PATCH /announcements/:id {title?, body?, category?, url?, published?, publishedAt?}
router.patch("/announcements/:id", async (req: Request, res: Response) => {
  try {
    const id = idParam(req);
    const b = body(req);
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const add = (col: string, v: unknown, cast = "") => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
    for (const k of Object.keys(b)) {
      if (k === "title") add("title", optText(b[k], "title", 200, true));
      else if (k === "body") add("body", optText(b[k], "body", 10_000) ?? "");
      else if (k === "category") add("category", oneOf(b[k], "category", ANN_CATEGORIES));
      else if (k === "url") add("url", annUrl(b[k]));
      else if (k === "published") add("published", annBool(b[k]));
      else if (k === "publishedAt") add("published_at", annDate(b[k]), "::timestamptz");
      else throw new HttpError(400, `${k}: unknown field`);
    }
    if (sets.length === 0) throw new HttpError(400, "No fields to update");
    vals.push(adminId(req));
    await withAdminTx(adminId(req), async (c) => {
      const r = await c.query<{ id: string }>(
        `UPDATE network_announcements SET ${sets.join(", ")}, updated_by = $${vals.length}, updated_at = now() WHERE id = $1 RETURNING id`, vals);
      if (!r.rows[0]) throw new HttpError(404, "Announcement not found");
      await audit(c, req, "announcement_update", "network_announcement", id, { fields: Object.keys(b) });
    });
    res.json({ id, updated: Object.keys(b) });
  } catch (err) { fail(res, err, "Announcement update"); }
});

router.delete("/announcements/:id", async (req: Request, res: Response) => {
  try {
    const id = idParam(req);
    await withAdminTx(adminId(req), async (c) => {
      const r = await c.query<{ id: string }>(`DELETE FROM network_announcements WHERE id = $1 RETURNING id`, [id]);
      if (!r.rows[0]) throw new HttpError(404, "Announcement not found");
      await audit(c, req, "announcement_delete", "network_announcement", id, {});
    });
    res.json({ id, deleted: true });
  } catch (err) { fail(res, err, "Announcement delete"); }
});

// ─── Unmet demand ───────────────────────────────────────────────────

// GET /unmet-demand?days=7 — aggregated (country, class) and per-day totals
router.get("/unmet-demand", async (req: Request, res: Response) => {
  try {
    const raw = req.query["days"];
    const days = raw === undefined ? 7 : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new HttpError(400, "days must be an integer in [1, 90]");
    const [groups, daily] = await Promise.all([
      q<{ country: string; ip_class: string; requests: string; last_hour: Date }>(
        `SELECT country, ip_class, SUM(requests)::text AS requests, MAX(hour) AS last_hour FROM unmet_demand_hourly
         WHERE hour > now() - make_interval(days => $1) GROUP BY country, ip_class ORDER BY SUM(requests) DESC LIMIT 500`, [days]),
      q<{ day: string; requests: string }>(
        `SELECT to_char(date_trunc('day', hour AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, SUM(requests)::text AS requests
         FROM unmet_demand_hourly WHERE hour > now() - make_interval(days => $1) GROUP BY 1 ORDER BY 1`, [days]),
    ]);
    res.json({
      days,
      groups: groups.rows.map((g) => ({ country: g.country || null, ipClass: g.ip_class || null, requests: Number(g.requests), lastHour: g.last_hour })),
      daily: daily.rows.map((d) => ({ day: d.day, requests: Number(d.requests) })),
    });
  } catch (err) { fail(res, err, "Unmet demand"); }
});

// ─── Abuse reports (public intake → admin triage) ───────────────────

const REPORT_STATUSES = ["new", "triaged", "actioned", "dismissed"] as const;

router.get("/abuse-reports", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req);
    const status = enumParam(req, "status", REPORT_STATUSES) ?? null;
    const where = `WHERE ($1::text IS NULL OR r.status = $1)`;
    const [rows, total] = await Promise.all([
      q<{ id: string; dest_host: string; window_start: Date; window_end: Date; category: string; description: string; contact: string | null;
          status: string; admin_note: string | null; triaged_by: string | null; triaged_at: Date | null; created_at: Date;
          sessions: string; requesters: string }>(
        // Matching metadata-only relay log rows (same host, inside the window), for triage.
        `SELECT r.id, r.dest_host, r.window_start, r.window_end, r.category, r.description, r.contact, r.status, r.admin_note,
                r.triaged_by, r.triaged_at, r.created_at,
                (SELECT COUNT(*) FROM relay_abuse_log l WHERE l.dest_host = r.dest_host AND l.ts BETWEEN r.window_start AND r.window_end)::text AS sessions,
                (SELECT COUNT(DISTINCT l.requester_user_id) FROM relay_abuse_log l WHERE l.dest_host = r.dest_host AND l.ts BETWEEN r.window_start AND r.window_end)::text AS requesters
         FROM abuse_reports r ${where} ORDER BY r.created_at DESC, r.id LIMIT $2 OFFSET $3`, [status, limit, offset]),
      q<{ count: string }>(`SELECT COUNT(*)::text AS count FROM abuse_reports r ${where}`, [status]),
    ]);
    res.json({
      limit, offset, total: Number(total.rows[0]?.count ?? 0),
      items: rows.rows.map((r) => ({
        id: r.id, destHost: r.dest_host, windowStart: r.window_start, windowEnd: r.window_end, category: r.category,
        description: r.description, contact: r.contact, status: r.status, adminNote: r.admin_note, triagedBy: r.triaged_by,
        triagedAt: r.triaged_at, createdAt: r.created_at,
        matches: { sessions: Number(r.sessions), requesters: Number(r.requesters) },
      })),
    });
  } catch (err) { fail(res, err, "Abuse report list"); }
});

// POST /abuse-reports/:id/triage {status, note?}
router.post("/abuse-reports/:id/triage", async (req: Request, res: Response) => {
  try {
    const id = idParam(req);
    const b = body(req);
    const status = oneOf(b["status"], "status", ["triaged", "actioned", "dismissed"] as const);
    const note = optText(b["note"], "note", 2000);
    await withAdminTx(adminId(req), async (c) => {
      const r = await c.query<{ id: string }>(
        `UPDATE abuse_reports SET status = $2, admin_note = COALESCE($3, admin_note), triaged_by = $4, triaged_at = now()
         WHERE id = $1 RETURNING id`, [id, status, note, adminId(req)]);
      if (!r.rows[0]) throw new HttpError(404, "Report not found");
      await audit(c, req, "abuse_report_triage", "abuse_report", id, { status, note });
    });
    res.json({ id, status });
  } catch (err) { fail(res, err, "Abuse report triage"); }
});

// ─── Contribution allowlist (policy.requireContribution) ────────────

router.get("/contribution-allowlist", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req);
    const [rows, total] = await Promise.all([
      q<{ user_id: string; wallet_address: string | null; note: string | null; created_by: string | null; created_at: Date }>(
        `SELECT a.user_id, u.wallet_address, a.note, a.created_by, a.created_at
         FROM contribution_allowlist a LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.created_at DESC, a.user_id LIMIT $1 OFFSET $2`, [limit, offset]),
      q<{ count: string }>(`SELECT COUNT(*)::text AS count FROM contribution_allowlist`),
    ]);
    res.json({
      limit, offset, total: Number(total.rows[0]?.count ?? 0),
      items: rows.rows.map((r) => ({ userId: r.user_id, walletAddress: r.wallet_address, note: r.note, createdBy: r.created_by, createdAt: r.created_at })),
    });
  } catch (err) { fail(res, err, "Contribution allowlist"); }
});

// POST /contribution-allowlist {userId, note?}
router.post("/contribution-allowlist", async (req: Request, res: Response) => {
  try {
    const b = body(req);
    const userId = typeof b["userId"] === "string" && UUID_RE.test(b["userId"]) ? b["userId"].toLowerCase() : null;
    if (!userId) throw new HttpError(400, "userId must be a UUID");
    const note = optText(b["note"], "note", 500);
    await withAdminTx(adminId(req), async (c) => {
      const u = await c.query<{ id: string }>(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [userId]);
      if (!u.rows[0]) throw new HttpError(404, "Active agent not found");
      await c.query(
        `INSERT INTO contribution_allowlist (user_id, note, created_by) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET note = EXCLUDED.note`,
        [userId, note, adminId(req)],
      );
      await audit(c, req, "contribution_allowlist_add", "user", userId, { note });
    });
    res.status(201).json({ userId, note, gatewayEffect: "within_30s" });
  } catch (err) { fail(res, err, "Contribution allowlist add"); }
});

router.delete("/contribution-allowlist/:id", async (req: Request, res: Response) => {
  try {
    const userId = idParam(req);
    await withAdminTx(adminId(req), async (c) => {
      const r = await c.query<{ user_id: string }>(`DELETE FROM contribution_allowlist WHERE user_id = $1 RETURNING user_id`, [userId]);
      if (!r.rows[0]) throw new HttpError(404, "Allowlist entry not found");
      await audit(c, req, "contribution_allowlist_remove", "user", userId, {});
    });
    res.json({ userId, removed: true });
  } catch (err) { fail(res, err, "Contribution allowlist remove"); }
});

export default router;
