import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";

// ─── Mocks ─────────────────────────────────────────────────────────────

const mockCreateWallet = vi.fn();
const mockListWallets = vi.fn();
const mockGetWallet = vi.fn();
const mockFundWallet = vi.fn();
const mockGetTransactions = vi.fn();
const mockFreezeWallet = vi.fn();
const mockDeleteWallet = vi.fn();

const mockUnfreezeWallet = vi.fn();

vi.mock("@dominusnode/shared", () => ({
  agenticWalletRepo: {
    createWallet: (...args: unknown[]) => mockCreateWallet(...args),
    listWallets: (...args: unknown[]) => mockListWallets(...args),
    getWallet: (...args: unknown[]) => mockGetWallet(...args),
    fundWallet: (...args: unknown[]) => mockFundWallet(...args),
    getTransactions: (...args: unknown[]) => mockGetTransactions(...args),
    freezeWallet: (...args: unknown[]) => mockFreezeWallet(...args),
    unfreezeWallet: (...args: unknown[]) => mockUnfreezeWallet(...args),
    deleteWallet: (...args: unknown[]) => mockDeleteWallet(...args),
  },
  SUPPORTED_CRYPTO: ["btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb"] as const,
  sanitizeString: (s: string, maxLen: number) => {
    if (typeof s !== "string") return "";
    return s.trim().replace(/<[^>]*>/g, "").slice(0, maxLen);
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

import agentWalletRouter from "./agent-wallet.js";

// ─── Helpers ──────────────────────────────────────────────────────────

const VALID_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/agent-wallet", agentWalletRouter);
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

describe("agent-wallet routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── POST /api/agent-wallet ─────────────────────────────────────────

  describe("POST /api/agent-wallet", () => {
    it("should create a new agentic wallet", async () => {
      mockCreateWallet.mockResolvedValueOnce({
        id: VALID_UUID,
        user_id: "test-user-id",
        label: "scraper-bot",
        balance_cents: 0,
        spending_limit_cents: 10000,
        status: "active",
        created_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/agent-wallet", {
        label: "scraper-bot",
        spendingLimitCents: 10000,
      });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe(VALID_UUID);
      expect(res.body.label).toBe("scraper-bot");
      expect(res.body.balanceCents).toBe(0);
      expect(res.body.spendingLimitCents).toBe(10000);
      expect(res.body.status).toBe("active");
      expect(mockCreateWallet).toHaveBeenCalledWith("test-user-id", "scraper-bot", 10000);
    });

    it("should return 400 for empty label", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/agent-wallet", {
        label: "",
        spendingLimitCents: 5000,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Label must be 1-100 characters");
      expect(mockCreateWallet).not.toHaveBeenCalled();
    });

    it("should truncate label over 100 chars via sanitizeString", async () => {
      mockCreateWallet.mockResolvedValueOnce({
        id: VALID_UUID,
        label: "a".repeat(100),
        balance_cents: 0,
        spending_limit_cents: 5000,
        status: "active",
        created_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/agent-wallet", {
        label: "a".repeat(200),
        spendingLimitCents: 5000,
      });

      // sanitizeString truncates to 100 chars, so the request succeeds
      expect(res.status).toBe(201);
      expect(mockCreateWallet).toHaveBeenCalledWith("test-user-id", "a".repeat(100), 5000);
    });

    it("should return 400 for negative spending limit", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/agent-wallet", {
        label: "test",
        spendingLimitCents: -1,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Spending limit");
    });

    it("should return 400 for spending limit over 1M", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/agent-wallet", {
        label: "test",
        spendingLimitCents: 1_000_001,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Spending limit");
    });

    it("should return 409 when max wallet limit reached", async () => {
      mockCreateWallet.mockRejectedValueOnce(new Error("Maximum of 10 agentic wallets per user"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/agent-wallet", {
        label: "test",
        spendingLimitCents: 5000,
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Maximum of");
    });

    it("should return 500 on unexpected error", async () => {
      mockCreateWallet.mockRejectedValueOnce(new Error("DB connection error"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/agent-wallet", {
        label: "test",
        spendingLimitCents: 5000,
      });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to create agentic wallet");
    });
  });

  // ─── GET /api/agent-wallet ──────────────────────────────────────────

  describe("GET /api/agent-wallet", () => {
    it("should list all wallets", async () => {
      mockListWallets.mockResolvedValueOnce([
        {
          id: VALID_UUID,
          label: "bot-1",
          balance_cents: 500,
          spending_limit_cents: 10000,
          status: "active",
          created_at: "2026-02-18T00:00:00Z",
        },
      ]);

      const app = createApp();
      const res = await request(app, "GET", "/api/agent-wallet");

      expect(res.status).toBe(200);
      const wallets = res.body.wallets as Array<Record<string, unknown>>;
      expect(wallets).toHaveLength(1);
      expect(wallets[0].id).toBe(VALID_UUID);
      expect(wallets[0].label).toBe("bot-1");
      expect(wallets[0].balanceCents).toBe(500);
      expect(mockListWallets).toHaveBeenCalledWith("test-user-id");
    });

    it("should return empty array when no wallets", async () => {
      mockListWallets.mockResolvedValueOnce([]);

      const app = createApp();
      const res = await request(app, "GET", "/api/agent-wallet");

      expect(res.status).toBe(200);
      expect((res.body.wallets as unknown[]).length).toBe(0);
    });

    it("should return 500 on DB error", async () => {
      mockListWallets.mockRejectedValueOnce(new Error("DB error"));

      const app = createApp();
      const res = await request(app, "GET", "/api/agent-wallet");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to list agentic wallets");
    });
  });

  // ─── GET /api/agent-wallet/:id ──────────────────────────────────────

  describe("GET /api/agent-wallet/:id", () => {
    it("should return a wallet by ID", async () => {
      mockGetWallet.mockResolvedValueOnce({
        id: VALID_UUID,
        label: "research",
        balance_cents: 2500,
        spending_limit_cents: 5000,
        status: "active",
        created_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await request(app, "GET", `/api/agent-wallet/${VALID_UUID}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(VALID_UUID);
      expect(res.body.balanceCents).toBe(2500);
      expect(mockGetWallet).toHaveBeenCalledWith(VALID_UUID, "test-user-id");
    });

    it("should return 400 for invalid UUID", async () => {
      const app = createApp();
      const res = await request(app, "GET", "/api/agent-wallet/not-a-uuid");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid wallet ID format");
      expect(mockGetWallet).not.toHaveBeenCalled();
    });

    it("should return 404 when wallet not found", async () => {
      mockGetWallet.mockResolvedValueOnce(null);

      const app = createApp();
      const res = await request(app, "GET", `/api/agent-wallet/${VALID_UUID}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Agentic wallet not found");
    });
  });

  // ─── POST /api/agent-wallet/:id/fund ────────────────────────────────

  describe("POST /api/agent-wallet/:id/fund", () => {
    it("should fund an agentic wallet", async () => {
      mockFundWallet.mockResolvedValueOnce({
        id: "tx-1",
        wallet_id: VALID_UUID,
        type: "fund",
        amount_cents: 1000,
        description: "Funded from main wallet",
        created_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/agent-wallet/${VALID_UUID}/fund`, {
        amountCents: 1000,
      });

      expect(res.status).toBe(200);
      const tx = res.body.transaction as Record<string, unknown>;
      expect(tx.id).toBe("tx-1");
      expect(tx.amountCents).toBe(1000);
      expect(tx.type).toBe("fund");
      expect(mockFundWallet).toHaveBeenCalledWith("test-user-id", VALID_UUID, 1000);
    });

    it("should return 400 for invalid UUID", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/agent-wallet/bad/fund", {
        amountCents: 1000,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid wallet ID format");
    });

    it("should return 400 for amount below minimum (100 cents)", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/agent-wallet/${VALID_UUID}/fund`, {
        amountCents: 50,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Amount must be between");
    });

    it("should return 400 for amount above maximum (1M cents)", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/agent-wallet/${VALID_UUID}/fund`, {
        amountCents: 1_000_001,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Amount must be between");
    });

    it("should return 400 for insufficient main wallet balance", async () => {
      mockFundWallet.mockRejectedValueOnce(new Error("Insufficient balance in main wallet"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/agent-wallet/${VALID_UUID}/fund`, {
        amountCents: 1000,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Insufficient balance");
    });

    it("should return 404 for non-existent wallet", async () => {
      mockFundWallet.mockRejectedValueOnce(new Error("Agentic wallet not found or not active"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/agent-wallet/${VALID_UUID}/fund`, {
        amountCents: 1000,
      });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  // ─── GET /api/agent-wallet/:id/transactions ─────────────────────────

  describe("GET /api/agent-wallet/:id/transactions", () => {
    it("should return paginated transactions", async () => {
      mockGetTransactions.mockResolvedValueOnce([
        {
          id: "tx-1",
          wallet_id: VALID_UUID,
          type: "fund",
          amount_cents: 1000,
          description: "Funded from main wallet",
          session_id: null,
          created_at: "2026-02-18T00:00:00Z",
        },
      ]);

      const app = createApp();
      const res = await request(app, "GET", `/api/agent-wallet/${VALID_UUID}/transactions`);

      expect(res.status).toBe(200);
      const txns = res.body.transactions as Array<Record<string, unknown>>;
      expect(txns).toHaveLength(1);
      expect(txns[0].amountCents).toBe(1000);
      expect(txns[0].type).toBe("fund");
      expect(mockGetTransactions).toHaveBeenCalledWith(VALID_UUID, "test-user-id", 50, 0);
    });

    it("should respect limit and offset query params", async () => {
      mockGetTransactions.mockResolvedValueOnce([]);

      const app = createApp();
      const res = await request(app, "GET", `/api/agent-wallet/${VALID_UUID}/transactions?limit=10&offset=5`);

      expect(res.status).toBe(200);
      expect(mockGetTransactions).toHaveBeenCalledWith(VALID_UUID, "test-user-id", 10, 5);
    });

    it("should return 400 for invalid UUID", async () => {
      const app = createApp();
      const res = await request(app, "GET", "/api/agent-wallet/invalid/transactions");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid wallet ID format");
    });

    it("should return 404 when wallet not found", async () => {
      mockGetTransactions.mockRejectedValueOnce(new Error("Agentic wallet not found"));

      const app = createApp();
      const res = await request(app, "GET", `/api/agent-wallet/${VALID_UUID}/transactions`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Agentic wallet not found");
    });
  });

  // ─── POST /api/agent-wallet/:id/freeze ──────────────────────────────

  describe("POST /api/agent-wallet/:id/freeze", () => {
    it("should freeze a wallet", async () => {
      mockFreezeWallet.mockResolvedValueOnce({
        id: VALID_UUID,
        label: "bot-1",
        balance_cents: 500,
        spending_limit_cents: 10000,
        status: "frozen",
        created_at: "2026-02-18T00:00:00Z",
      });

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/agent-wallet/${VALID_UUID}/freeze`, {});

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("frozen");
      expect(res.body.id).toBe(VALID_UUID);
      expect(mockFreezeWallet).toHaveBeenCalledWith(VALID_UUID, "test-user-id");
    });

    it("should return 400 for invalid UUID", async () => {
      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/agent-wallet/xyz/freeze", {});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid wallet ID format");
    });

    it("should return 404 for non-active wallet", async () => {
      mockFreezeWallet.mockRejectedValueOnce(new Error("Agentic wallet not found or not active"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", `/api/agent-wallet/${VALID_UUID}/freeze`, {});

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  // ─── DELETE /api/agent-wallet/:id ───────────────────────────────────

  describe("DELETE /api/agent-wallet/:id", () => {
    it("should delete a wallet and refund balance", async () => {
      mockDeleteWallet.mockResolvedValueOnce({ refundedCents: 500 });

      const app = createApp();
      const res = await request(app, "DELETE", `/api/agent-wallet/${VALID_UUID}`);

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
      expect(res.body.refundedCents).toBe(500);
      expect(mockDeleteWallet).toHaveBeenCalledWith(VALID_UUID, "test-user-id");
    });

    it("should return 400 for invalid UUID", async () => {
      const app = createApp();
      const res = await request(app, "DELETE", "/api/agent-wallet/bad-id");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid wallet ID format");
    });

    it("should return 404 for non-existent wallet", async () => {
      mockDeleteWallet.mockRejectedValueOnce(new Error("Agentic wallet not found"));

      const app = createApp();
      const res = await request(app, "DELETE", `/api/agent-wallet/${VALID_UUID}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });

    it("should return 500 on unexpected error", async () => {
      mockDeleteWallet.mockRejectedValueOnce(new Error("DB error"));

      const app = createApp();
      const res = await request(app, "DELETE", `/api/agent-wallet/${VALID_UUID}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to delete agentic wallet");
    });
  });
});
