import { Router } from "express";
import type { Request, Response } from "express";
import { createLogger, getPool, collusionRepo } from "@dominusnode/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { HttpError, fail, money, page, enumParam, uuidParam, withAdminTx, audit, adminId } from "./admin-network-common.js";

/**
 * Collusion flags and detector settings (DESIGN.md §13 commit 33,
 * docs/agent-network/ADMIN_API.md). Mounted at /api/admin/network.
 */
const log = createLogger("api:admin-network-collusion");
const router = Router();
router.use(requireAuth, requireAdmin);

const q = <R>(sql: string, params: unknown[] = []) =>
  getPool().query(sql, params) as unknown as Promise<{ rows: R[] }>;

const KINDS = ["concentration", "cluster", "circular", "report_penalty", "egress_mismatch"] as const;
const STATUSES = ["open", "dismissed", "confirmed"] as const;

interface FlagRow {
  id: string; kind: string; owner_user_id: string; owner_email: string | null; node_id: string | null;
  requester_user_id: string | null; requester_email: string | null; share_bps: number; volume_musd: string; total_musd: string;
  window_days: number; status: string; auto_frozen: boolean; frozen: boolean | null; resolved_by: string | null;
  resolution_note: string | null; first_seen_at: Date; last_seen_at: Date; resolved_at: Date | null;
}

const FLAG_COLS = `f.id::text AS id, f.kind, f.owner_user_id, ou.email AS owner_email, f.node_id, f.requester_user_id,
  ru.email AS requester_email, f.share_bps, f.volume_musd::text AS volume_musd, f.total_musd::text AS total_musd,
  f.window_days, f.status, f.auto_frozen, a.frozen, f.resolved_by, f.resolution_note, f.first_seen_at, f.last_seen_at, f.resolved_at`;
const FLAG_FROM = `FROM collusion_flags f
  LEFT JOIN users ou ON ou.id = f.owner_user_id
  LEFT JOIN users ru ON ru.id = f.requester_user_id
  LEFT JOIN node_credit_accounts a ON a.user_id = f.owner_user_id`;

function flagOut(f: FlagRow) {
  return {
    id: f.id, kind: f.kind, ownerUserId: f.owner_user_id, ownerEmail: f.owner_email, nodeId: f.node_id,
    requesterUserId: f.requester_user_id, requesterEmail: f.requester_email, shareBps: f.share_bps,
    volume: money(f.volume_musd), total: money(f.total_musd), windowDays: f.window_days, status: f.status,
    autoFrozen: f.auto_frozen, ownerCreditsFrozen: f.frozen ?? false, resolvedBy: f.resolved_by,
    resolutionNote: f.resolution_note, firstSeenAt: f.first_seen_at, lastSeenAt: f.last_seen_at, resolvedAt: f.resolved_at,
  };
}

function body(req: Request): Record<string, unknown> {
  const b = req.body ?? {};
  if (typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "Body must be an object");
  return b as Record<string, unknown>;
}

// GET /collusion/flags?status=open&kind=&ownerUserId=&limit=&offset=
router.get("/collusion/flags", async (req: Request, res: Response) => {
  try {
    const { limit, offset } = page(req);
    const status = enumParam(req, "status", STATUSES) ?? "open";
    const kind = enumParam(req, "kind", KINDS);
    const owner = uuidParam(req, "ownerUserId");
    const params = [status, kind ?? null, owner ?? null];
    const where = `WHERE f.status = $1 AND ($2::text IS NULL OR f.kind = $2) AND ($3::uuid IS NULL OR f.owner_user_id = $3)`;
    const [rows, total] = await Promise.all([
      q<FlagRow>(`SELECT ${FLAG_COLS} ${FLAG_FROM} ${where}
                  ORDER BY f.share_bps DESC, f.last_seen_at DESC, f.id LIMIT $4 OFFSET $5`, [...params, limit, offset]),
      q<{ count: string }>(`SELECT COUNT(*)::text AS count FROM collusion_flags f ${where}`, params),
    ]);
    res.json({ limit, offset, total: Number(total.rows[0]?.count ?? 0), items: rows.rows.map(flagOut) });
  } catch (err) { fail(res, err, "Collusion flag list"); }
});

