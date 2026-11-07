import { Router } from "express";
import type { Request, Response } from "express";
import { createLogger, starterCreditRepo } from "@dominusnode/shared";
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
