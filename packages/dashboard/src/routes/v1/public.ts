import { Router } from "express";
import type { Request, Response } from "express";
import {
  createLogger,
  query,
  policyRepo,
  FLOOR_ALLOWED_PORTS,
  HARD_DENY_PORTS,
  BLOCKED_COUNTRY_CODES,
} from "@dominusnode/shared";

const log = createLogger("api:v1:public");
const router = Router();

const CACHE_TTL_MS = 30_000;

/** Static, human-readable description of the non-disableable node floor (§3, §9). */
export const FLOOR_GUARANTEES: readonly string[] = [
  `Node exits only dial ports in ${FLOOR_ALLOWED_PORTS.join(", ")} intersected with policy and operator settings.`,
  `Ports ${HARD_DENY_PORTS.join(", ")} are always denied.`,
  "Private, loopback, link-local, CGNAT, cloud-metadata and embedded-IPv4 IPv6 ranges are always denied, re-checked after DNS resolution and after connect.",
  "Names under .localhost, .local, .internal and .arpa, and hex/octal/decimal IP literals, are always denied.",
  "The node's own public IP and LAN gateway are never reachable through it.",
  "Nodes log connection metadata only (time, stream, host, bytes), never payloads.",
  "Policy updates can only tighten the floor; they cannot add ports or address ranges.",
];

interface Cached<T> { at: number; value: T }
let policyCache: Cached<{ version: number; sha256: string; body: unknown }> | null = null;
let statsCache: Cached<unknown> | null = null;

/** Drop cached public responses (called after an admin publish). */
export function invalidatePublicCaches(): void {
  policyCache = null;
  statsCache = null;
}

function setPublicCache(res: Response): void {
  res.setHeader("Cache-Control", `public, max-age=${CACHE_TTL_MS / 1000}`);
  res.removeHeader("Pragma");
}

// GET /v1/policy — active policy, version, hash (no auth)
router.get("/policy", async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (!policyCache || now - policyCache.at > CACHE_TTL_MS) {
      const p = await policyRepo.getActivePolicy();
      policyCache = { at: now, value: { version: p.version, sha256: p.sha256, body: p.body } };
    }
    const v = policyCache.value;
    const etag = `"${v.sha256}"`;
    setPublicCache(res);
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }
    res.json({ version: v.version, sha256: v.sha256, body: v.body, floorGuarantees: FLOOR_GUARANTEES });
  } catch (err) {
    log.error("policy fetch failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(503).json({ error: "Policy unavailable" });
  }
});

function enabledRails(): string[] {
  const raw = process.env["NETWORK_PAYMENT_RAILS"] ?? "wallet,x402,crypto";
  return raw.split(",").map((s) => s.trim()).filter((s) => /^[a-z0-9_-]{1,32}$/.test(s)).slice(0, 16);
}

// GET /v1/pricing — per-class price, tier share bps, rails
router.get("/pricing", async (_req: Request, res: Response) => {
  try {
    const [pricing, tiers, split] = await Promise.all([
      policyRepo.listPricing(),
      policyRepo.listTiers(),
      policyRepo.getSplit(),
    ]);
    setPublicCache(res);
    res.json({
      currency: "USD",
      unit: "musd_per_gb",
      prices: pricing.map((p) => ({ ipClass: p.ipClass, pricePerGbMusd: p.pricePerGbMusd.toString() })),
      nodeShare: tiers.map((t) => ({ tier: t.name, rank: t.rank, nodeShareBps: t.nodeShareBps })),
      // List prices above; node operators buy at a tier discount funded from the platform share.
      buyerDiscounts: tiers.map((t) => ({ tier: t.name, rank: t.rank, buyerDiscountBps: t.buyerDiscountBps ?? 0 })),
      maturationHours: split.maturationHours,
      rails: enabledRails(),
    });
  } catch (err) {
    log.error("pricing fetch failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(503).json({ error: "Pricing unavailable" });
  }
});

/** Groups smaller than this are folded into "other" so single nodes are not singled out. */
const MIN_GROUP = 3;

// GET /v1/network/stats — aggregate only, never node IPs/ids
router.get("/network/stats", async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (!statsCache || now - statsCache.at > CACHE_TTL_MS) {
      const r = await query<{ country: string | null; ip_class: string | null; operator_run: boolean | null; n: string }>(
        `SELECT country, ip_class, operator_run, COUNT(*)::text AS n FROM nodes
         WHERE status = 'active' AND last_seen_at > now() - interval '5 minutes'
         GROUP BY country, ip_class, operator_run`,
      );
      // Paid traffic in the last 24h, seed (operator-run) vs community. Aggregate only.
      const t = await query<{ operator_run: boolean | null; bytes: string | null }>(
        `SELECT n.operator_run, SUM(rc.bytes_gateway)::text AS bytes
         FROM relay_charges rc JOIN nodes n ON n.id = rc.node_id
         WHERE rc.created_at > now() - interval '24 hours' AND rc.gross_musd > 0
         GROUP BY n.operator_run`,
      );
      const seed = { online: 0, paidBytes24h: "0" };
      const community = { online: 0, paidBytes24h: "0" };
      for (const row of t.rows ?? []) {
        const b = /^\d{1,20}$/.test(row.bytes ?? "") ? (row.bytes as string) : "0";
        if (row.operator_run) seed.paidBytes24h = b; else community.paidBytes24h = b;
      }
      let total = 0;
      let other = 0;
      const byClass: Record<string, number> = {};
      const byCountry: Record<string, number> = {};
      for (const row of r.rows) {
        const n = parseInt(row.n, 10);
        if (!Number.isFinite(n) || n <= 0) continue;
        total += n;
        if (row.operator_run) seed.online += n; else community.online += n;
        const cls = row.ip_class ?? "unknown";
        byClass[cls] = (byClass[cls] ?? 0) + n;
        const c = row.country && !BLOCKED_COUNTRY_CODES.has(row.country) ? row.country : null;
        if (c) byCountry[c] = (byCountry[c] ?? 0) + n;
        else other += n;
      }
      const countries: Array<{ country: string; online: number }> = [];
      for (const [country, online] of Object.entries(byCountry)) {
        if (online >= MIN_GROUP) countries.push({ country, online });
        else other += online;
      }
      countries.sort((a, b) => b.online - a.online || a.country.localeCompare(b.country));
      statsCache = {
        at: now,
        value: { onlineNodes: total, byClass, byCountry: countries, otherCountries: other, seed, community, generatedAt: new Date(now).toISOString() },
      };
    }
    setPublicCache(res);
    res.json(statsCache.value);
  } catch (err) {
    log.error("network stats failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(503).json({ error: "Stats unavailable" });
  }
});

export default router;