// POST /collusion/flags/:id/(dismiss|confirm) {note?}
for (const action of ["dismiss", "confirm"] as const) {
  router.post(`/collusion/flags/:id/${action}`, async (req: Request, res: Response) => {
    try {
      const id = String(req.params["id"] ?? "");
      if (!/^[1-9][0-9]{0,18}$/.test(id)) throw new HttpError(400, "id must be a positive integer");
      const note = body(req)["note"];
      if (note !== undefined && (typeof note !== "string" || note.length > 500 || /[\u0000-\u001f\u007f]/.test(note))) {
        throw new HttpError(400, "note must be at most 500 printable chars");
      }
      const status = action === "dismiss" ? "dismissed" : "confirmed";
      const out = await withAdminTx(adminId(req), async (c) => {
        const r = await c.query<{ id: string; owner_user_id: string }>(
          `UPDATE collusion_flags SET status = $2, resolved_by = $3, resolution_note = $4, resolved_at = now()
           WHERE id = $1::bigint AND status = 'open'
           RETURNING id::text AS id, owner_user_id`,
          [id, status, adminId(req), note ?? null],
        );
        const row = r.rows[0];
        if (!row) throw new HttpError(404, "Open flag not found");
        await audit(c, req, `collusion_flag_${action}`, "collusion_flag", id, { ownerUserId: row.owner_user_id, note: note ?? null });
        return row;
      });
      log.info(`collusion flag ${status}`, { id, by: adminId(req) });
      res.json({ id: out.id, status });
    } catch (err) { fail(res, err, "Collusion flag update"); }
  });
}

function settingsOut(s: Awaited<ReturnType<typeof collusionRepo.getSettings>>) {
  return {
    windowDays: s.windowDays, minNodeVolume: money(s.minNodeVolumeMusd.toString()), concentrationBps: s.concentrationBps,
    clusterSize: s.clusterSize, clusterBps: s.clusterBps, circularMin: money(s.circularMinMusd.toString()),
    autoFreeze: s.autoFreeze, freezeBps: s.freezeBps, freezeMinVolume: money(s.freezeMinVolumeMusd.toString()),
    updatedBy: s.updatedBy, updatedAt: s.updatedAt,
  };
}

router.get("/collusion/settings", async (_req: Request, res: Response) => {
  try {
    res.json(settingsOut(await collusionRepo.getSettings()));
  } catch (err) { fail(res, err, "Collusion settings"); }
});

const INT_FIELDS: Record<string, [string, number, number]> = {
  windowDays: ["window_days", 1, 90],
  concentrationBps: ["concentration_bps", 1, 10_000],
  clusterSize: ["cluster_size", 2, 20],
  clusterBps: ["cluster_bps", 1, 10_000],
  freezeBps: ["freeze_bps", 1, 10_000],
};
const MUSD_FIELDS: Record<string, string> = {
  minNodeVolumeMusd: "min_node_volume_musd",
  circularMinMusd: "circular_min_musd",
  freezeMinVolumeMusd: "freeze_min_volume_musd",
};
const MAX_MUSD = 1_000_000_000_000n;

// PUT /collusion/settings {windowDays?, concentrationBps?, ..., minNodeVolumeMusd?: "digits", autoFreeze?: bool}
router.put("/collusion/settings", async (req: Request, res: Response) => {
  try {
    const b = body(req);
    const sets: string[] = [];
    const vals: unknown[] = [];
    const changes: Record<string, unknown> = {};
    for (const k of Object.keys(b)) {
      if (!(k in INT_FIELDS) && !(k in MUSD_FIELDS) && k !== "autoFreeze") throw new HttpError(400, `${k}: unknown field`);
    }
    for (const [k, [col, min, max]] of Object.entries(INT_FIELDS)) {
      if (b[k] === undefined) continue;
      const v = b[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new HttpError(400, `${k} must be an integer in [${min}, ${max}]`);
      vals.push(v); sets.push(`${col} = $${vals.length}`); changes[k] = v;
    }
    for (const [k, col] of Object.entries(MUSD_FIELDS)) {
      if (b[k] === undefined) continue;
      const v = b[k];
      if (typeof v !== "string" || !/^\d{1,13}$/.test(v) || BigInt(v) > MAX_MUSD) throw new HttpError(400, `${k} must be a digit string in [0, ${MAX_MUSD}]`);
      vals.push(v); sets.push(`${col} = $${vals.length}::bigint`); changes[k] = v;
    }
    if (b["autoFreeze"] !== undefined) {
      if (typeof b["autoFreeze"] !== "boolean") throw new HttpError(400, "autoFreeze must be a boolean");
      vals.push(b["autoFreeze"]); sets.push(`auto_freeze = $${vals.length}`); changes["autoFreeze"] = b["autoFreeze"];
    }
    if (sets.length === 0) throw new HttpError(400, "No fields to update");
    await withAdminTx(adminId(req), async (c) => {
      await c.query(`INSERT INTO collusion_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
      vals.push(adminId(req));
      await c.query(`UPDATE collusion_settings SET ${sets.join(", ")}, updated_by = $${vals.length}, updated_at = now() WHERE id = 1`, vals);
      await audit(c, req, "collusion_settings_update", "collusion_settings", "1", changes);
    });
    log.info("collusion settings updated", { by: adminId(req), fields: Object.keys(changes) });
    res.json(settingsOut(await collusionRepo.getSettings()));
  } catch (err) { fail(res, err, "Collusion settings update"); }
});

export default router;
