import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import {
  createInvoice,
  findInvoice,
  completeInvoice,
} from "./invoice-repo.js";

describe("invoice-repo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── createInvoice ─────────────────────────────────────────────────

  describe("createInvoice", () => {
    it("should create an invoice and return it", async () => {
      const invoice = {
        id: "inv-1",
        user_id: "u1",
        provider: "stripe",
        external_id: "cs_test_123",
        amount_cents: 1000,
        status: "pending",
      };
      mockQuery.mockResolvedValueOnce({ rows: [invoice] });

      const result = await createInvoice("u1", "stripe", "cs_test_123", 1000);
      expect(result).toEqual(invoice);
    });

    it("should pass correct parameters", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "inv-2" }] });

      await createInvoice("u2", "nowpayments", "np-inv-456", 2000);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO payment_invoices"),
        ["u2", "nowpayments", "np-inv-456", 2000],
      );
    });

    it("should include RETURNING * clause", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "inv-3" }] });

      await createInvoice("u3", "stripe", "cs_789", 500);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("RETURNING *"),
        expect.any(Array),
      );
    });

    it("should handle stripe provider", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "inv-4", provider: "stripe" }] });

      const result = await createInvoice("u4", "stripe", "cs_abc", 1500);
      expect(result.provider).toBe("stripe");
    });

    it("should handle nowpayments provider", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "inv-5", provider: "nowpayments" }] });

      const result = await createInvoice("u5", "nowpayments", "np-def", 3000);
      expect(result.provider).toBe("nowpayments");
    });

    it("should handle various amount values", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "inv-6" }] });

      await createInvoice("u6", "stripe", "cs_amt", 100_000);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ["u6", "stripe", "cs_amt", 100_000],
      );
    });
  });

  // ─── findInvoice ───────────────────────────────────────────────────

  describe("findInvoice", () => {
    it("should return invoice when found", async () => {
      const invoice = {
        id: "inv-1",
        user_id: "u1",
        provider: "stripe",
        external_id: "cs_123",
        amount_cents: 1000,
        status: "pending",
      };
      mockQuery.mockResolvedValueOnce({ rows: [invoice] });

      const result = await findInvoice("stripe", "cs_123");
      expect(result).toEqual(invoice);
    });

    it("should return null when no invoice found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await findInvoice("stripe", "cs_missing");
      expect(result).toBeNull();
    });

    it("should query by provider and external_id", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await findInvoice("nowpayments", "np-789");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("WHERE provider = $1 AND external_id = $2"),
        ["nowpayments", "np-789"],
      );
    });

    it("should return the first matching row", async () => {
      const invoice = { id: "inv-first", provider: "stripe" };
      mockQuery.mockResolvedValueOnce({ rows: [invoice] });

      const result = await findInvoice("stripe", "cs_first");
      expect(result).toEqual(invoice);
    });

    it("should handle stripe provider lookups", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "inv-s" }] });

      const result = await findInvoice("stripe", "cs_abc");
      expect(result).not.toBeNull();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ["stripe", "cs_abc"],
      );
    });

    it("should handle nowpayments provider lookups", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "inv-np" }] });

      const result = await findInvoice("nowpayments", "pay-123");
      expect(result).not.toBeNull();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ["nowpayments", "pay-123"],
      );
    });
  });

  // ─── completeInvoice ───────────────────────────────────────────────

  describe("completeInvoice", () => {
    it("should update invoice status to completed", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await completeInvoice("inv-1");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'completed'"),
        ["inv-1"],
      );
    });

    it("should filter by invoice id", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await completeInvoice("inv-abc-123");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("WHERE id = $1"),
        ["inv-abc-123"],
      );
    });

    it("should update payment_invoices table", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await completeInvoice("inv-2");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE payment_invoices"),
        expect.any(Array),
      );
    });

    it("should return true when a pending invoice was updated", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await completeInvoice("inv-claimed");
      expect(result).toBe(true);
    });

    it("should return false when no pending invoice was found", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const result = await completeInvoice("inv-missing");
      expect(result).toBe(false);
    });

    it("should return false when rowCount is null", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: null });

      const result = await completeInvoice("inv-null");
      expect(result).toBe(false);
    });

    it("should call query exactly once", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await completeInvoice("inv-3");
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });
});
