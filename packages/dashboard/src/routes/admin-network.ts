import { Router } from "express";
import type { Request, Response } from "express";
import {
  createLogger,
  getPool,
  policyRepo,
  payoutRepo,
} from "@dominusnode/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { HttpError, adminId, withAdminTx, fail, audit } from "./admin-network-common.js";
import { invalidatePublicCaches } from "./v1/public.js";

/**
 * Admin CRUD for the agent relay network (DESIGN.md §10 Admin, §15):
 * policy, pricing, revenue split and tiers. Mounted at /api/admin/network.
 */
const log = createLogger("api:admin-network");
const router = Router();
router.use(requireAuth, requireAdmin);

function intField(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new HttpError(400, `${name} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

/** µUSD amounts arrive as integer numbers or decimal strings (BigInt-safe). */
function musdField(v: unknown, name: string, min: bigint, max: bigint): bigint {
  let b: bigint;
  if (typeof v === "number" && Number.isSafeInteger(v)) b = BigInt(v);
  else if (typeof v === "string" && /^\d{1,15}$/.test(v)) b = BigInt(v);
  else throw new HttpError(400, `${name} must be an integer`);
  if (b < min || b > max) throw new HttpError(400, `${name} must be in [${min}, ${max}]`);
  return b;
}

// ─── Policy ─────────────────────────────────────────────────────────

router.get("/policy", async (_req: Request, res: Response) => {
  try {
    const p = await policyRepo.getActivePolicy();
    res.json({ version: p.version, sha256: p.sha256, body: p.body, createdAt: p.createdAt });
  } catch (err) { fail(res, err, "Policy fetch"); }
});

router.put("/policy", async (req: Request, res: Response) => {
  try {
    const uid = adminId(req);
    // Role re-check (FOR UPDATE) and publish share one BEGIN/COMMIT (no TOCTOU).
    const r = await withAdminTx(uid, async (c) => {
      const out = await policyRepo.publishPolicyTx(c, req.body, uid);
      await audit(c, req, "network_policy_publish", "network_policy", String(out.version), {
        version: out.version, previousVersion: out.previousVersion, sha256: out.sha256, attestationRaised: out.attestationRaised,
      });
      return out;
    });
    invalidatePublicCaches();
    log.info("network policy published", {
      version: r.version, previousVersion: r.previousVersion, attestationRaised: r.attestationRaised, by: uid,
    });
    res.json({ version: r.version, sha256: r.sha256, body: r.body, previousVersion: r.previousVersion, attestationRaised: r.attestationRaised });
  } catch (err) { fail(res, err, "Policy publish"); }
});

// ─── Pricing ────────────────────────────────────────────────────────

const PRICING_CLASSES = new Set(["any", "residential", "dc", "mobile"]);

router.get("/pricing", async (_req: Request, res: Response) => {
  try {
    const rows = await policyRepo.listPricing();
    res.json({ pricing: rows.map((p) => ({ ipClass: p.ipClass, pricePerGbMusd: p.pricePerGbMusd.toString(), updatedAt: p.updatedAt })) });
  } catch (err) { fail(res, err, "Pricing fetch"); }
});

router.put("/pricing", async (req: Request, res: Response) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ipClass = typeof b["ipClass"] === "string" ? b["ipClass"] : "";
    if (!PRICING_CLASSES.has(ipClass)) throw new HttpError(400, "ipClass must be any|residential|dc|mobile");
    const price = musdField(b["pricePerGbMusd"], "pricePerGbMusd", 1000n, 5_000_000n);
    const uid = adminId(req);
    const row = await withAdminTx(uid, async (c) => {
      const r = await c.query<{ ip_class: string; price_per_gb_musd: string; updated_at: Date }>(
        `INSERT INTO network_pricing (ip_class, price_per_gb_musd, updated_by, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (ip_class) DO UPDATE
           SET price_per_gb_musd = EXCLUDED.price_per_gb_musd, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING ip_class, price_per_gb_musd, updated_at`,
        [ipClass, price.toString(), uid],
      );
      await audit(c, req, "network_pricing_update", "network_pricing", ipClass, { ipClass, pricePerGbMusd: price.toString() });
      return r.rows[0];
    });
    invalidatePublicCaches();
    log.info("network pricing updated", { ipClass, pricePerGbMusd: price.toString(), by: uid });
    res.json({ ipClass: row.ip_class, pricePerGbMusd: String(row.price_per_gb_musd), updatedAt: row.updated_at });
  } catch (err) { fail(res, err, "Pricing update"); }
});

// ─── Revenue split (append-only) ───────────────────────────────────

const SPLIT_SKEW_MS = 60_000;

router.get("/split", async (_req: Request, res: Response) => {
  try {
    const [current, hist] = await Promise.all([
      policyRepo.getSplit(),
      getPool().query<{ id: number; node_share_bps: number; maturation_hours: number; effective_from: Date; note: string | null; created_at: Date }>(
        `SELECT id, node_share_bps, maturation_hours, effective_from, note, created_at
         FROM revenue_split_config ORDER BY effective_from DESC, id DESC LIMIT 50`,
      ),
    ]);
    res.json({
      current,
      history: hist.rows.map((r) => ({
        id: r.id, nodeShareBps: r.node_share_bps, maturationHours: r.maturation_hours,
        effectiveFrom: r.effective_from, note: r.note, createdAt: r.created_at,
      })),
    });
  } catch (err) { fail(res, err, "Split fetch"); }
});

router.post("/split", async (req: Request, res: Response) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const nodeShareBps = intField(b["nodeShareBps"], "nodeShareBps", 0, 5000);
    const maturationHours = intField(b["maturationHours"], "maturationHours", 0, 2160);
    let effectiveFrom = new Date();
    if (b["effectiveFrom"] !== undefined) {
      if (typeof b["effectiveFrom"] !== "string" || b["effectiveFrom"].length > 40) throw new HttpError(400, "effectiveFrom must be an ISO timestamp");
      effectiveFrom = new Date(b["effectiveFrom"]);
      if (Number.isNaN(effectiveFrom.getTime())) throw new HttpError(400, "effectiveFrom must be an ISO timestamp");
      if (effectiveFrom.getTime() < Date.now() - SPLIT_SKEW_MS) throw new HttpError(400, "effectiveFrom must not be in the past");
      if (effectiveFrom.getTime() > Date.now() + 366 * 86_400_000) throw new HttpError(400, "effectiveFrom too far in the future");
    }
    let note: string | null = null;
    if (b["note"] !== undefined && b["note"] !== null) {
      if (typeof b["note"] !== "string" || b["note"].length > 500 || /[\u0000-\u001f\u007f]/.test(b["note"])) {
        throw new HttpError(400, "note must be a string of at most 500 printable chars");
      }
      note = b["note"];
    }
    const uid = adminId(req);
    const row = await withAdminTx(uid, async (c) => {
      const r = await c.query<{ id: number; effective_from: Date }>(
        `INSERT INTO revenue_split_config (node_share_bps, maturation_hours, effective_from, created_by, note)
         VALUES ($1, $2, GREATEST($3::timestamptz, now()), $4, $5)
         RETURNING id, effective_from`,
        [nodeShareBps, maturationHours, effectiveFrom.toISOString(), uid, note],
      );
      const ins = r.rows[0];
      await audit(c, req, "revenue_split_append", "revenue_split_config", String(ins.id), {
        nodeShareBps, maturationHours, effectiveFrom: new Date(ins.effective_from).toISOString(), note,
      });
      return ins;
    });
    invalidatePublicCaches();
    log.info("revenue split appended", { id: row.id, nodeShareBps, maturationHours, by: uid });
    res.status(201).json({ id: row.id, nodeShareBps, maturationHours, effectiveFrom: row.effective_from, note });
  } catch (err) { fail(res, err, "Split update"); }
});

// ─── Tiers ──────────────────────────────────────────────────────────

/** Editable tier columns: [body key, column, min, max]. Name/rank are immutable. */
const TIER_INT_FIELDS: ReadonlyArray<[string, string, number, number]> = [
  ["nodeShareBps", "node_share_bps", 0, 5000],
  ["minTenureDays", "min_tenure_days", 0, 3650],
  ["minUptimeBps", "min_uptime_bps", 0, 10000],
  ["minActiveIps", "min_active_ips", 0, 1_000_000],
  ["minReputation", "min_reputation", 0, 10000],
  ["noClawbackDays", "no_clawback_days", 0, 3650],
  ["holdDays", "hold_days", 0, 90],
  ["maxNodes", "max_nodes", 1, 100000],
];
const TIER_ALLOWED = new Set([...TIER_INT_FIELDS.map((f) => f[0]), "dailyWithdrawLimitMusd"]);

router.get("/tiers", async (_req: Request, res: Response) => {
  try {
    const tiers = await policyRepo.listTiers();
    res.json({ tiers: tiers.map((t) => ({ ...t, dailyWithdrawLimitMusd: t.dailyWithdrawLimitMusd.toString() })) });
  } catch (err) { fail(res, err, "Tier fetch"); }
});

router.put("/tiers/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id < 1 || id > 100) throw new HttpError(400, "Invalid tier id");
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "Body must be an object");
    for (const k of Object.keys(b)) {
      if (!TIER_ALLOWED.has(k)) throw new HttpError(400, `Unknown or immutable field: ${k.slice(0, 40)}`);
    }
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, col, min, max] of TIER_INT_FIELDS) {
      if (b[key] === undefined) continue;
      params.push(intField(b[key], key, min, max));
      sets.push(`${col} = $${params.length}`);
    }
    if (b["dailyWithdrawLimitMusd"] !== undefined) {
      params.push(musdField(b["dailyWithdrawLimitMusd"], "dailyWithdrawLimitMusd", 0n, 100_000_000_000n).toString());
      sets.push(`daily_withdraw_limit_musd = $${params.length}`);
    }
    if (sets.length === 0) throw new HttpError(400, "No fields to update");
    const uid = adminId(req);
    params.push(uid);
    const updated = await withAdminTx(uid, async (c) => {
      const r = await c.query<{ id: number }>(
        `UPDATE node_tiers SET ${sets.join(", ")}, updated_by = $${params.length}, updated_at = now()
         WHERE id = $1 RETURNING id`,
        params,
      );
      const row = r.rows[0] ?? null;
      if (row) {
        const changes: Record<string, unknown> = {};
        for (const k of Object.keys(b)) changes[k] = typeof b[k] === "number" ? b[k] : String(b[k]);
        await audit(c, req, "node_tier_update", "node_tier", String(id), { changes });
      }
      return row;
    });
    if (!updated) throw new HttpError(404, "Tier not found");
    const tier = await policyRepo.getTier(id);
    invalidatePublicCaches();
    log.info("node tier updated", { tierId: id, fields: Object.keys(b), by: uid });
    res.json({ tier: tier ? { ...tier, dailyWithdrawLimitMusd: tier.dailyWithdrawLimitMusd.toString() } : null });
  } catch (err) { fail(res, err, "Tier update"); }
});

// ─── Credit account unfreeze ────────────────────────────────────────

import { UUID_RE } from "./admin-network-common.js";

/**
 * POST /accounts/:userId/unfreeze { payouts: "release" | "reverse" }
 * Clears `frozen` and releases held_frozen payouts to pending or reverses them
 * (re-crediting available). Role re-check, unfreeze and audit row share one tx.
 */
router.post("/accounts/:userId/unfreeze", async (req: Request, res: Response) => {
  try {
    const target = String(req.params["userId"] ?? "");
    if (!UUID_RE.test(target)) throw new HttpError(400, "Invalid user id");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const mode = b["payouts"];
    if (mode !== "release" && mode !== "reverse") throw new HttpError(400, "payouts must be \"release\" or \"reverse\"");
    const uid = adminId(req);
    const out = await withAdminTx(uid, async (c) => {
      const r = await payoutRepo.unfreezeAccountTx(c as unknown as Parameters<typeof payoutRepo.unfreezeAccountTx>[0], target, mode);
      if (!r) throw new HttpError(404, "Credit account not found");
      await c.query(
        `INSERT INTO audit_events (user_id, action, resource, resource_id, ip_address, details)
         VALUES ($1, 'node_credit_unfreeze', 'node_credit_account', $2, $3, $4)`,
        [uid, target, (req.ip ?? "").slice(0, 64) || null,
          JSON.stringify({ mode, wasFrozen: r.wasFrozen, payouts: r.payouts, musd: r.musd.toString() })],
      );
      return r;
    });
    log.info("node credit account unfrozen", { target, mode, payouts: out.payouts, by: uid });
    res.json({ userId: target, mode, wasFrozen: out.wasFrozen, payouts: out.payouts, musd: out.musd.toString() });
  } catch (err) { fail(res, err, "Account unfreeze"); }
});

export default router;
