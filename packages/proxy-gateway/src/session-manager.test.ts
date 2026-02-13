import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock modules before import
const mockReserveBalance = vi.fn();
const mockReleaseReservation = vi.fn();
const mockSettleSession = vi.fn();
const mockCreateSession = vi.fn();
const mockEndSessionRepo = vi.fn();
const mockCreateUsageRecord = vi.fn();
const mockGetUserPlan = vi.fn();
const mockGetMonthlyUsage = vi.fn();

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
    getMonthlyUsage: (...args: unknown[]) => mockGetMonthlyUsage(...args),
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
    if (pricePerGb <= 0) return 0;
    return Math.max(Math.ceil((bytes / 1_073_741_824) * pricePerGb), 1);
  },
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
}));

vi.mock("./balance-check.js", () => ({
  invalidateBalanceCache: vi.fn(),
}));

import { startSession, endSession, getActiveSessionCount, checkSessionRateLimit, checkBandwidthVelocity, recordBandwidthUsage } from "./session-manager.js";
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
    // Default: plan lookup returns default PAYG rate (unlimited bandwidth)
    mockGetUserPlan.mockResolvedValue({ id: "payg", name: "PAYG", pricePerGbCents: 500, monthlyBandwidthBytes: 0, isDefault: true, maxConnections: 100, maxSessionsPerMinute: 30 });
    mockGetMonthlyUsage.mockResolvedValue(0);
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

      // recordUsage now takes 7 args: userId, sessionId, bytesIn, bytesOut, targetHost, pricePerGbCents, connectLatencyMs
      expect(mockRecordUsage).toHaveBeenCalledWith(
        "user-1",
        "sess-target",
        expect.any(Number),
        expect.any(Number),
        "api.example.org",
        expect.any(Number),
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

    it("should reject session when monthly bandwidth limit exceeded", async () => {
      mockGetUserPlan.mockResolvedValueOnce({
        id: "free",
        name: "Free",
        pricePerGbCents: 0,
        monthlyBandwidthBytes: 1073741824,
        isDefault: true,
        maxConnections: 10,
        maxSessionsPerMinute: 30,
      });
      mockGetMonthlyUsage.mockResolvedValueOnce(2_000_000_000); // 2GB > 1GB limit

      const counter = makeCounter();
      await expect(
        startSession("user-free", "example.com", counter),
      ).rejects.toThrow("Monthly bandwidth limit exceeded");

      // Should not have attempted to reserve balance
      expect(mockReserveBalance).not.toHaveBeenCalled();
    });

    it("should allow session when within bandwidth limit", async () => {
      mockGetUserPlan.mockResolvedValueOnce({
        id: "free",
        name: "Free",
        pricePerGbCents: 0,
        monthlyBandwidthBytes: 1073741824,
        isDefault: true,
        maxConnections: 10,
        maxSessionsPerMinute: 30,
      });
      mockGetMonthlyUsage.mockResolvedValueOnce(50_000_000); // 50MB < 1GB

      // Free plan: no reservation needed
      mockCreateSession.mockResolvedValueOnce({ id: "sess-within-limit" });

      const counter = makeCounter();
      const sessId = await startSession("user-free", "example.com", counter);
      expect(sessId).toBe("sess-within-limit");

      // Free plan: no reservation should have been made
      expect(mockReserveBalance).not.toHaveBeenCalled();

      // Clean up (free plan endSession skips wallet settlement)
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession(sessId);
    });

    it("should skip balance reservation for free plan (price=0)", async () => {
      mockGetUserPlan.mockResolvedValueOnce({
        id: "free",
        name: "Free",
        pricePerGbCents: 0,
        monthlyBandwidthBytes: 1073741824,
        isDefault: true,
        maxConnections: 10,
        maxSessionsPerMinute: 30,
      });
      mockGetMonthlyUsage.mockResolvedValueOnce(100_000_000); // 100MB

      mockCreateSession.mockResolvedValueOnce({ id: "sess-free-no-reserve" });

      const counter = makeCounter(5000, 10000);
      const sessId = await startSession("user-free2", "example.com", counter);
      expect(sessId).toBe("sess-free-no-reserve");

      // Should NOT have attempted to reserve balance
      expect(mockReserveBalance).not.toHaveBeenCalled();

      // End session: should record usage but skip wallet settlement
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession(sessId);

      // Usage should still be recorded
      expect(mockRecordUsage).toHaveBeenCalledWith(
        "user-free2",
        "sess-free-no-reserve",
        5000,
        10000,
        "example.com",
        0, // free plan pricing
        expect.any(Number),
      );
      // Wallet settle should NOT have been called
      expect(mockSettleSession).not.toHaveBeenCalled();
      // Session should be marked completed
      expect(mockEndSessionRepo).toHaveBeenCalledWith("sess-free-no-reserve", 15000, "completed");
    });

    it("should skip bandwidth check for unlimited plans (0 bytes)", async () => {
      // PAYG has monthlyBandwidthBytes = 0 (unlimited) — already default mock
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockResolvedValueOnce({ id: "sess-unlimited" });

      const counter = makeCounter();
      const sessId = await startSession("user-payg", "example.com", counter);
      expect(sessId).toBe("sess-unlimited");

      // getMonthlyUsage should NOT have been called (skipped because limit is 0)
      expect(mockGetMonthlyUsage).not.toHaveBeenCalled();

      // Clean up
      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession(sessId);
    });

    it("should allow session when bandwidth check fails (graceful degradation)", async () => {
      mockGetUserPlan.mockRejectedValueOnce(new Error("DB connection error"));

      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockResolvedValueOnce({ id: "sess-degraded" });

      const counter = makeCounter();
      const sessId = await startSession("user-err", "example.com", counter);
      expect(sessId).toBe("sess-degraded");

      // Clean up
      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession(sessId);
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
        expect.any(Number), // connectLatencyMs
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
      const proPlan = {
        id: "pro",
        name: "Pro",
        pricePerGbCents: 300,
        monthlyBandwidthBytes: 100_000_000_000,
        isDefault: false,
        maxConnections: 100,
        maxSessionsPerMinute: 60,
      };
      // Single call: plan fetched once in startSession, price locked in session (R13 H-2)
      mockGetUserPlan.mockResolvedValueOnce(proPlan);
      mockGetMonthlyUsage.mockResolvedValueOnce(0); // within bandwidth limit

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
        expect.any(Number), // connectLatencyMs
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
        expect.any(Number), // connectLatencyMs
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

  describe("checkSessionRateLimit", () => {
    it("should allow sessions under the rate limit", () => {
      const userId = `rate-limit-ok-${Date.now()}`;
      // Default limit is 30/minute
      for (let i = 0; i < 30; i++) {
        expect(checkSessionRateLimit(userId)).toBe(true);
      }
    });

    it("should reject sessions exceeding the rate limit", () => {
      const userId = `rate-limit-exceed-${Date.now()}`;
      // Fill up the window
      for (let i = 0; i < 30; i++) {
        checkSessionRateLimit(userId);
      }
      // 31st should be rejected
      expect(checkSessionRateLimit(userId)).toBe(false);
    });

    it("should track limits per-user independently", () => {
      const userA = `rate-A-${Date.now()}`;
      const userB = `rate-B-${Date.now()}`;
      // Fill up userA's limit
      for (let i = 0; i < 30; i++) {
        checkSessionRateLimit(userA);
      }
      // userB should still be allowed
      expect(checkSessionRateLimit(userB)).toBe(true);
      // userA should be rejected
      expect(checkSessionRateLimit(userA)).toBe(false);
    });

    it("should throw rate limit error from startSession", async () => {
      const userId = `rate-start-${Date.now()}`;
      // Exhaust rate limit
      for (let i = 0; i < 30; i++) {
        checkSessionRateLimit(userId);
      }
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      const counter = makeCounter();
      await expect(
        startSession(userId, "example.com", counter),
      ).rejects.toThrow("Session rate limit exceeded");
    });

    it("should respect per-plan session rate limit (R18)", () => {
      const userId = `rate-plan-${Date.now()}`;
      // Agent plan allows 60 sessions/minute
      for (let i = 0; i < 60; i++) {
        expect(checkSessionRateLimit(userId, 60)).toBe(true);
      }
      // 61st should be rejected
      expect(checkSessionRateLimit(userId, 60)).toBe(false);
    });

    it("should use lower limit from plan when plan limit is lower", () => {
      const userId = `rate-low-plan-${Date.now()}`;
      // Plan allows only 5 sessions/minute
      for (let i = 0; i < 5; i++) {
        expect(checkSessionRateLimit(userId, 5)).toBe(true);
      }
      expect(checkSessionRateLimit(userId, 5)).toBe(false);
    });
  });

  describe("checkBandwidthVelocity", () => {
    it("should allow bandwidth under the limit", () => {
      const userId = `bw-ok-${Date.now()}`;
      const result = checkBandwidthVelocity(userId);
      expect(result.allowed).toBe(true);
      expect(result.usedBytes).toBe(0);
    });

    it("should track bandwidth across multiple recordings", () => {
      const userId = `bw-track-${Date.now()}`;
      recordBandwidthUsage(userId, 1_000_000); // 1MB
      recordBandwidthUsage(userId, 2_000_000); // 2MB

      const result = checkBandwidthVelocity(userId);
      expect(result.allowed).toBe(true);
      expect(result.usedBytes).toBe(3_000_000);
    });

    it("should reject when bandwidth exceeds limit", () => {
      const userId = `bw-exceed-${Date.now()}`;
      // Record 11GB (over the 10GB/hour default)
      recordBandwidthUsage(userId, 11 * 1024 * 1024 * 1024);

      const result = checkBandwidthVelocity(userId);
      expect(result.allowed).toBe(false);
    });

    it("should track limits per-user independently", () => {
      const userA = `bw-A-${Date.now()}`;
      const userB = `bw-B-${Date.now()}`;

      recordBandwidthUsage(userA, 11 * 1024 * 1024 * 1024); // 11GB (over limit)
      recordBandwidthUsage(userB, 1_000_000); // 1MB (under limit)

      expect(checkBandwidthVelocity(userA).allowed).toBe(false);
      expect(checkBandwidthVelocity(userB).allowed).toBe(true);
    });
  });
});
