import { describe, it, expect, vi, beforeEach } from "vitest";
import * as crypto from "node:crypto";

// Mock @dominusnode/shared
const mockCreditWallet = vi.fn();
const mockCreateInvoice = vi.fn();
const mockFindInvoice = vi.fn();
const mockCompleteInvoice = vi.fn();
const mockMarkCreditFailed = vi.fn();

vi.mock("@dominusnode/shared", () => ({
  walletRepo: {
    creditWallet: (...args: unknown[]) => mockCreditWallet(...args),
  },
  invoiceRepo: {
    createInvoice: (...args: unknown[]) => mockCreateInvoice(...args),
    findInvoice: (...args: unknown[]) => mockFindInvoice(...args),
    completeInvoice: (...args: unknown[]) => mockCompleteInvoice(...args),
    markCreditFailed: (...args: unknown[]) => mockMarkCreditFailed(...args),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  SUPPORTED_CRYPTO: ["btc", "eth", "ltc", "xmr", "zec", "usdc"] as const,
}));

// Set env vars before import
process.env["NOWPAYMENTS_API_KEY"] = "test-np-api-key";
process.env["NOWPAYMENTS_IPN_SECRET"] = "test-ipn-secret";
process.env["NOWPAYMENTS_API_URL"] = "https://api.test.nowpayments.io/v1";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  createCryptoInvoice,
  handleIpnCallback,
  verifyIpnSignature,
} from "./nowpayments.js";

// Helper to compute expected HMAC for IPN signature
function computeHmac(body: Record<string, unknown>, secret: string): string {
  const sorted = Object.keys(body)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = body[key];
      return acc;
    }, {});
  return crypto.createHmac("sha512", secret).update(JSON.stringify(sorted)).digest("hex");
}

