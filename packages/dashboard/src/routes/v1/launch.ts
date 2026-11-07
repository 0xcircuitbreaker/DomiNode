import { Router } from "express";
import type { Request, Response } from "express";
import { createLogger, starterCreditRepo, networkStatusRepo } from "@dominusnode/shared";
import { requireAgentPrincipal, type AgentRequest } from "../../middleware/agent.js";
import { money } from "./credits.js";
import { createKeyedLimiter } from "./limiter.js";

/**
 * Launch-readiness /v1 routes (AGENT_API.md "Launch"). Mounted BEFORE the
 * routers that apply requireAgentPrincipal to everything, so public routes
 * here stay public; agent routes apply the middleware per route.
 */
const log = createLogger("api:v1:launch");
const router = Router();
const readLimiter = createKeyedLimiter(120, 60_000);

function setPublicCache(res: Response, seconds = 60): void {
  res.setHeader("Cache-Control", `public, max-age=${seconds}`);
  res.removeHeader("Pragma");
}

const ipLimiter = createKeyedLimiter(120, 60_000);
function ipLimited(req: Request, res: Response): boolean {
  if (ipLimiter.hit(req.ip ?? "unknown")) return false;
  res.status(429).json({ error: "Too many requests", code: "RATE_LIMITED" });
  return true;
}

function intQuery(req: Request, name: string, def: number, min: number, max: number): number | null {
  const raw = req.query[name];
  if (raw === undefined) return def;
  const v = Number(raw);
  return typeof raw === "string" && /^\d{1,6}$/.test(raw) && v >= min && v <= max ? v : null;
}

// GET /v1/network/history?hours=168 — hourly public snapshots (aggregate only)
router.get("/network/history", async (req: Request, res: Response) => {
  if (ipLimited(req, res)) return;
  const hours = intQuery(req, "hours", 168, 1, 24 * 400);
  if (hours === null) {
    res.status(400).json({ error: "hours must be an integer in [1, 9600]" });
    return;
  }
  try {
    const rows = await networkStatusRepo.listSnapshots(hours);
    setPublicCache(res, 300);
    res.json({
      hours,
      snapshots: rows.map((r) => ({
        hour: r.hour, onlineNodes: r.onlineNodes, seedOnline: r.seedOnline, communityOnline: r.communityOnline,
        countries: r.countries, asns: r.asns, successRateBps: r.successRateBps, p50Ms: r.p50Ms, p95Ms: r.p95Ms,
        paidBytes24h: r.paidBytes24h, seedPaidBytes24h: r.seedPaidBytes24h, communityPaidBytes24h: r.communityPaidBytes24h,
        byClass: r.byClass,
      })),
    });
  } catch (err) {
    log.error("network history failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(503).json({ error: "History unavailable" });
  }
});

// GET /v1/network/incidents — admin-managed incident log
router.get("/network/incidents", async (req: Request, res: Response) => {
  if (ipLimited(req, res)) return;
  const limit = intQuery(req, "limit", 20, 1, 100);
  if (limit === null) {
    res.status(400).json({ error: "limit must be an integer in [1, 100]" });
    return;
  }
  try {
    const rows = await networkStatusRepo.listIncidents(limit);
    setPublicCache(res, 60);
    res.json({ incidents: rows });
  } catch (err) {
    log.error("incident list failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(503).json({ error: "Incidents unavailable" });
  }
});

/** Groups below this many failed selections are not published (no singling out). */
export const WANTED_MIN_REQUESTS = 5;

// GET /v1/network/wanted?days=7 — aggregated unmet demand: where node operators are needed
router.get("/network/wanted", async (req: Request, res: Response) => {
  if (ipLimited(req, res)) return;
  const days = intQuery(req, "days", 7, 1, 30);
  if (days === null) {
    res.status(400).json({ error: "days must be an integer in [1, 30]" });
    return;
  }
  try {
    const rows = await networkStatusRepo.listWanted(days, WANTED_MIN_REQUESTS, 100);
    setPublicCache(res, 300);
    res.json({
      days, minRequests: WANTED_MIN_REQUESTS,
      description: "Country/class combinations requesters asked for when no eligible node was online. Running a node there is most likely to earn.",
      wanted: rows,
    });
  } catch (err) {
    log.error("wanted list failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(503).json({ error: "Wanted list unavailable" });
  }
});

// GET /v1/starter-credits — program terms + the caller's grant (agent auth)
router.get("/starter-credits", requireAgentPrincipal, async (req: Request, res: Response) => {
  const agent = (req as AgentRequest).agent;
  if (!readLimiter.hit(agent.userId)) {
    res.status(429).json({ error: "Too many requests", code: "RATE_LIMITED" });
    return;
  }
  try {
    const [s, g] = await Promise.all([starterCreditRepo.getSettings(), starterCreditRepo.getGrant(agent.userId)]);
    const seedOnly = g ? await starterCreditRepo.isSeedOnlyRequester(agent.userId) : false;
    res.json({
      program: {
        enabled: s.enabled,
        amount: money(s.amountMusd),
        expiryDays: s.expiryDays,
        seedNodesOnly: s.seedNodesOnly,
        seedOnlyDays: s.seedOnlyDays,
        withdrawable: false,
        countsTowardTiers: false,
      },
      grant: g
        ? {
            amount: money(g.amountMusd), remaining: money(g.remainingMusd), status: g.status,
            expiresAt: g.expiresAt, grantedAt: g.createdAt, seedNodesOnly: seedOnly,
          }
        : null,
    });
  } catch (err) {
    log.error("starter credits lookup failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to load starter credits" });
  }
});

export default router;
