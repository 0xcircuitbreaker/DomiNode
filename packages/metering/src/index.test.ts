import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @dominode/shared before import
const mockCreateUsageRecord = vi.fn();
const mockDebitWallet = vi.fn();

vi.mock("@dominode/shared", () => ({
  PRICE_PER_GB_CENTS: 500,
  BYTES_PER_GB: 1_073_741_824,
  usageRepo: {
    createUsageRecord: (...args: unknown[]) => mockCreateUsageRecord(...args),
  },
  walletRepo: {
    debitWallet: (...args: unknown[]) => mockDebitWallet(...args),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { computeCostCents, recordUsage, debitForUsage } from "./index.js";

describe("metering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("computeCostCents", () => {
    it("should return 0 for 0 bytes", () => {
      expect(computeCostCents(0)).toBe(0);
    });

    it("should return 0 for negative bytes", () => {
      expect(computeCostCents(-100)).toBe(0);
    });

    it("should return minimum 1 cent for any positive bytes", () => {
      expect(computeCostCents(1)).toBe(1);
    });

    it("should return minimum 1 cent for small byte values", () => {
      expect(computeCostCents(100)).toBe(1);
      expect(computeCostCents(1000)).toBe(1);
    });

    it("should return 500 cents for exactly 1 GB", () => {
      expect(computeCostCents(1_073_741_824)).toBe(500);
    });

    it("should return 1000 cents for 2 GB", () => {
      expect(computeCostCents(2 * 1_073_741_824)).toBe(1000);
    });

    it("should round up cost (ceil)", () => {
      expect(computeCostCents(536_870_912)).toBe(250);
    });

    it("should round up fractional cents", () => {
      expect(computeCostCents(1_048_576)).toBe(1);
    });

    it("should handle 10 MB correctly", () => {
      expect(computeCostCents(10_485_760)).toBe(5);
    });

    it("should handle 100 MB correctly", () => {
      expect(computeCostCents(104_857_600)).toBe(49);
    });

    it("should handle 10 GB", () => {
      expect(computeCostCents(10 * 1_073_741_824)).toBe(5000);
    });

    // Tests for the new pricePerGbCents parameter
    it("should use custom pricePerGbCents when provided", () => {
      // 1 GB at $3/GB = 300 cents
      expect(computeCostCents(1_073_741_824, 300)).toBe(300);
    });

    it("should compute cost at lower price per GB", () => {
      // 1 GB at $1/GB = 100 cents
      expect(computeCostCents(1_073_741_824, 100)).toBe(100);
    });

    it("should still enforce minimum 1 cent with custom pricing", () => {
      expect(computeCostCents(1, 100)).toBe(1);
    });

    it("should compute half GB at custom price", () => {
      // 500 MB = 536_870_912 bytes at $3/GB
      // ceil((536_870_912 / 1_073_741_824) * 300) = ceil(150) = 150
      expect(computeCostCents(536_870_912, 300)).toBe(150);
    });

    it("should default to PRICE_PER_GB_CENTS when pricePerGbCents not provided", () => {
      // Default should be 500 (from PRICE_PER_GB_CENTS)
      expect(computeCostCents(1_073_741_824)).toBe(500);
    });

    it("should return 0 for any bytes when pricePerGbCents is 0 (free plan)", () => {
      expect(computeCostCents(1_073_741_824, 0)).toBe(0);
      expect(computeCostCents(1, 0)).toBe(0);
      expect(computeCostCents(10_000_000, 0)).toBe(0);
    });

    it("should return 0 for negative pricePerGbCents", () => {
      expect(computeCostCents(1_073_741_824, -100)).toBe(0);
    });
  });

  describe("recordUsage", () => {
    it("should create a usage record and return it", async () => {
      const record = {
        id: "ur1",
        user_id: "u1",
        session_id: "s1",
        bytes_in: 1000,
        bytes_out: 2000,
        cost_cents: 1,
        proxy_type: "residential",
        target_host: "example.com",
      };
      mockCreateUsageRecord.mockResolvedValueOnce(record);

      const result = await recordUsage("u1", "s1", 1000, 2000, "example.com");
      expect(result).toEqual(record);
    });

    it("should compute cost from bytesIn + bytesOut", async () => {
      mockCreateUsageRecord.mockResolvedValueOnce({ id: "ur2" });

      await recordUsage("u1", "s1", 500_000_000, 500_000_000, "target.com");

      expect(mockCreateUsageRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          bytes_in: 500_000_000,
          bytes_out: 500_000_000,
          cost_cents: expect.any(Number),
        }),
      );
    });

    it("should pass proxy_type as residential", async () => {
      mockCreateUsageRecord.mockResolvedValueOnce({ id: "ur3" });

      await recordUsage("u1", "s1", 100, 200, "api.com");

      expect(mockCreateUsageRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          proxy_type: "residential",
        }),
      );
    });

    it("should pass target_host from parameter", async () => {
      mockCreateUsageRecord.mockResolvedValueOnce({ id: "ur4" });

      await recordUsage("u1", "s1", 100, 200, "special-host.io");

      expect(mockCreateUsageRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          target_host: "special-host.io",
        }),
      );
    });

    it("should pass correct user_id and session_id", async () => {
      mockCreateUsageRecord.mockResolvedValueOnce({ id: "ur5" });

      await recordUsage("user-abc", "sess-xyz", 0, 0, "host.com");

      expect(mockCreateUsageRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: "user-abc",
          session_id: "sess-xyz",
        }),
      );
    });

    it("should use custom pricePerGbCents when provided", async () => {
      mockCreateUsageRecord.mockResolvedValueOnce({ id: "ur6" });

      // 1GB at $3/GB = 300 cents
      await recordUsage("u1", "s1", 1_073_741_824, 0, "host.com", 300);

      expect(mockCreateUsageRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          cost_cents: 300,
        }),
      );
    });

    it("should handle zero bytes", async () => {
      mockCreateUsageRecord.mockResolvedValueOnce({ id: "ur7" });

      await recordUsage("u1", "s1", 0, 0, "host.com");

      expect(mockCreateUsageRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          cost_cents: 0,
        }),
      );
    });
  });

  describe("debitForUsage", () => {
    it("should return true when cost is zero", async () => {
      const result = await debitForUsage("u1", 0, "sess-123");
      expect(result).toBe(true);
      expect(mockDebitWallet).not.toHaveBeenCalled();
    });

    it("should return true when cost is negative", async () => {
      const result = await debitForUsage("u1", -5, "sess-123");
      expect(result).toBe(true);
      expect(mockDebitWallet).not.toHaveBeenCalled();
    });

    it("should return true when debit succeeds", async () => {
      mockDebitWallet.mockResolvedValueOnce({ id: "tx1" }); // non-null = success

      const result = await debitForUsage("u1", 50, "sess-12345678");
      expect(result).toBe(true);
      expect(mockDebitWallet).toHaveBeenCalledWith(
        "u1",
        50,
        "Proxy usage (session sess-123)",
      );
    });

    it("should return false when insufficient balance", async () => {
      mockDebitWallet.mockResolvedValueOnce(null); // null = insufficient

      const result = await debitForUsage("u1", 50, "sess-12345678");
      expect(result).toBe(false);
    });

    it("should use first 8 chars of sessionId in description", async () => {
      mockDebitWallet.mockResolvedValueOnce({ id: "tx2" });

      await debitForUsage("u1", 100, "abcdefghijklmnop");
      expect(mockDebitWallet).toHaveBeenCalledWith(
        "u1",
        100,
        "Proxy usage (session abcdefgh)",
      );
    });
  });
});
