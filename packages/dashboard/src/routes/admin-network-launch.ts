import { Router } from "express";
import type { Request, Response } from "express";
import { createLogger, getPool } from "@dominusnode/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { HttpError, fail, money, withAdminTx, audit, adminId, UUID_RE } from "./admin-network-common.js";

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

export default router;
