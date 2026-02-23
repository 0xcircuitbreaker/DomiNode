import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";

// ─── Mocks ─────────────────────────────────────────────────────────────

const mockGetWallet = vi.fn();
const mockGetTransactions = vi.fn();
const mockGetUsageByDay = vi.fn();
const mockValidateTopupAmount = vi.fn();
const mockIsValidCryptoCurrency = vi.fn();
const mockCreateCheckoutSession = vi.fn();
const mockCreateCryptoInvoice = vi.fn();
const mockFindUserById = vi.fn();

vi.mock("@dominusnode/shared", () => ({
  walletRepo: {
    getWallet: (...args: unknown[]) => mockGetWallet(...args),
    getTransactions: (...args: unknown[]) => mockGetTransactions(...args),
  },
  userRepo: {
    findUserById: (...args: unknown[]) => mockFindUserById(...args),
  },
  usageRepo: {
    getUsageByDay: (...args: unknown[]) => mockGetUsageByDay(...args),
  },
  validateTopupAmount: (...args: unknown[]) => mockValidateTopupAmount(...args),
  isValidCryptoCurrency: (...args: unknown[]) => mockIsValidCryptoCurrency(...args),
  SUPPORTED_CRYPTO: ["btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb"],
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@dominusnode/billing", () => ({
  createCheckoutSession: (...args: unknown[]) => mockCreateCheckoutSession(...args),
  createCryptoInvoice: (...args: unknown[]) => mockCreateCryptoInvoice(...args),
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

import walletRouter from "./wallet.js";

// ─── Helpers ──────────────────────────────────────────────────────────

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/wallet", walletRouter);
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

describe("wallet routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET /api/wallet ───────────────────────────────────────────────

  describe("GET /api/wallet", () => {
    it("should return wallet balance", async () => {
      mockGetWallet.mockResolvedValueOnce({
        balance_cents: 5000,
        currency: "USD",
        last_topped_up: "2025-01-01T00:00:00Z",
      });

      const app = createApp();
      const res = await request(app, "GET", "/api/wallet");

      expect(res.status).toBe(200);
      expect(res.body.balanceCents).toBe(5000);
      expect(res.body.balanceUsd).toBe(50);
      expect(res.body.currency).toBe("USD");
      expect(res.body.lastToppedUp).toBe("2025-01-01T00:00:00Z");
    });

    it("should return 404 when wallet not found", async () => {
      mockGetWallet.mockResolvedValueOnce(null);

      const app = createApp();
      const res = await request(app, "GET", "/api/wallet");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Wallet not found");
    });

    it("should return 500 on DB error", async () => {
      mockGetWallet.mockRejectedValueOnce(new Error("DB error"));

      const app = createApp();
      const res = await request(app, "GET", "/api/wallet");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to fetch wallet");
    });
  });

  // ─── GET /api/wallet/transactions ──────────────────────────────────

  describe("GET /api/wallet/transactions", () => {
    it("should return transaction history", async () => {
      const transactions = [
        {
          id: "tx-1",
          type: "topup",
          amount_cents: 2000,
          description: "Stripe top-up",
          payment_provider: "stripe",
          created_at: "2025-01-01T00:00:00Z",
        },
        {
          id: "tx-2",
          type: "debit",
          amount_cents: -100,
          description: "Bandwidth usage",
          payment_provider: null,
          created_at: "2025-01-02T00:00:00Z",
        },
      ];
      mockGetTransactions.mockResolvedValueOnce(transactions);

      const app = createApp();
      const res = await request(app, "GET", "/api/wallet/transactions");

      expect(res.status).toBe(200);
      const txns = res.body.transactions as Array<Record<string, unknown>>;
      expect(txns).toHaveLength(2);
      expect(txns[0].id).toBe("tx-1");
      expect(txns[0].amountCents).toBe(2000);
      expect(txns[0].amountUsd).toBe(20);
      expect(txns[1].amountCents).toBe(-100);
      expect(mockGetTransactions).toHaveBeenCalledWith("test-user-id", 50, 0);
    });

    it("should respect limit and offset query params", async () => {
      mockGetTransactions.mockResolvedValueOnce([]);

      const app = createApp();
      const res = await request(app, "GET", "/api/wallet/transactions?limit=10&offset=5");

      expect(res.status).toBe(200);
      expect(mockGetTransactions).toHaveBeenCalledWith("test-user-id", 10, 5);
    });
  });

  // ─── POST /api/wallet/topup/stripe ─────────────────────────────────

  describe("POST /api/wallet/topup/stripe", () => {
    it("should create a Stripe checkout session", async () => {
      mockFindUserById.mockResolvedValueOnce({ id: "test-user-id", status: "active", email_verified: true });
      mockValidateTopupAmount.mockReturnValueOnce(null);
      mockGetWallet.mockResolvedValueOnce({ balance_cents: 0, currency: "USD" });
      mockCreateCheckoutSession.mockResolvedValueOnce({
        sessionId: "cs_test_123",
        url: "https://checkout.stripe.com/test",
      });

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/wallet/topup/stripe", {
        amountCents: 2000,
      });

      expect(res.status).toBe(200);
      expect(res.body.sessionId).toBe("cs_test_123");
      expect(res.body.url).toBe("https://checkout.stripe.com/test");
      expect(mockCreateCheckoutSession).toHaveBeenCalledWith("test-user-id", 2000);
    });

    it("should return 400 for invalid amount", async () => {
      mockFindUserById.mockResolvedValueOnce({ id: "test-user-id", status: "active", email_verified: true });
      mockValidateTopupAmount.mockReturnValueOnce("Amount must be at least $5.00");

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/wallet/topup/stripe", {
        amountCents: 100,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Amount must be at least $5.00");
      expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    });

    it("should return 500 when Stripe fails", async () => {
      mockFindUserById.mockResolvedValueOnce({ id: "test-user-id", status: "active", email_verified: true });
      mockValidateTopupAmount.mockReturnValueOnce(null);
      mockGetWallet.mockResolvedValueOnce({ balance_cents: 0, currency: "USD" });
      mockCreateCheckoutSession.mockRejectedValueOnce(new Error("Stripe API error"));

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/wallet/topup/stripe", {
        amountCents: 2000,
      });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to create checkout session");
    });
  });

  // ─── POST /api/wallet/topup/crypto ─────────────────────────────────

  describe("POST /api/wallet/topup/crypto", () => {
    it("should create a crypto invoice", async () => {
      mockFindUserById.mockResolvedValueOnce({ id: "test-user-id", status: "active", email_verified: true });
      mockIsValidCryptoCurrency.mockReturnValueOnce(true);
      mockCreateCryptoInvoice.mockResolvedValueOnce({
        invoiceId: "inv_123",
        invoiceUrl: "https://nowpayments.io/inv/123",
        payCurrency: "btc",
        priceAmount: 50,
      });

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/wallet/topup/crypto", {
        amountUsd: 50,
        currency: "BTC",
      });

      expect(res.status).toBe(200);
      expect(res.body.invoiceId).toBe("inv_123");
      expect(res.body.invoiceUrl).toBe("https://nowpayments.io/inv/123");
      expect(res.body.payCurrency).toBe("btc");
      expect(res.body.priceAmount).toBe(50);
    });

    it("should return 400 for amount below $10", async () => {
      mockFindUserById.mockResolvedValueOnce({ id: "test-user-id", status: "active", email_verified: true });
      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/wallet/topup/crypto", {
        amountUsd: 5,
        currency: "btc",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Amount must be between $10 and $1,000");
      expect(mockCreateCryptoInvoice).not.toHaveBeenCalled();
    });

    it("should return 400 for amount above $1000", async () => {
      mockFindUserById.mockResolvedValueOnce({ id: "test-user-id", status: "active", email_verified: true });
      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/wallet/topup/crypto", {
        amountUsd: 1500,
        currency: "btc",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Amount must be between $10 and $1,000");
    });

    it("should return 400 for unsupported currency", async () => {
      mockFindUserById.mockResolvedValueOnce({ id: "test-user-id", status: "active", email_verified: true });
      mockIsValidCryptoCurrency.mockReturnValueOnce(false);

      const app = createApp();
      const res = await requestWithBody(app, "POST", "/api/wallet/topup/crypto", {
        amountUsd: 50,
        currency: "doge",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Unsupported currency. Supported: btc, eth, ltc, xmr, zec, usdc, sol, usdt, dai, bnb");
    });
  });

  // ─── GET /api/wallet/forecast ──────────────────────────────────────

  describe("GET /api/wallet/forecast", () => {
    it("should return forecast with active spending", async () => {
      mockGetWallet.mockResolvedValueOnce({
        balance_cents: 10000,
        currency: "USD",
        last_topped_up: null,
      });

      // Current period: last 7 days — 3 days with spending
      mockGetUsageByDay.mockResolvedValueOnce([
        { date: "2025-01-05", total_bytes: 1000000, total_cost_cents: 200, request_count: 10 },
        { date: "2025-01-06", total_bytes: 2000000, total_cost_cents: 300, request_count: 15 },
        { date: "2025-01-07", total_bytes: 1500000, total_cost_cents: 100, request_count: 5 },
      ]);
      // Previous period: 7-14 days ago — lower spending
      mockGetUsageByDay.mockResolvedValueOnce([
        { date: "2025-01-01", total_bytes: 500000, total_cost_cents: 100, request_count: 5 },
        { date: "2025-01-02", total_bytes: 500000, total_cost_cents: 100, request_count: 5 },
      ]);

      const app = createApp();
      const res = await request(app, "GET", "/api/wallet/forecast");

      expect(res.status).toBe(200);
      // Daily avg = (200+300+100) / 3 = 200 cents/day
      expect(res.body.dailyAvgCents).toBe(200);
      // daysRemaining = 10000 / 200 = 50
      expect(res.body.daysRemaining).toBe(50);
      // Trend: current (600) vs prev (200), change = 200% > 5 => "up"
      expect(res.body.trend).toBe("up");
    });

    it("should return null daysRemaining with no spending", async () => {
      mockGetWallet.mockResolvedValueOnce({
        balance_cents: 5000,
        currency: "USD",
        last_topped_up: null,
      });
      mockGetUsageByDay.mockResolvedValueOnce([]); // current period: no spending
      mockGetUsageByDay.mockResolvedValueOnce([]); // prev period: no spending

      const app = createApp();
      const res = await request(app, "GET", "/api/wallet/forecast");

      expect(res.status).toBe(200);
      expect(res.body.dailyAvgCents).toBe(0);
      expect(res.body.daysRemaining).toBeNull();
      expect(res.body.trend).toBe("stable");
      expect(res.body.trendPct).toBe(0);
    });

    it("should return 404 when wallet not found", async () => {
      mockGetWallet.mockResolvedValueOnce(null);

      const app = createApp();
      const res = await request(app, "GET", "/api/wallet/forecast");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Wallet not found");
    });

    it("should show 'up' trend when current has spending but prev has none", async () => {
      mockGetWallet.mockResolvedValueOnce({
        balance_cents: 5000,
        currency: "USD",
        last_topped_up: null,
      });
      mockGetUsageByDay.mockResolvedValueOnce([
        { date: "2025-01-07", total_bytes: 1000000, total_cost_cents: 500, request_count: 10 },
      ]);
      mockGetUsageByDay.mockResolvedValueOnce([]); // prev period: nothing

      const app = createApp();
      const res = await request(app, "GET", "/api/wallet/forecast");

      expect(res.status).toBe(200);
      expect(res.body.trend).toBe("up");
      expect(res.body.trendPct).toBe(100);
    });
  });
});
