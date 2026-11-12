import { Router } from "express";
import { usageRepo, createLogger, RELAY_BYTES_PER_GB } from "@dominusnode/shared";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();
const log = createLogger("api:usage");

router.use(requireAuth);

// GET /api/usage
router.get("/", async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;

    let since = req.query.since
      ? new Date(req.query.since as string)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const until = req.query.until
      ? new Date(req.query.until as string)
      : new Date();

    // Validate parsed dates
    if (isNaN(since.getTime()) || isNaN(until.getTime())) {
      res.status(400).json({ error: "Invalid date format for 'since' or 'until'" });
      return;
    }

    // Cap date range to max 90 days
    const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;
    if (until.getTime() - since.getTime() > MAX_RANGE_MS) {
      since = new Date(until.getTime() - MAX_RANGE_MS);
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 200, 1), 1000);
    const offset = Math.min(Math.max(parseInt(req.query.offset as string, 10) || 0, 0), 1_000_000);

    const [usageData, summary] = await Promise.all([
      usageRepo.getUsageByUser(userId, since, until, limit, offset),
      usageRepo.getUsageSummary(userId, since),
    ]);

    res.json({
      summary: {
        totalBytes: summary.total_bytes,
        totalCostCents: summary.total_cost_cents,
        requestCount: summary.request_count,
        totalGB: Number((summary.total_bytes / RELAY_BYTES_PER_GB).toFixed(4)),
        totalCostUsd: Number((summary.total_cost_cents / 100).toFixed(2)),
      },
      records: usageData.rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        bytesIn: Number(r.bytes_in),
        bytesOut: Number(r.bytes_out),
        totalBytes: Number(r.bytes_in) + Number(r.bytes_out),
        costCents: Number(r.cost_cents),
        proxyType: r.proxy_type,
        targetHost: r.target_host,
        createdAt: r.created_at,
      })),
      pagination: { limit, offset, total: usageData.total },
      period: { since, until },
    });
  } catch (err) {
    log.error("usage query failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to fetch usage data" });
  }
});

// GET /api/usage/daily — daily aggregation for charts
router.get("/daily", async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;

    let since = req.query.since
      ? new Date(req.query.since as string)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const until = req.query.until
      ? new Date(req.query.until as string)
      : new Date();

    if (isNaN(since.getTime()) || isNaN(until.getTime())) {
      res.status(400).json({ error: "Invalid date format" });
      return;
    }

    const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;
    if (until.getTime() - since.getTime() > MAX_RANGE_MS) {
      since = new Date(until.getTime() - MAX_RANGE_MS);
    }

    const daily = await usageRepo.getUsageByDay(userId, since, until);

    res.json({
      days: daily.map((d) => ({
        date: d.date,
        totalBytes: d.total_bytes,
        totalGB: Number((d.total_bytes / RELAY_BYTES_PER_GB).toFixed(4)),
        totalCostCents: d.total_cost_cents,
        totalCostUsd: Number((d.total_cost_cents / 100).toFixed(2)),
        requestCount: d.request_count,
      })),
      period: { since, until },
    });
  } catch (err) {
    log.error("daily usage query failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to fetch daily usage data" });
  }
});

// GET /api/usage/top-hosts — top target hosts by bandwidth
router.get("/top-hosts", async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;

    let since = req.query.since
      ? new Date(req.query.since as string)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const until = req.query.until
      ? new Date(req.query.until as string)
      : new Date();

    if (isNaN(since.getTime()) || isNaN(until.getTime())) {
      res.status(400).json({ error: "Invalid date format" });
      return;
    }

    const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;
    if (until.getTime() - since.getTime() > MAX_RANGE_MS) {
      since = new Date(until.getTime() - MAX_RANGE_MS);
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 10, 1), 50);

    const hosts = await usageRepo.getTopHosts(userId, since, until, limit);

    res.json({
      hosts: hosts.map((h) => ({
        targetHost: h.targetHost,
        totalBytes: h.totalBytes,
        totalGB: Number((h.totalBytes / RELAY_BYTES_PER_GB).toFixed(4)),
        requestCount: h.requestCount,
      })),
      period: { since, until },
    });
  } catch (err) {
    log.error("top hosts query failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to fetch top hosts" });
  }
});


function sanitizeCsvField(value: string): string {
  // Escape double quotes by doubling them
  let escaped = value.replace(/"/g, '""');
  // Prefix formula-triggering characters with a single quote
  if (/^[=+\-@\t\r]/.test(escaped)) {
    escaped = "'" + escaped;
  }
  // Always wrap in double quotes
  return '"' + escaped + '"';
}

// GET /api/usage/export — CSV export of usage records
router.get("/export", async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;

    let since = req.query.since
      ? new Date(req.query.since as string)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const until = req.query.until
      ? new Date(req.query.until as string)
      : new Date();

    if (isNaN(since.getTime()) || isNaN(until.getTime())) {
      res.status(400).json({ error: "Invalid date format" });
      return;
    }

    const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;
    if (until.getTime() - since.getTime() > MAX_RANGE_MS) {
      since = new Date(until.getTime() - MAX_RANGE_MS);
    }

    // Fetch all records in the range (up to 10000 for export)
    const usageData = await usageRepo.getUsageByUser(userId, since, until, 10000, 0);

    const dateStr = new Date().toISOString().split("T")[0];
    const filename = `dominusnode-usage-${dateStr}.csv`;

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    // Write CSV header
    const header = "Date,Session ID,Target Host,Bytes In,Bytes Out,Total Bytes,Cost (USD)\n";
    const rows = usageData.rows.map((r) => {
      const date = new Date(r.created_at).toISOString();
      const totalBytes = Number(r.bytes_in) + Number(r.bytes_out);
      const costUsd = (r.cost_cents / 100).toFixed(4);
      return `${sanitizeCsvField(date)},${sanitizeCsvField(r.session_id ?? "")},${sanitizeCsvField(r.target_host)},${r.bytes_in},${r.bytes_out},${totalBytes},${costUsd}`;
    });

    res.send(header + rows.join("\n"));
  } catch (err) {
    log.error("usage export failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to export usage data" });
  }
});

export default router;
