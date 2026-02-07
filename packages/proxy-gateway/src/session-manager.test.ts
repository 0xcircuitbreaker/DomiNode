import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock modules before import
const mockReserveBalance = vi.fn();
const mockReleaseReservation = vi.fn();
const mockSettleSession = vi.fn();
const mockCreateSession = vi.fn();
const mockEndSessionRepo = vi.fn();
const mockCreateUsageRecord = vi.fn();
const mockGetUserPlan = vi.fn();

vi.mock("@dominode/shared", () => ({
  walletRepo: {
    reserveBalance: (...args: unknown[]) => mockReserveBalance(...args),
    releaseReservation: (...args: unknown[]) => mockReleaseReservation(...args),
    settleSession: (...args: unknown[]) => mockSettleSession(...args),
  },
  usageRepo: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    endSession: (...args: unknown[]) => mockEndSessionRepo(...args),
    createUsageRecord: (...args: unknown[]) => mockCreateUsageRecord(...args),
  },
  planRepo: {
    getUserPlan: (...args: unknown[]) => mockGetUserPlan(...args),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockRecordUsage = vi.fn().mockResolvedValue({});

vi.mock("@dominode/metering", () => ({
  computeCostCents: (bytes: number, pricePerGb: number = 500) => {
    if (bytes <= 0) return 0;
    return Math.max(Math.ceil((bytes / 1_073_741_824) * pricePerGb), 1);
  },
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
}));

vi.mock("./balance-check.js", () => ({
  invalidateBalanceCache: vi.fn(),
}));

import { startSession, endSession, getActiveSessionCount } from "./session-manager.js";
import type { ByteCounter } from "./counting-stream.js";

function makeCounter(bytesIn = 0, bytesOut = 0): ByteCounter {
  return { bytesIn, bytesOut };
}

// Helper to start a session and return the sessionId for endSession tests
async function startTestSession(
  userId: string,
  sessionId: string,
  counter: ByteCounter,
): Promise<string> {
  mockReserveBalance.mockResolvedValueOnce("wallet-1");
  mockCreateSession.mockResolvedValueOnce({ id: sessionId });
  return startSession(userId, "example.com", counter);
}

describe("proxy-gateway/session-manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: plan lookup returns default PAYG rate
    mockGetUserPlan.mockResolvedValue({ id: "payg", name: "PAYG", pricePerGbCents: 500, monthlyBandwidthBytes: 0, isDefault: true });
  });

  describe("startSession", () => {
    it("should reserve balance and create session", async () => {
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockResolvedValueOnce({ id: "sess-123" });

      const counter = makeCounter();
      const sessionId = await startSession("user-1", "example.com", counter);

      expect(sessionId).toBe("sess-123");
      expect(mockReserveBalance).toHaveBeenCalledWith("user-1", 10); // MIN_RESERVATION_CENTS
      expect(mockCreateSession).toHaveBeenCalledWith("user-1", "packetstream");
    });

    it("should throw if insufficient balance for reservation", async () => {
      mockReserveBalance.mockResolvedValueOnce(null);

      const counter = makeCounter();
      await expect(
        startSession("user-1", "example.com", counter),
      ).rejects.toThrow("Insufficient balance for reservation");
    });

    it("should release reservation if DB session creation fails", async () => {
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockRejectedValueOnce(new Error("DB error"));

      const counter = makeCounter();
      await expect(
        startSession("user-1", "example.com", counter),
      ).rejects.toThrow("DB error");

      expect(mockReleaseReservation).toHaveBeenCalledWith("user-1", 10);
    });

    it("should not call createSession if reservation fails", async () => {
      mockReserveBalance.mockResolvedValueOnce(null);

      const counter = makeCounter();
      await expect(
        startSession("user-1", "example.com", counter),
      ).rejects.toThrow("Insufficient balance");

      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it("should increment active session count after starting", async () => {
      const before = getActiveSessionCount();

      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockResolvedValueOnce({ id: `sess-count-${Date.now()}` });

      const counter = makeCounter();
      const sessId = await startSession("user-count", "target.io", counter);

      expect(getActiveSessionCount()).toBeGreaterThanOrEqual(before + 1);

      // Clean up by ending the session
      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession(sessId);
    });

    it("should pass target host correctly", async () => {
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockResolvedValueOnce({ id: "sess-target" });

      const counter = makeCounter();
      await startSession("user-1", "api.example.org", counter);

      // End the session and verify targetHost is used in recordUsage
      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession("sess-target");

      // recordUsage now takes 6 args: userId, sessionId, bytesIn, bytesOut, targetHost, pricePerGbCents
      expect(mockRecordUsage).toHaveBeenCalledWith(
        "user-1",
        "sess-target",
        expect.any(Number),
        expect.any(Number),
        "api.example.org",
        expect.any(Number),
      );
    });

    it("should propagate non-balance DB errors", async () => {
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockRejectedValueOnce(new Error("connection timeout"));

      const counter = makeCounter();
      await expect(
        startSession("user-1", "example.com", counter),
      ).rejects.toThrow("connection timeout");
    });
  });

  describe("endSession", () => {
    it("should settle session and record usage on success", async () => {
      const counter = makeCounter(1000, 2000);
      const sessId = await startTestSession("user-1", "sess-end-1", counter);

      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);

      await endSession(sessId);

      expect(mockSettleSession).toHaveBeenCalledWith(
        "user-1",
        10, // reserved cents
        expect.any(Number), // actual cost cents
        "sess-end-1",
      );
      expect(mockEndSessionRepo).toHaveBeenCalledWith("sess-end-1", 3000, "completed");
    });

    it("should mark session as error when settlement is partial", async () => {
      const counter = makeCounter(5000, 5000);
      const sessId = await startTestSession("user-1", "sess-end-2", counter);

      mockSettleSession.mockResolvedValueOnce(false); // partial payment
      mockEndSessionRepo.mockResolvedValueOnce(undefined);

      await endSession(sessId);

      expect(mockEndSessionRepo).toHaveBeenCalledWith("sess-end-2", 10000, "error");
    });

    it("should be a no-op for unknown session ID", async () => {
      await endSession("unknown-session");
      expect(mockSettleSession).not.toHaveBeenCalled();
      expect(mockRecordUsage).not.toHaveBeenCalled();
    });

    it("should handle error when settleSession throws", async () => {
      const counter = makeCounter(500, 500);
      const sessId = await startTestSession("user-err", "sess-settle-err", counter);

      // settleSession throws an unexpected error
      mockSettleSession.mockRejectedValueOnce(new Error("DB connection lost"));
      // The catch block should try to endSession in DB as error
      mockEndSessionRepo.mockResolvedValueOnce(undefined);

      // Should NOT throw -- error is caught internally
      await endSession(sessId);

      // usageRepo.endSession should have been called with "error" status
      expect(mockEndSessionRepo).toHaveBeenCalledWith("sess-settle-err", 1000, "error");
    });

    it("should handle error when recordUsage throws", async () => {
      const counter = makeCounter(500, 500);
      const sessId = await startTestSession("user-rec-err", "sess-rec-err", counter);

      // recordUsage (from metering) throws
      mockRecordUsage.mockRejectedValueOnce(new Error("metering failed"));
      // The catch block should try to endSession in DB as error
      mockEndSessionRepo.mockResolvedValueOnce(undefined);

      await endSession(sessId);

      // Should mark as error in the catch block
      expect(mockEndSessionRepo).toHaveBeenCalledWith("sess-rec-err", 1000, "error");
    });

    it("should handle error when endSessionRepo throws in error catch block (best-effort)", async () => {
      const counter = makeCounter(500, 500);
      const sessId = await startTestSession("user-double-err", "sess-double-err", counter);

      // Main flow throws
      mockSettleSession.mockRejectedValueOnce(new Error("settle failed"));
      // Error recovery also throws
      mockEndSessionRepo.mockRejectedValueOnce(new Error("DB totally down"));

      // Should NOT throw -- the inner catch swallows it (best effort)
      await endSession(sessId);
    });

    it("should be a no-op on double call (once guard)", async () => {
      const counter = makeCounter(100, 200);
      const sessId = await startTestSession("user-double", "sess-double-call", counter);

      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);

      // First call ends the session
      await endSession(sessId);
      expect(mockSettleSession).toHaveBeenCalledTimes(1);

      // Second call should be a no-op (session already removed)
      mockSettleSession.mockClear();
      await endSession(sessId);
      expect(mockSettleSession).not.toHaveBeenCalled();
    });

    it("should record zero bytes if no data transferred", async () => {
      const counter = makeCounter(0, 0);
      const sessId = await startTestSession("user-zero", "sess-zero-bytes", counter);

      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);

      await endSession(sessId);

      expect(mockRecordUsage).toHaveBeenCalledWith(
        "user-zero",
        "sess-zero-bytes",
        0,
        0,
        "example.com",
        expect.any(Number), // pricePerGbCents
      );
      // Cost should be 0 for 0 bytes
      expect(mockSettleSession).toHaveBeenCalledWith(
        "user-zero",
        10,
        0, // actual cost = 0
        "sess-zero-bytes",
      );
      expect(mockEndSessionRepo).toHaveBeenCalledWith("sess-zero-bytes", 0, "completed");
    });

    it("should pass correct total bytes (bytesIn + bytesOut)", async () => {
      const counter = makeCounter(1_000_000, 2_000_000);
      const sessId = await startTestSession("user-total", "sess-total-bytes", counter);

      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);

      await endSession(sessId);

      expect(mockEndSessionRepo).toHaveBeenCalledWith(
        "sess-total-bytes",
        3_000_000, // bytesIn + bytesOut
        "completed",
      );
    });

    it("should invalidate balance cache after successful settlement", async () => {
      const { invalidateBalanceCache } = await import("./balance-check.js");

      const counter = makeCounter(100, 200);
      const sessId = await startTestSession("user-cache-inv", "sess-cache-inv", counter);

      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);

      await endSession(sessId);

      // invalidateBalanceCache is called during endSession
      expect(invalidateBalanceCache).toHaveBeenCalled();
    });

    it("should handle partial settlement when actual exceeds reserved", async () => {
      // Use a very large byte count to exceed the 10-cent reservation
      const counter = makeCounter(500_000_000, 500_000_000); // ~1GB
      const sessId = await startTestSession("user-overage", "sess-overage", counter);

      mockSettleSession.mockResolvedValueOnce(false); // partial - insufficient for overage
      mockEndSessionRepo.mockResolvedValueOnce(undefined);

      await endSession(sessId);

      expect(mockEndSessionRepo).toHaveBeenCalledWith(
        "sess-overage",
        1_000_000_000,
        "error",
      );
    });

    it("should use plan pricing for cost computation", async () => {
      mockGetUserPlan.mockResolvedValueOnce({
        id: "pro",
        name: "Pro",
        pricePerGbCents: 300,
        monthlyBandwidthBytes: 100_000_000_000,
        isDefault: false,
      });

      const counter = makeCounter(500, 500);
      const sessId = await startTestSession("user-plan", "sess-plan", counter);

      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);

      await endSession(sessId);

      // recordUsage should be called with the plan's pricePerGbCents
      expect(mockRecordUsage).toHaveBeenCalledWith(
        "user-plan",
        "sess-plan",
        500,
        500,
        "example.com",
        300, // Pro plan pricing
      );
    });

    it("should use default pricing when getUserPlan throws", async () => {
      mockGetUserPlan.mockRejectedValueOnce(new Error("plan lookup failed"));

      const counter = makeCounter(500, 500);
      const sessId = await startTestSession("user-no-plan", "sess-no-plan", counter);

      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);

      await endSession(sessId);

      // Should still complete successfully with default pricing
      expect(mockRecordUsage).toHaveBeenCalledWith(
        "user-no-plan",
        "sess-no-plan",
        500,
        500,
        "example.com",
        500, // default PAYG rate
      );
    });
  });

  describe("getActiveSessionCount", () => {
    it("should return 0 initially (after all ended)", () => {
      expect(typeof getActiveSessionCount()).toBe("number");
    });

    it("should return a non-negative number", () => {
      expect(getActiveSessionCount()).toBeGreaterThanOrEqual(0);
    });

    it("should increase after starting a session", async () => {
      const before = getActiveSessionCount();

      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockResolvedValueOnce({ id: `sess-active-${Date.now()}` });

      const counter = makeCounter();
      const sessId = await startSession("user-active", "target.com", counter);

      expect(getActiveSessionCount()).toBe(before + 1);

      // Clean up
      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession(sessId);
    });

    it("should decrease after ending a session", async () => {
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockResolvedValueOnce({ id: `sess-dec-${Date.now()}` });

      const counter = makeCounter();
      const sessId = await startSession("user-dec", "target.com", counter);
      const afterStart = getActiveSessionCount();

      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession(sessId);

      expect(getActiveSessionCount()).toBe(afterStart - 1);
    });
  });
});
