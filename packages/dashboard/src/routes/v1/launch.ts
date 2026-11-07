import { Router } from "express";
import type { Request, Response } from "express";
import * as crypto from "node:crypto";
import { createLogger, query, starterCreditRepo, networkStatusRepo, powChallengeRepo, verifyPow } from "@dominusnode/shared";
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

// ─── Public abuse-report intake (PoW gated, captcha-free) ───────────

const _ad = Number(process.env["ABUSE_REPORT_POW_DIFFICULTY"] ?? "20");
export const ABUSE_POW_DIFFICULTY = Number.isInteger(_ad) && _ad >= 10 && _ad <= 32 ? _ad : 20;
const abuseChallengeLimiter = createKeyedLimiter(20, 60 * 60_000);
const abuseSubmitLimiter = createKeyedLimiter(5, 60 * 60_000);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const ABUSE_CATEGORIES = ["spam", "credential_stuffing", "scraping", "fraud", "ddos", "illegal_content", "other"] as const;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// POST /v1/abuse-reports/challenge — a single-use proof-of-work puzzle
router.post("/abuse-reports/challenge", async (req: Request, res: Response) => {
  const ip = req.ip;
  if (!ip) {
    res.status(400).json({ error: "Unable to determine client IP" });
    return;
  }
  if (!abuseChallengeLimiter.hit(ip)) {
    res.status(429).json({ error: "Too many challenge requests. Try again later.", code: "RATE_LIMITED" });
    return;
  }
  try {
    if ((await powChallengeRepo.countActiveChallengesForIp(ip)) >= 5) {
      res.status(429).json({ error: "Too many pending challenges. Try again later.", code: "RATE_LIMITED" });
      return;
    }
    const pow = await powChallengeRepo.createChallenge(crypto.randomBytes(16).toString("hex"), ABUSE_POW_DIFFICULTY, ip);
    res.json({
      challengeId: pow.id, prefix: pow.prefix, difficulty: pow.difficulty, algorithm: "sha256",
      rule: "find nonce (<= 32 chars) so that sha256(prefix + nonce) has `difficulty` leading zero bits",
      expiresAt: new Date(pow.created_at.getTime() + powChallengeRepo.POW_CHALLENGE_TTL_MS).toISOString(),
    });
  } catch (err) {
    log.error("abuse challenge failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to create challenge" });
  }
});

export interface AbuseReportInput {
  destHost: string; windowStart: Date; windowEnd: Date; category: string; description: string; contact: string | null;
}

/** Validate a report body (exported for tests). Returns an error string or the parsed input. */
export function parseAbuseReport(b: Record<string, unknown>, now = Date.now()): AbuseReportInput | string {
  const allowed = new Set(["pow", "destHost", "windowStart", "windowEnd", "category", "description", "contact"]);
  for (const k of Object.keys(b)) if (!allowed.has(k)) return `${k.slice(0, 40)}: unknown field`;
  const host = typeof b["destHost"] === "string" ? b["destHost"].trim().toLowerCase().replace(/\.$/, "") : "";
  if (!HOST_RE.test(host) || /^[0-9.]+$/.test(host)) return "destHost must be a bare hostname (no scheme, path, port or IP)";
  const ws = new Date(String(b["windowStart"] ?? ""));
  const we = new Date(String(b["windowEnd"] ?? ""));
  if (Number.isNaN(ws.getTime()) || Number.isNaN(we.getTime())) return "windowStart and windowEnd must be ISO dates";
  if (we < ws) return "windowEnd must not be before windowStart";
  if (we.getTime() - ws.getTime() > 31 * 86_400_000) return "time window must be at most 31 days";
  if (ws.getTime() < now - 365 * 86_400_000 || we.getTime() > now + 3_600_000) return "time window must be within the last year";
  const category = b["category"] === undefined ? "other" : String(b["category"]);
  if (!(ABUSE_CATEGORIES as readonly string[]).includes(category)) return `category must be one of ${ABUSE_CATEGORIES.join("|")}`;
  const description = typeof b["description"] === "string" ? b["description"].trim() : "";
  if (description.length < 10 || description.length > 4000 || CONTROL.test(description)) return "description must be 10-4000 printable chars";
  let contact: string | null = null;
  if (b["contact"] !== undefined && b["contact"] !== null && b["contact"] !== "") {
    if (typeof b["contact"] !== "string" || b["contact"].length > 254 || CONTROL.test(b["contact"])) return "contact must be at most 254 printable chars";
    contact = b["contact"].trim();
  }
  return { destHost: host, windowStart: ws, windowEnd: we, category, description, contact };
}

// POST /v1/abuse-reports {pow:{challengeId, nonce}, destHost, windowStart, windowEnd, category?, description, contact?}
router.post("/abuse-reports", async (req: Request, res: Response) => {
  const ip = req.ip;
  if (!ip) {
    res.status(400).json({ error: "Unable to determine client IP" });
    return;
  }
  const b = (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
  const pow = (b["pow"] && typeof b["pow"] === "object" ? b["pow"] : {}) as Record<string, unknown>;
  const powId = typeof pow["challengeId"] === "string" ? pow["challengeId"] : "";
  const powNonce = typeof pow["nonce"] === "string" || typeof pow["nonce"] === "number" ? String(pow["nonce"]) : "";
  if (!UUID_RE.test(powId) || !powNonce || powNonce.length > 32) {
    res.status(400).json({ error: "A proof-of-work solution is required (POST /v1/abuse-reports/challenge)", code: "POW_REQUIRED" });
    return;
  }
  const parsed = parseAbuseReport(b);
  if (typeof parsed === "string") {
    res.status(400).json({ error: parsed });
    return;
  }
  if (!abuseSubmitLimiter.hit(ip)) {
    res.status(429).json({ error: "Too many reports from this address. Try again later.", code: "RATE_LIMITED" });
    return;
  }
  try {
    // Consume the single-use challenge BEFORE checking the solution (no retries on one puzzle).
    const row = await powChallengeRepo.consumeChallenge(powId, ip);
    if (!row || row.difficulty < ABUSE_POW_DIFFICULTY || !verifyPow(row.prefix, powNonce, row.difficulty)) {
      res.status(400).json({ error: "Invalid or expired proof-of-work solution", code: "POW_INVALID" });
      return;
    }
    const ins = await query<{ id: string; created_at: Date }>(
      `INSERT INTO abuse_reports (dest_host, window_start, window_end, category, description, contact)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [parsed.destHost, parsed.windowStart.toISOString(), parsed.windowEnd.toISOString(), parsed.category, parsed.description, parsed.contact],
    );
    log.info("abuse report received", { id: ins.rows[0]?.id, category: parsed.category });
    res.status(201).json({ id: ins.rows[0]?.id, status: "new", receivedAt: ins.rows[0]?.created_at, responseTarget: "24h" });
  } catch (err) {
    log.error("abuse report insert failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to store report" });
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
