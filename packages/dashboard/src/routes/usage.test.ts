import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";

// ─── Mocks ─────────────────────────────────────────────────────────────

const mockGetUsageByUser = vi.fn();
const mockGetUsageSummary = vi.fn();
const mockGetUsageByDay = vi.fn();
const mockGetTopHosts = vi.fn();

vi.mock("@dominusnode/shared", () => ({
  usageRepo: {
    getUsageByUser: (...args: unknown[]) => mockGetUsageByUser(...args),
    getUsageSummary: (...args: unknown[]) => mockGetUsageSummary(...args),
    getUsageByDay: (...args: unknown[]) => mockGetUsageByDay(...args),
    getTopHosts: (...args: unknown[]) => mockGetTopHosts(...args),
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    (req as unknown as { user: { userId: string; email: string; isAdmin: boolean } }).user = {
      userId: "test-user-id",
      email: "test@test.com",
      isAdmin: false,
    };
    next();
  },
}));

import usageRouter from "./usage.js";

// ─── Helpers ──────────────────────────────────────────────────────────

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/usage", usageRouter);
  return app;
}

function request(
  app: express.Express,
  method: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to get server address"));
        return;
      }
      const port = addr.port;
      const options: http.RequestOptions = {
        hostname: "127.0.0.1",
        port,
        path,
        method: method.toUpperCase(),
        headers: { "Content-Type": "application/json" },
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          server.close();
          try {
            resolve({ status: res.statusCode ?? 500, body: JSON.parse(data), raw: data });
          } catch {
            resolve({ status: res.statusCode ?? 500, body: {}, raw: data });
          }
        });
      });
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("usage routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET /api/usage ────────────────────────────────────────────────

  describe("GET /api/usage", () => {
    it("should return usage data with summary and pagination", async () => {
      mockGetUsageByUser.mockResolvedValueOnce({
        rows: [
          {
            id: "rec-1",
            session_id: "sess-1",
            bytes_in: 1000,
            bytes_out: 2000,
            cost_cents: 10,
            proxy_type: "http",
            target_host: "example.com",
            created_at: "2025-01-01T00:00:00Z",
          },
        ],
        total: 1,
      });
      mockGetUsageSummary.mockResolvedValueOnce({
        total_bytes: 3000,
        total_cost_cents: 10,
        request_count: 1,
      });

      const app = createApp();
      const res = await request(app, "GET", "/api/usage");

      expect(res.status).toBe(200);
      expect(res.body.summary).toBeDefined();
      const summary = res.body.summary as Record<string, unknown>;
      expect(summary.totalBytes).toBe(3000);
      expect(summary.totalCostCents).toBe(10);
      expect(summary.requestCount).toBe(1);

      const records = res.body.records as Array<Record<string, unknown>>;
      expect(records).toHaveLength(1);
      expect(records[0].sessionId).toBe("sess-1");
      expect(records[0].bytesIn).toBe(1000);
      expect(records[0].bytesOut).toBe(2000);
      expect(records[0].totalBytes).toBe(3000);
      expect(records[0].costCents).toBe(10);

      const pagination = res.body.pagination as Record<string, unknown>;
      expect(pagination.total).toBe(1);
      expect(pagination.limit).toBe(200);
      expect(pagination.offset).toBe(0);
    });

    it("should use custom since/until date parameters", async () => {
      mockGetUsageByUser.mockResolvedValueOnce({ rows: [], total: 0 });
      mockGetUsageSummary.mockResolvedValueOnce({
        total_bytes: 0,
        total_cost_cents: 0,
        request_count: 0,
      });

      const app = createApp();
      const since = "2025-01-01T00:00:00Z";
      const until = "2025-01-31T23:59:59Z";
      const res = await request(app, "GET", `/api/usage?since=${since}&until=${until}`);

      expect(res.status).toBe(200);
      // Verify the since/until dates were passed to the repo
      expect(mockGetUsageByUser).toHaveBeenCalledWith(
        "test-user-id",
        expect.any(Date),
        expect.any(Date),
        200,
        0,
      );
    });

    it("should return 400 for invalid date format", async () => {
      const app = createApp();
      const res = await request(app, "GET", "/api/usage?since=not-a-date");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid date format for 'since' or 'until'");
    });

    it("should cap date range to 90 days", async () => {
      mockGetUsageByUser.mockResolvedValueOnce({ rows: [], total: 0 });
      mockGetUsageSummary.mockResolvedValueOnce({
        total_bytes: 0,
        total_cost_cents: 0,
        request_count: 0,
      });

      const app = createApp();
      // Request a 180-day range — should be capped to 90
      const until = "2025-06-01T00:00:00Z";
      const since = "2024-12-01T00:00:00Z"; // ~183 days before until
      const res = await request(app, "GET", `/api/usage?since=${since}&until=${until}`);

      expect(res.status).toBe(200);
      // The since date should have been capped: period.since should be ~90 days before until
      const period = res.body.period as Record<string, string>;
      const actualSince = new Date(period.since);
      const actualUntil = new Date(period.until);
      const daysDiff = (actualUntil.getTime() - actualSince.getTime()) / (24 * 60 * 60 * 1000);
      expect(daysDiff).toBeLessThanOrEqual(90);
    });

    it("should respect limit and offset query params", async () => {
      mockGetUsageByUser.mockResolvedValueOnce({ rows: [], total: 0 });
      mockGetUsageSummary.mockResolvedValueOnce({
        total_bytes: 0,
        total_cost_cents: 0,
        request_count: 0,
      });

      const app = createApp();
      const res = await request(app, "GET", "/api/usage?limit=50&offset=10");

      expect(res.status).toBe(200);
      const pagination = res.body.pagination as Record<string, unknown>;
      expect(pagination.limit).toBe(50);
      expect(pagination.offset).toBe(10);
    });

    it("should return 500 on DB error", async () => {
      mockGetUsageByUser.mockRejectedValueOnce(new Error("DB error"));

      const app = createApp();
      const res = await request(app, "GET", "/api/usage");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to fetch usage data");
    });
  });

  // ─── GET /api/usage/daily ──────────────────────────────────────────

  describe("GET /api/usage/daily", () => {
    it("should return daily aggregation data", async () => {
      mockGetUsageByDay.mockResolvedValueOnce([
        {
          date: "2025-01-01",
          total_bytes: 1_073_741_824,
          total_cost_cents: 500,
          request_count: 100,
        },
        {
          date: "2025-01-02",
          total_bytes: 2_147_483_648,
          total_cost_cents: 1000,
          request_count: 200,
        },
      ]);

      const app = createApp();
      const res = await request(app, "GET", "/api/usage/daily");

      expect(res.status).toBe(200);
      const days = res.body.days as Array<Record<string, unknown>>;
      expect(days).toHaveLength(2);
      expect(days[0].date).toBe("2025-01-01");
      expect(days[0].totalBytes).toBe(1_073_741_824);
      expect(days[0].totalGB).toBe(1);
      expect(days[0].totalCostCents).toBe(500);
      expect(days[0].totalCostUsd).toBe(5);
      expect(days[0].requestCount).toBe(100);
    });

    it("should return 400 for invalid date format", async () => {
      const app = createApp();
      const res = await request(app, "GET", "/api/usage/daily?since=garbage");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid date format");
    });

    it("should return 500 on DB error", async () => {
      mockGetUsageByDay.mockRejectedValueOnce(new Error("DB error"));

      const app = createApp();
      const res = await request(app, "GET", "/api/usage/daily");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to fetch daily usage data");
    });
  });

  // ─── GET /api/usage/top-hosts ──────────────────────────────────────

  describe("GET /api/usage/top-hosts", () => {
    it("should return top hosts by bandwidth", async () => {
      mockGetTopHosts.mockResolvedValueOnce([
        { targetHost: "api.example.com", totalBytes: 5_000_000_000, requestCount: 500 },
        { targetHost: "cdn.example.com", totalBytes: 2_000_000_000, requestCount: 200 },
      ]);

      const app = createApp();
      const res = await request(app, "GET", "/api/usage/top-hosts");

      expect(res.status).toBe(200);
      const hosts = res.body.hosts as Array<Record<string, unknown>>;
      expect(hosts).toHaveLength(2);
      expect(hosts[0].targetHost).toBe("api.example.com");
      expect(hosts[0].totalBytes).toBe(5_000_000_000);
      expect(hosts[0].requestCount).toBe(500);
      expect(typeof hosts[0].totalGB).toBe("number");
    });

    it("should return 400 for invalid date format", async () => {
      const app = createApp();
      const res = await request(app, "GET", "/api/usage/top-hosts?since=invalid");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid date format");
    });
  });

  // ─── GET /api/usage/export ─────────────────────────────────────────

  describe("GET /api/usage/export", () => {
    it("should return CSV data with correct headers", async () => {
      mockGetUsageByUser.mockResolvedValueOnce({
        rows: [
          {
            id: "rec-1",
            session_id: "sess-1",
            bytes_in: 1000,
            bytes_out: 2000,
            cost_cents: 10,
            proxy_type: "http",
            target_host: "example.com",
            created_at: "2025-01-15T10:30:00Z",
          },
        ],
        total: 1,
      });

      const app = createApp();
      const res = await request(app, "GET", "/api/usage/export");

      expect(res.status).toBe(200);
      // CSV response — raw contains the CSV text
      expect(res.raw).toContain("Date,Session ID,Target Host,Bytes In,Bytes Out,Total Bytes,Cost (USD)");
      expect(res.raw).toContain("sess-1");
      expect(res.raw).toContain("example.com");
      expect(res.raw).toContain("3000"); // bytes_in + bytes_out
    });

    it("should return 400 for invalid date format in export", async () => {
      const app = createApp();
      const res = await request(app, "GET", "/api/usage/export?since=bad-date");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid date format");
    });

    it("should return 500 on DB error during export", async () => {
      mockGetUsageByUser.mockRejectedValueOnce(new Error("DB error"));

      const app = createApp();
      const res = await request(app, "GET", "/api/usage/export");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to export usage data");
    });
  });
});