describe("nowpayments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── createCryptoInvoice ──────────────────────────────────────────

  describe("createCryptoInvoice", () => {
    it("should create an invoice via NOWPayments API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ id: "np-inv-123", invoice_url: "https://pay.nowpayments.io/test" })),
      });
      mockCreateInvoice.mockResolvedValueOnce({});

      const result = await createCryptoInvoice("user-1", 10.0, "btc");

      expect(result.invoiceId).toBe("np-inv-123");
      expect(result.invoiceUrl).toBe("https://pay.nowpayments.io/test");
      expect(result.payCurrency).toBe("btc");
      expect(result.priceAmount).toBe(10.0);
      expect(result.orderId).toMatch(/^topup_user-1_\d+$/);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.test.nowpayments.io/v1/invoice",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-api-key": "test-np-api-key",
          }),
        }),
      );

      expect(mockCreateInvoice).toHaveBeenCalledWith(
        "user-1",
        "nowpayments",
        "np-inv-123",
        1000, // 10.0 * 100
      );
    });

    it("should throw for unsupported currency", async () => {
      await expect(
        createCryptoInvoice("user-1", 10.0, "doge" as any),
      ).rejects.toThrow("Unsupported currency: doge");
    });

    it("should throw when API returns an error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad request"),
      });

      await expect(
        createCryptoInvoice("user-1", 10.0, "eth"),
      ).rejects.toThrow("NOWPayments createInvoice failed: 400");
    });
  });

  // ─── verifyIpnSignature ───────────────────────────────────────────

  describe("verifyIpnSignature", () => {
    it("should return true for valid signature", () => {
      const body = { payment_id: "123", payment_status: "finished", price_amount: 10 };
      const sig = computeHmac(body, "test-ipn-secret");

      expect(verifyIpnSignature(body, sig)).toBe(true);
    });

    it("should return false for invalid signature", () => {
      const body = { payment_id: "123" };
      expect(verifyIpnSignature(body, "invalidsig")).toBe(false);
    });

    it("should return false for tampered body", () => {
      const body = { payment_id: "123", price_amount: 10 };
      const sig = computeHmac(body, "test-ipn-secret");

      const tamperedBody = { payment_id: "123", price_amount: 999 };
      expect(verifyIpnSignature(tamperedBody, sig)).toBe(false);
    });

    it("should sort keys before comparing", () => {
      const body1 = { b: 2, a: 1 };
      const body2 = { a: 1, b: 2 };
      const sig = computeHmac(body1, "test-ipn-secret");

      // Both orderings should produce the same sig since keys are sorted
      expect(verifyIpnSignature(body2, sig)).toBe(true);
    });
  });

  // ─── handleIpnCallback ───────────────────────────────────────────

  describe("handleIpnCallback", () => {
    function makeValidBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        payment_id: "pay-123",
        invoice_id: "np-inv-123",
        payment_status: "finished",
        price_amount: 10,
        pay_currency: "btc",
        order_id: "topup_user-1_12345",
        ...overrides,
      };
    }

    function signBody(body: Record<string, unknown>): string {
      return computeHmac(body, "test-ipn-secret");
    }

    it("should credit wallet on valid finished payment", async () => {
      const body = makeValidBody();
      const sig = signBody(body);

      const mockInvoice = {
        id: "inv-1",
        user_id: "user-1",
        amount_cents: 1000, // $10.00
      };
      mockFindInvoice.mockResolvedValueOnce(mockInvoice);
      mockCompleteInvoice.mockResolvedValueOnce(true);
      mockCreditWallet.mockResolvedValueOnce({});

      const result = await handleIpnCallback(body, sig);

      expect(result).toEqual({ userId: "user-1", amountCents: 1000 });
      // completeInvoice is called FIRST as the atomic gate
      expect(mockCompleteInvoice).toHaveBeenCalledWith("inv-1");
      expect(mockCreditWallet).toHaveBeenCalledWith(
        "user-1",
        1000,
        "nowpayments",
        "pay-123",
        "Crypto top-up $10.00 (btc)",
      );
    });

    it("should return null for invalid signature", async () => {
      const body = makeValidBody();

      const result = await handleIpnCallback(body, "bad-sig");
      expect(result).toBeNull();
      expect(mockCreditWallet).not.toHaveBeenCalled();
    });

    it("should return null for non-final payment status", async () => {
      const body = makeValidBody({ payment_status: "waiting" });
      const sig = signBody(body);

      const result = await handleIpnCallback(body, sig);
      expect(result).toBeNull();
    });

    it("should accept confirmed status", async () => {
      const body = makeValidBody({ payment_status: "confirmed" });
      const sig = signBody(body);

      mockFindInvoice.mockResolvedValueOnce({
        id: "inv-2",
        user_id: "user-1",
        amount_cents: 1000,
      });
      mockCompleteInvoice.mockResolvedValueOnce(true);
      mockCreditWallet.mockResolvedValueOnce({});

      const result = await handleIpnCallback(body, sig);
      expect(result).not.toBeNull();
    });

    it("should return null when payment_id is missing", async () => {
      const body = makeValidBody({ payment_id: "" });
      const sig = signBody(body);

      const result = await handleIpnCallback(body, sig);
      expect(result).toBeNull();
    });

    it("should return null when price_amount is 0", async () => {
      const body = makeValidBody({ price_amount: 0 });
      const sig = signBody(body);

      const result = await handleIpnCallback(body, sig);
      expect(result).toBeNull();
    });

    it("should return null when no matching invoice found", async () => {
      const body = makeValidBody();
      const sig = signBody(body);

      mockFindInvoice.mockResolvedValueOnce(null);

      const result = await handleIpnCallback(body, sig);
      expect(result).toBeNull();
    });

    it("should return null on amount mismatch", async () => {
      const body = makeValidBody({ price_amount: 10 });
      const sig = signBody(body);

      mockFindInvoice.mockResolvedValueOnce({
        id: "inv-3",
        user_id: "user-1",
        amount_cents: 2000, // $20 != $10
      });

      const result = await handleIpnCallback(body, sig);
      expect(result).toBeNull();
    });

    it("should handle duplicate IPN gracefully via atomic completeInvoice", async () => {
      const body = makeValidBody();
      const sig = signBody(body);

      mockFindInvoice.mockResolvedValueOnce({
        id: "inv-4",
        user_id: "user-1",
        amount_cents: 1000,
      });
      // completeInvoice returns false = invoice already completed by another IPN
      mockCompleteInvoice.mockResolvedValueOnce(false);

      const result = await handleIpnCallback(body, sig);
      expect(result).toEqual({ userId: "user-1", amountCents: 1000 });
      // creditWallet should NOT be called for duplicate
      expect(mockCreditWallet).not.toHaveBeenCalled();
    });

    it("should look up invoice by invoice_id not payment_id", async () => {
      const body = makeValidBody({ payment_id: "pay-999", invoice_id: "np-inv-456" });
      const sig = signBody(body);

      mockFindInvoice.mockResolvedValueOnce({
        id: "inv-6",
        user_id: "user-1",
        amount_cents: 1000,
      });
      mockCompleteInvoice.mockResolvedValueOnce(true);
      mockCreditWallet.mockResolvedValueOnce({});

      await handleIpnCallback(body, sig);

      // Should look up by invoice_id (np-inv-456), NOT payment_id (pay-999)
      expect(mockFindInvoice).toHaveBeenCalledWith("nowpayments", "np-inv-456");
      // But creditWallet should use payment_id for dedup
      expect(mockCreditWallet).toHaveBeenCalledWith(
        "user-1", 1000, "nowpayments", "pay-999",
        expect.any(String),
      );
    });

    it("should return null when invoice_id is missing (no fallback to payment_id)", async () => {
      const body = makeValidBody({ invoice_id: undefined });
      // Remove invoice_id entirely
      delete body["invoice_id"];
      const sig = signBody(body);

      const result = await handleIpnCallback(body, sig);

      // Should reject IPN without invoice_id — no unsafe fallback to payment_id
      expect(result).toBeNull();
      expect(mockFindInvoice).not.toHaveBeenCalled();
    });

    it("should re-throw errors from creditWallet after successful claim", async () => {
      const body = makeValidBody();
      const sig = signBody(body);

      mockFindInvoice.mockResolvedValueOnce({
        id: "inv-5",
        user_id: "user-1",
        amount_cents: 1000,
      });
      mockCompleteInvoice.mockResolvedValueOnce(true);
      mockCreditWallet.mockRejectedValueOnce(new Error("connection reset"));

      await expect(handleIpnCallback(body, sig)).rejects.toThrow("connection reset");
    });
  });
});
