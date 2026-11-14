import { Router } from "express";
import type { Request, Response } from "express";
import { createLogger, getPool, isKillSwitchKey, killSwitchEnvMs, KILL_SWITCH_KEYS, type KillSwitchKey } from "@dominusnode/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { HttpError, fail, page, withAdminTx, audit, adminId, requireReason, uuidPath } from "./admin-network-common.js";

/**
 * Admin kill switches (docs/agent-network/ADMIN_API.md §17). Mounted at
 * /api/admin/network. Every change re-checks the admin role FOR UPDATE and
 * writes an audit_events row in the same transaction. Gateways and API
 * instances pick changes up within KILL_SWITCH_POLL_MS (default 5 s).
 */
const log = createLogger("api:admin-kill-switches");
const router = Router();
router.use(requireAuth, requireAdmin);

function pollMs(): number {
  try { return killSwitchEnvMs(process.env, "KILL_SWITCH_POLL_MS"); } catch { return 5_000; }
}

interface SwitchRow { key: string; engaged: boolean; reason: string | null; updated_by: string | null; updated_at: Date }

function switchOut(r: SwitchRow) {
  return { key: r.key, engaged: r.engaged, reason: r.reason, updatedBy: r.updated_by, updatedAt: r.updated_at };
}

// GET /kill-switches — every switch plus drained nodes
router.get("/kill-switches", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req, 100);
    const pool = getPool();
    const [sw, dr, total] = await Promise.all([
      pool.query<SwitchRow>("SELECT key, engaged, reason, updated_by, updated_at FROM kill_switches"),
      pool.query<{ node_id: string; reason: string; created_by: string | null; created_at: Date; status: string | null; ip_class: string | null; country: string | null }>(
        `SELECT d.node_id, d.reason, d.created_by, d.created_at, n.status, n.ip_class, n.country
           FROM node_drains d LEFT JOIN nodes n ON n.id = d.node_id
          ORDER BY d.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM node_drains"),
    ]);
    const byKey = new Map(sw.rows.map((r) => [r.key, r]));
    res.json({
      pollIntervalMs: pollMs(),
      switches: KILL_SWITCH_KEYS.map((k) => switchOut(byKey.get(k) ?? { key: k, engaged: false, reason: null, updated_by: null, updated_at: new Date(0) })),
      drainedNodes: {
        limit, offset, total: Number(total.rows[0]?.n ?? 0),
        items: dr.rows.map((r) => ({ nodeId: r.node_id, reason: r.reason, createdBy: r.created_by, createdAt: r.created_at, status: r.status, ipClass: r.ip_class, country: r.country })),
      },
    });
  } catch (err) { fail(res, err, "Kill switch read"); }
});

// PUT /kill-switches/:key {engaged: boolean, reason}
router.put("/kill-switches/:key", async (req: Request, res: Response) => {
  try {
    const key = String(req.params["key"] ?? "");
    if (!isKillSwitchKey(key)) throw new HttpError(404, "Unknown kill switch");
    const engaged = (req.body ?? {})["engaged"];
    if (typeof engaged !== "boolean") throw new HttpError(400, "engaged must be a boolean");
    const reason = requireReason(req);
    const out = await withAdminTx(adminId(req), async (c) => {
      const prev = await c.query<{ engaged: boolean }>("SELECT engaged FROM kill_switches WHERE key = $1 FOR UPDATE", [key]);
      const r = await c.query<SwitchRow>(
        `INSERT INTO kill_switches (key, engaged, reason, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (key) DO UPDATE SET engaged = EXCLUDED.engaged, reason = EXCLUDED.reason,
           updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING key, engaged, reason, updated_by, updated_at`,
        [key, engaged, reason, adminId(req)],
      );
      const previous = prev.rows[0]?.engaged ?? false;
      await audit(c, req, "kill_switch_set", "kill_switch", key, { engaged, previous, reason });
      return { row: r.rows[0]!, previous };
    });
    log.warn("kill switch set", { key: key as KillSwitchKey, engaged, by: adminId(req) });
    res.json({ ...switchOut(out.row), previous: out.previous, changed: out.previous !== engaged, effectWithinMs: pollMs() });
  } catch (err) { fail(res, err, "Kill switch update"); }
});

// POST /nodes/:id/drain {reason} — no new sessions; open streams finish
router.post("/nodes/:id/drain", async (req: Request, res: Response) => {
  try {
    const id = uuidPath(req);
    const reason = requireReason(req);
    const out = await withAdminTx(adminId(req), async (c) => {
      const n = await c.query<{ id: string }>("SELECT id FROM nodes WHERE id = $1 FOR UPDATE", [id]);
      if (!n.rows[0]) throw new HttpError(404, "Node not found");
      const r = await c.query<{ node_id: string }>(
        `INSERT INTO node_drains (node_id, reason, created_by) VALUES ($1, $2, $3)
         ON CONFLICT (node_id) DO NOTHING RETURNING node_id`, [id, reason, adminId(req)]);
      const changed = r.rows.length > 0;
      if (changed) await audit(c, req, "node_drain", "node", id, { reason });
      return changed;
    });
    res.json({ nodeId: id, drained: true, changed: out, effectWithinMs: pollMs() });
  } catch (err) { fail(res, err, "Node drain"); }
});

// POST /nodes/:id/undrain {reason}
router.post("/nodes/:id/undrain", async (req: Request, res: Response) => {
  try {
    const id = uuidPath(req);
    const reason = requireReason(req);
    const out = await withAdminTx(adminId(req), async (c) => {
      const r = await c.query<{ node_id: string; reason: string }>(
        "DELETE FROM node_drains WHERE node_id = $1 RETURNING node_id, reason", [id]);
      const row = r.rows[0];
      if (row) await audit(c, req, "node_undrain", "node", id, { reason, drainReason: row.reason });
      return !!row;
    });
    res.json({ nodeId: id, drained: false, changed: out, effectWithinMs: pollMs() });
  } catch (err) { fail(res, err, "Node undrain"); }
});

export default router;
