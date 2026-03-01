import { Router } from "express";
import { createLogger, query, sanitizeString } from "@dominusnode/shared";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import rateLimit from "express-rate-limit";

const router = Router();
const log = createLogger("api:bug-reports");

const BUG_CATEGORIES = new Set(["quality", "security"]);
const BUG_PRIORITIES = new Set(["p1", "p2", "p3"]);

// Rate limit: 5 bug reports per hour per user (prevent spam)
const submitLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Bug report rate limit exceeded. Max 5 per hour." },
});

// All bug report routes require authentication
router.use(requireAuth);

// POST /api/bug-reports — submit a bug report (authenticated users)
router.post("/", submitLimiter, async (req, res) => {
  const { userId } = (req as unknown as AuthenticatedRequest).user;

  const { category, priority, title, description, integration, sdkVersion, traceIds, stepsToReproduce, impact } = req.body as {
    category?: string;
    priority?: string;
    title?: string;
    description?: string;
    integration?: string;
    sdkVersion?: string;
    traceIds?: string[];
    stepsToReproduce?: string;
    impact?: string;
  };

  // Validate required fields
  if (!category || !BUG_CATEGORIES.has(category)) {
    res.status(400).json({ error: "category must be 'quality' or 'security'" });
    return;
  }
  if (priority && !BUG_PRIORITIES.has(priority)) {
    res.status(400).json({ error: "priority must be 'p1', 'p2', or 'p3'" });
    return;
  }
  if (!title || title.length < 5 || title.length > 200) {
    res.status(400).json({ error: "title must be 5-200 characters" });
    return;
  }
  if (!description || description.length < 10 || description.length > 5000) {
    res.status(400).json({ error: "description must be 10-5000 characters" });
    return;
  }

  // Sanitize optional fields
  const safeTitle = sanitizeString(title, 200);
  const safeDesc = sanitizeString(description, 5000);
  const safeIntegration = integration ? sanitizeString(integration, 100) : null;
  const safeSdkVersion = sdkVersion ? sanitizeString(sdkVersion, 50) : null;
  const safeSteps = stepsToReproduce ? sanitizeString(stepsToReproduce, 5000) : null;
  const safeImpact = impact ? sanitizeString(impact, 1000) : null;

  // Validate trace_ids array (max 10 entries, each max 100 chars)
  let safeTraceIds: string[] = [];
  if (Array.isArray(traceIds)) {
    safeTraceIds = traceIds
      .slice(0, 10)
      .filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 100)
      .map((t) => sanitizeString(t, 100));
  }

  try {
    const result = await query(
      `INSERT INTO bug_reports (user_id, category, priority, title, description, integration, sdk_version, trace_ids, steps_to_reproduce, impact)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, category, priority, title, status, created_at`,
      [userId, category, priority ?? "p3", safeTitle, safeDesc, safeIntegration, safeSdkVersion, safeTraceIds, safeSteps, safeImpact],
    );

    if (!result || result.rows.length === 0) {
      res.status(500).json({ error: "Failed to submit bug report" });
      return;
    }

    log.info("bug report submitted", { reportId: result.rows[0].id, userId, category, priority: priority ?? "p3" });
    res.status(201).json({
      message: "Bug report submitted. You will receive credits if approved.",
      report: result.rows[0],
      creditRanges: {
        p3: "$0.05-$0.25 credits",
        p2: "$0.50-$2.50 credits",
        p1: "$2.50-$10.00 credits",
      },
    });
  } catch (err) {
    log.error("failed to submit bug report", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to submit bug report" });
  }
});

// GET /api/bug-reports — list own bug reports
router.get("/", async (req, res) => {
  const { userId } = (req as unknown as AuthenticatedRequest).user;
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
  const offset = (page - 1) * limit;

  try {
    const result = await query(
      `SELECT id, category, priority, title, status, credit_amount_cents, created_at, reviewed_at
       FROM bug_reports WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    const countResult = await query(
      `SELECT count(*) as total FROM bug_reports WHERE user_id = $1`,
      [userId],
    );
    const total = parseInt((countResult?.rows[0] as { total: string })?.total ?? "0", 10);

    res.json({
      reports: result?.rows ?? [],
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    log.error("failed to list bug reports", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to list bug reports" });
  }
});

// GET /api/bug-reports/:id — get own bug report details
router.get("/:id", async (req, res) => {
  const { userId } = (req as unknown as AuthenticatedRequest).user;
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(req.params.id)) {
    res.status(400).json({ error: "Invalid report ID" });
    return;
  }

  try {
    const result = await query(
      `SELECT id, category, priority, title, description, integration, sdk_version, trace_ids,
              steps_to_reproduce, impact, status, credit_amount_cents, created_at, reviewed_at
       FROM bug_reports WHERE id = $1 AND user_id = $2`,
      [req.params.id, userId],
    );
    if (!result || result.rows.length === 0) {
      res.status(404).json({ error: "Bug report not found" });
      return;
    }
    res.json({ report: result.rows[0] });
  } catch (err) {
    log.error("failed to get bug report", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to get bug report" });
  }
});

export default router;
