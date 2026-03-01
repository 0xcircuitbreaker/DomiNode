import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";

// ─── Mocks ─────────────────────────────────────────────────────────────

vi.mock("@dominusnode/shared", () => ({
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

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import proxyHealthRouter from "./proxy-health.js";

// ─── Helpers ──────────────────────────────────────────────────────────

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/proxy", proxyHealthRouter);
  return app;
}

function request(
  app: express.Express,
  method: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
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
            resolve({ status: res.statusCode ?? 500, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 500, body: {} });
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

describe("proxy-health routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET /api/proxy/health ─────────────────────────────────────────

  describe("GET /api/proxy/health", () => {
    it("should return basic stats when proxy is reachable", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "healthy",
          activeSessions: 42,
          totalRequests: 1000,
          totalErrors: 5,
          avgLatencyMs: 150,
          uptimeSeconds: 3600,
          providers: [],
        }),
      });

      const app = createApp();
      const res = await request(app, "GET", "/api/proxy/health");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("healthy");
      // Public health endpoint only returns status (no operational details)
      expect(res.body.activeSessions).toBeUndefined();
      expect(res.body.uptimeSeconds).toBeUndefined();
    });

    it("should return unknown status when proxy is unreachable", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const app = createApp();
      const res = await request(app, "GET", "/api/proxy/health");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("unknown");
      // Public health endpoint only returns status (no operational details)
      expect(res.body.activeSessions).toBeUndefined();
      expect(res.body.uptimeSeconds).toBeUndefined();
    });
  });

  // ─── GET /api/proxy/status ─────────────────────────────────────────

  describe("GET /api/proxy/status", () => {
    it("should return detailed stats for authenticated user", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "healthy",
          activeSessions: 10,
          totalRequests: 500,
          totalErrors: 2,
          avgLatencyMs: 120,
          uptimeSeconds: 7200,
          providers: [
            {
              name: "webshare-dc",
              state: "healthy",
              consecutiveFailures: 0,
              totalRequests: 500,
              totalErrors: 2,
              avgLatencyMs: 120,
              fallbackOnly: false,
            },
          ],
        }),
      });

      const app = createApp();
      const res = await request(app, "GET", "/api/proxy/status");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("healthy");
      expect(res.body.activeSessions).toBe(10);
      expect(res.body.avgLatencyMs).toBe(120);
      expect(res.body.endpoints).toBeDefined();
      expect(res.body.supportedCountries).toBeDefined();
      // Non-admin users should NOT see provider details
      expect(res.body.providers).toBeUndefined();
    });

    it("should return defaults when proxy is unreachable", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const app = createApp();
      const res = await request(app, "GET", "/api/proxy/status");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("unknown");
      expect(res.body.activeSessions).toBe(0);
      expect(res.body.userActiveSessions).toBe(0);
      expect(res.body.avgLatencyMs).toBe(0);
      expect(res.body.providers).toEqual([]);
      expect(res.body.endpoints).toBeDefined();
      expect(res.body.supportedCountries).toBeDefined();
      expect(res.body.uptimeSeconds).toBe(0);
    });
  });
});
