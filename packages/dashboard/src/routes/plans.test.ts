import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";

// ─── Mocks ─────────────────────────────────────────────────────────────

const mockGetAllPlans = vi.fn();
const mockGetUserPlan = vi.fn();
const mockGetMonthlyUsage = vi.fn();
const mockGetPlan = vi.fn();
const mockSetUserPlan = vi.fn();
const mockGetWallet = vi.fn();
const mockPoolQuery = vi.fn();
const mockPoolClient = {
  query: mockPoolQuery,
  release: vi.fn(),
};
const mockPool = {
  connect: vi.fn(() => Promise.resolve(mockPoolClient)),
};

vi.mock("@dominode/shared", () => ({
  planRepo: {
    getAllPlans: (...args: unknown[]) => mockGetAllPlans(...args),
    getUserPlan: (...args: unknown[]) => mockGetUserPlan(...args),
    getMonthlyUsage: (...args: unknown[]) => mockGetMonthlyUsage(...args),
    getPlan: (...args: unknown[]) => mockGetPlan(...args),
    setUserPlan: (...args: unknown[]) => mockSetUserPlan(...args),
  },
  walletRepo: {
    getWallet: (...args: unknown[]) => mockGetWallet(...args),
  },
  getPool: () => mockPool,
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

import plansRouter from "./plans.js";

// ─── Helpers ──────────────────────────────────────────────────────────

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/plans", plansRouter);
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

function requestWithBody(
  app: express.Express,
  method: string,
  path: string,
  body: Record<string, unknown>,
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
      const payload = JSON.stringify(body);
      const options: http.RequestOptions = {
        hostname: "127.0.0.1",
        port,
        path,
        method: method.toUpperCase(),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
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
      req.write(payload);
      req.end();
    });
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("plans routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET /api/plans ────────────────────────────────────────────────

  describe("GET /api/plans", () => {
    it("should list all available plans", async () => {
      mockGetAllPlans.mockResolvedValueOnce([
        {
          id: "payg",
          name: "Pay As You Go",
          pricePerGbCents: 500,
          monthlyBandwidthBytes: 0,
          isDefault: false,
          maxConnections: 100,
        },
        {
          id: "vol100",
          name: "Volume 100GB",
          pricePerGbCents: 400,
          monthlyBandwidthBytes: 107_374_182_400,
          isDefault: false,
          maxConnections: 100,
        },
      ]);

      const app = createApp();
      const res = await request(app, "GET", "/api/plans");

      expect(res.status).toBe(200);
      const plans = res.body.plans as Array<Record<string, unknown>>;
      expect(plans).toHaveLength(2);
      expect(plans[0].id).toBe("payg");
      expect(plans[0].pricePerGbCents).toBe(500);
      expect(plans[0].pricePerGbUsd).toBe(5);
      expect(plans[0].monthlyBandwidthGB).toBeNull(); // 0 bytes => null
      expect(plans[0].isDefault).toBe(false);
      expect(plans[0].maxConnections).toBe(100);
      expect(plans[1].id).toBe("vol100");
      expect(plans[1].monthlyBandwidthGB).toBeCloseTo(100, 0);
      expect(plans[1].maxConnections).toBe(100);
    });

    it("should return 500 on DB error", async () => {
      mockGetAllPlans.mockRejectedValueOnce(new Error("DB error"));

      const app = createApp();
      const res = await request(app, "GET", "/api/plans");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to fetch plans");
    });
  });

  // ─── GET /api/plans/user/plan ──────────────────────────────────────

  describe("GET /api/plans/user/plan", () => {
    it("should return current user plan with usage", async () => {
      mockGetUserPlan.mockResolvedValueOnce({
        id: "payg",
        name: "Pay As You Go",
        pricePerGbCents: 500,
        monthlyBandwidthBytes: 0,
        isDefault: false,
        maxConnections: 100,
      });
      mockGetMonthlyUsage.mockResolvedValueOnce(536_870_912); // 0.5 GB

      const app = createApp();
      const res = await request(app, "GET", "/api/plans/user/plan");

      expect(res.status).toBe(200);
      expect((res.body.plan as Record<string, unknown>).id).toBe("payg");
      expect((res.body.usage as Record<string, unknown>).monthlyUsageBytes).toBe(536_870_912);
      // percentUsed should be null for unlimited plans (monthlyBandwidthBytes = 0)
      expect((res.body.usage as Record<string, unknown>).percentUsed).toBeNull();
    });

    it("should return 500 on DB error", async () => {
      mockGetUserPlan.mockRejectedValueOnce(new Error("DB error"));

      const app = createApp();
      const res = await request(app, "GET", "/api/plans/user/plan");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to fetch user plan");
    });
  });

  // ─── PUT /api/plans/user/plan ──────────────────────────────────────

  describe("PUT /api/plans/user/plan", () => {
    it("should change user plan successfully", async () => {
      mockGetPlan.mockResolvedValueOnce({
        id: "payg",
        name: "Pay As You Go",
        pricePerGbCents: 500,
        monthlyBandwidthBytes: 0,
        isDefault: false,
        maxConnections: 100,
      });
      mockSetUserPlan.mockResolvedValueOnce(undefined);

      const app = createApp();
      const res = await requestWithBody(app, "PUT", "/api/plans/user/plan", { planId: "payg" });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Plan updated successfully");
      expect((res.body.plan as Record<string, unknown>).id).toBe("payg");
      expect(mockSetUserPlan).toHaveBeenCalledWith("test-user-id", "payg");
    });

    it("should return 403 when plan is not user-selectable", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "PUT", "/api/plans/user/plan", { planId: "enterprise" });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("cannot be selected");
      expect(mockSetUserPlan).not.toHaveBeenCalled();
    });

    it("should return 404 when plan not found", async () => {
      // Use a planId that passes the allowlist but doesn't exist in DB
      mockGetPlan.mockResolvedValueOnce(null);

      const app = createApp();
      const res = await requestWithBody(app, "PUT", "/api/plans/user/plan", { planId: "vol100" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Plan not found");
      expect(mockSetUserPlan).not.toHaveBeenCalled();
    });

    it("should return 400 when planId is missing", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "PUT", "/api/plans/user/plan", {});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("planId is required");
    });

    it("should return 402 when volume plan min balance not met", async () => {
      mockGetPlan.mockResolvedValueOnce({
        id: "vol100",
        name: "Volume 100GB",
        pricePerGbCents: 400,
        monthlyBandwidthBytes: 107_374_182_400,
        isDefault: false,
        maxConnections: 100,
      });
      // Mock pool client queries: BEGIN, SELECT FOR UPDATE (low balance), ROLLBACK
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ balance_cents: 500 }] }) // SELECT (only $5, needs $10)
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      const app = createApp();
      const res = await requestWithBody(app, "PUT", "/api/plans/user/plan", { planId: "vol100" });

      expect(res.status).toBe(402);
      expect(res.body.error).toContain("Minimum wallet balance");
      expect(mockSetUserPlan).not.toHaveBeenCalled();
    });

    it("should return 402 when wallet not found for volume plan", async () => {
      mockGetPlan.mockResolvedValueOnce({
        id: "vol1tb",
        name: "Volume 1TB",
        pricePerGbCents: 300,
        monthlyBandwidthBytes: 1_099_511_627_776,
        isDefault: false,
        maxConnections: 100,
      });
      // Mock pool client queries: BEGIN, SELECT FOR UPDATE (no wallet), ROLLBACK
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT (no wallet found)
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      const app = createApp();
      const res = await requestWithBody(app, "PUT", "/api/plans/user/plan", { planId: "vol1tb" });

      expect(res.status).toBe(402);
      expect(res.body.error).toContain("Minimum wallet balance");
    });

    it("should change volume plan successfully when balance is sufficient", async () => {
      mockGetPlan.mockResolvedValueOnce({
        id: "vol100",
        name: "Volume 100GB",
        pricePerGbCents: 400,
        monthlyBandwidthBytes: 107_374_182_400,
        isDefault: false,
        maxConnections: 100,
      });
      // Mock pool client queries: BEGIN, SELECT FOR UPDATE (sufficient balance), INSERT, COMMIT
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ balance_cents: 2000 }] }) // SELECT ($20 >= $10 min)
        .mockResolvedValueOnce({ rows: [] }) // INSERT (plan update)
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const app = createApp();
      const res = await requestWithBody(app, "PUT", "/api/plans/user/plan", { planId: "vol100" });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Plan updated successfully");
      expect((res.body.plan as Record<string, unknown>).id).toBe("vol100");
      // Should use transaction, not planRepo.setUserPlan
      expect(mockSetUserPlan).not.toHaveBeenCalled();
      expect(mockPoolQuery).toHaveBeenCalledTimes(4);
    });

    it("should return 500 on DB error during plan change", async () => {
      mockGetPlan.mockResolvedValueOnce({
        id: "payg",
        name: "Pay As You Go",
        pricePerGbCents: 500,
        monthlyBandwidthBytes: 0,
        isDefault: false,
        maxConnections: 100,
      });
      mockSetUserPlan.mockRejectedValueOnce(new Error("DB error"));

      const app = createApp();
      const res = await requestWithBody(app, "PUT", "/api/plans/user/plan", { planId: "payg" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to update plan");
    });
  });
});
