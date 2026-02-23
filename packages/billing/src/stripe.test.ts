import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Stripe
const mockSessionCreate = vi.fn();
const mockConstructEvent = vi.fn();

vi.mock("stripe", () => {
  return {
    default: class Stripe {
      checkout = {
        sessions: {
          create: mockSessionCreate,
        },
      };
      webhooks = {
        constructEvent: mockConstructEvent,
      };
    },
  };
});

// Mock @dominusnode/shared
const mockCreditWallet = vi.fn();
const mockCreateInvoice = vi.fn();
const mockFindInvoice = vi.fn();
const mockCompleteInvoice = vi.fn();
const mockMarkCreditFailed = vi.fn();
const mockFailInvoice = vi.fn();

vi.mock("@dominusnode/shared", () => ({
  walletRepo: {
    creditWallet: (...args: unknown[]) => mockCreditWallet(...args),
  },
  invoiceRepo: {
    createInvoice: (...args: unknown[]) => mockCreateInvoice(...args),
    findInvoice: (...args: unknown[]) => mockFindInvoice(...args),
    completeInvoice: (...args: unknown[]) => mockCompleteInvoice(...args),
    markCreditFailed: (...args: unknown[]) => mockMarkCreditFailed(...args),
    failInvoice: (...args: unknown[]) => mockFailInvoice(...args),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Set env vars before import
process.env["STRIPE_SECRET_KEY"] = "sk_test_123";
process.env["STRIPE_WEBHOOK_SECRET"] = "whsec_test_123";

import { createCheckoutSession, handleCheckoutWebhook } from "./stripe.js";

describe("stripe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── createCheckoutSession ─────────────────────────────────────────

  describe("createCheckoutSession", () => {
    it("should create a Stripe checkout session and save invoice", async () => {
      mockSessionCreate.mockResolvedValueOnce({
        id: "cs_test_123",
        url: "https://checkout.stripe.com/test",
      });
      mockCreateInvoice.mockResolvedValueOnce({});

      const result = await createCheckoutSession("user-1", 1000);

      expect(result.sessionId).toBe("cs_test_123");
      expect(result.url).toBe("https://checkout.stripe.com/test");
      expect(mockSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "payment",
          payment_method_types: ["card", "link"],
          metadata: {
            userId: "user-1",
            amountCents: "1000",
          },
        }),
      );
      expect(mockCreateInvoice).toHaveBeenCalledWith(
        "user-1",
        "stripe",
        "cs_test_123",
        1000,
      );
    });

    it("should return empty string for url when null", async () => {
      mockSessionCreate.mockResolvedValueOnce({
        id: "cs_test_456",
        url: null,
      });
      mockCreateInvoice.mockResolvedValueOnce({});

      const result = await createCheckoutSession("user-2", 500);
      expect(result.url).toBe("");
    });
  });

  // ─── handleCheckoutWebhook ─────────────────────────────────────────

  describe("handleCheckoutWebhook", () => {
    it("should credit wallet on successful checkout.session.completed", async () => {
      const mockSession = {
        id: "cs_test_789",
        amount_total: 2000,
        payment_status: "paid",
        metadata: { userId: "user-3" },
      };

      mockConstructEvent.mockReturnValueOnce({
        type: "checkout.session.completed",
        data: { object: mockSession },
      });

      const mockInvoice = {
        id: "inv-1",
        user_id: "user-3",
        amount_cents: 2000,
      };
      mockFindInvoice.mockResolvedValueOnce(mockInvoice);
      mockCompleteInvoice.mockResolvedValueOnce(true);
      mockCreditWallet.mockResolvedValueOnce({});

      const result = await handleCheckoutWebhook(
        Buffer.from("raw-body"),
        "test-signature",
      );

      expect(result).toEqual({ userId: "user-3", amountCents: 2000 });
      // completeInvoice is called FIRST as the atomic gate
      expect(mockCompleteInvoice).toHaveBeenCalledWith("inv-1");
      expect(mockCreditWallet).toHaveBeenCalledWith(
        "user-3",
        2000,
        "stripe",
        "cs_test_789",
        "Stripe top-up $20.00",
      );
    });

    it("should return null when signature verification fails", async () => {
      mockConstructEvent.mockImplementationOnce(() => {
        throw new Error("Invalid signature");
      });

      const result = await handleCheckoutWebhook(
        Buffer.from("bad-body"),
        "bad-sig",
      );
      expect(result).toBeNull();
    });

    it("should return null for non-checkout.session.completed events", async () => {
      mockConstructEvent.mockReturnValueOnce({
        type: "payment_intent.created",
        data: { object: {} },
      });

      const result = await handleCheckoutWebhook(
        Buffer.from("body"),
        "sig",
      );
      expect(result).toBeNull();
    });

    it("should return null when payment_status is not paid (PayPal pending)", async () => {
      mockConstructEvent.mockReturnValueOnce({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_unpaid",
            amount_total: 2000,
            payment_status: "unpaid",
            metadata: { userId: "user-4a" },
          },
        },
      });

      const result = await handleCheckoutWebhook(
        Buffer.from("body"),
        "sig",
      );
      expect(result).toBeNull();
    });

    it("should credit wallet on async_payment_succeeded (PayPal settlement)", async () => {
      mockConstructEvent.mockReturnValueOnce({
        type: "checkout.session.async_payment_succeeded",
        data: {
          object: {
            id: "cs_paypal_settled",
            amount_total: 3000,
            payment_status: "paid",
            metadata: { userId: "user-paypal" },
          },
        },
      });
      mockFindInvoice.mockResolvedValueOnce({
        id: "inv-paypal",
        user_id: "user-paypal",
        amount_cents: 3000,
      });
      mockCompleteInvoice.mockResolvedValueOnce(true);
      mockCreditWallet.mockResolvedValueOnce({});

      const result = await handleCheckoutWebhook(
        Buffer.from("body"),
        "sig",
      );
      expect(result).toEqual({ userId: "user-paypal", amountCents: 3000 });
      expect(mockCreditWallet).toHaveBeenCalledWith(
        "user-paypal",
        3000,
        "stripe",
        "cs_paypal_settled",
        "Stripe top-up $30.00",
      );
    });

    it("should mark invoice as failed on async_payment_failed (PayPal failure)", async () => {
      mockConstructEvent.mockReturnValueOnce({
        type: "checkout.session.async_payment_failed",
        data: {
          object: {
            id: "cs_paypal_failed",
            amount_total: 2000,
            payment_status: "unpaid",
          },
        },
      });
      mockFindInvoice.mockResolvedValueOnce({
        id: "inv-paypal-fail",
        user_id: "user-paypal-fail",
        amount_cents: 2000,
        status: "pending",
      });
      mockFailInvoice.mockResolvedValueOnce(true);

      const result = await handleCheckoutWebhook(
        Buffer.from("body"),
        "sig",
      );
      expect(result).toBeNull();
      expect(mockFailInvoice).toHaveBeenCalledWith("inv-paypal-fail");
      expect(mockMarkCreditFailed).not.toHaveBeenCalled();
    });

    it("should return null when amount_total is 0", async () => {
      mockConstructEvent.mockReturnValueOnce({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_empty",
            amount_total: 0,
            payment_status: "paid",
            metadata: { userId: "user-4" },
          },
        },
      });

      const result = await handleCheckoutWebhook(
        Buffer.from("body"),
        "sig",
      );
      expect(result).toBeNull();
    });

    it("should return null when no matching invoice found", async () => {
      mockConstructEvent.mockReturnValueOnce({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_no_inv",
            amount_total: 1000,
            payment_status: "paid",
            metadata: { userId: "user-5" },
          },
        },
      });
      mockFindInvoice.mockResolvedValueOnce(null);

      const result = await handleCheckoutWebhook(
        Buffer.from("body"),
        "sig",
      );
      expect(result).toBeNull();
    });

    it("should return null when amount mismatch between invoice and Stripe", async () => {
      mockConstructEvent.mockReturnValueOnce({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_mismatch",
            amount_total: 2000,
            payment_status: "paid",
            metadata: { userId: "user-6" },
          },
        },
      });
      mockFindInvoice.mockResolvedValueOnce({
        id: "inv-2",
        user_id: "user-6",
        amount_cents: 1000, // mismatch
      });

      const result = await handleCheckoutWebhook(
        Buffer.from("body"),
        "sig",
      );
      expect(result).toBeNull();
    });

    it("should handle duplicate webhook gracefully via atomic completeInvoice", async () => {
      mockConstructEvent.mockReturnValueOnce({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_dup",
            amount_total: 1000,
            payment_status: "paid",
          },
        },
      });
      mockFindInvoice.mockResolvedValueOnce({
        id: "inv-3",
        user_id: "user-7",
        amount_cents: 1000,
      });
      // completeInvoice returns false = invoice already completed by another webhook
      mockCompleteInvoice.mockResolvedValueOnce(false);

      const result = await handleCheckoutWebhook(
        Buffer.from("body"),
        "sig",
      );
      expect(result).toBeNull();
      // creditWallet should NOT be called for duplicate
      expect(mockCreditWallet).not.toHaveBeenCalled();
    });
  });
});
