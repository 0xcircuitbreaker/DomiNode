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
const mockGetPricing = vi.fn();
const mockGetChargeSnapshot = vi.fn();
const mockSettleRelayCharge = vi.fn();
const mockGetBalance = vi.fn();
const mockEnqueueRetry = vi.fn();
const SNAPSHOT = { splitConfigId: 1, tierId: 1, nodeShareBps: 2500, holdDays: 14 };
const RELAY = { nodeId: "node-1", ipClass: "residential" as const, nodeOwnerUserId: "owner-1", destPort: 443 };

vi.mock("@dominusnode/shared", () => ({
  walletRepo: {
    reserveBalance: (...args: unknown[]) => mockReserveBalance(...args),
    getBalance: (...args: unknown[]) => mockGetBalance(...args),
    releaseReservation: (...args: unknown[]) => mockReleaseReservation(...args),
    settleSession: (...args: unknown[]) => mockSettleSession(...args),
  },
  usageRepo: {
    createRelaySession: (...args: unknown[]) => mockCreateSession(...args),
    endSession: (...args: unknown[]) => mockEndSessionRepo(...args),
    createUsageRecord: (...args: unknown[]) => mockCreateUsageRecord(...args),
  },
  planRepo: {
    getUserPlan: (...args: unknown[]) => mockGetUserPlan(...args),
    getMonthlyUsage: (...args: unknown[]) => mockGetMonthlyUsage(...args),
  },
  policyRepo: { getPricing: (...args: unknown[]) => mockGetPricing(...args) },
  tierRepo: { getChargeSnapshot: (...args: unknown[]) => mockGetChargeSnapshot(...args) },
  relayChargeRepo: { settleRelayCharge: (...args: unknown[]) => mockSettleRelayCharge(...args) },
  relaySettleRetryRepo: { enqueueSettleRetry: (...args: unknown[]) => mockEnqueueRetry(...args) },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  BYTES_PER_GB: 1_073_741_824,
}));

const mockRecordUsage = vi.fn().mockResolvedValue({});

vi.mock("@dominusnode/metering", () => ({
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

import { startSession, endSession, getActiveSessionCount, checkSessionRateLimit, checkBandwidthVelocity, recordBandwidthUsage, reservationCentsFor, maxBytesForReservation, startPrepaidSession, maxBytesForPrepaid, abortPrepaidSession, awaitInFlightSettlements, getInFlightSettlementCount } from "./session-manager.js";
import type { ByteCounter } from "./counting-stream.js";
import { enforcePolicy, _resetPolicyEnforcer, getRequesterInflightSpend, getRequesterSpend } from "./policy-enforcer.js";
const BYTES_PER_GB = 1_073_741_824;

function makeCounter(bytesIn = 0, bytesOut = 0): ByteCounter {
  return { bytesIn, bytesOut, maxBytes: 0, onLimitExceeded: null };
}

// Helper to start a session and return the sessionId for endSession tests
async function startTestSession(
  userId: string,
  sessionId: string,
  counter: ByteCounter,
): Promise<string> {
  mockReserveBalance.mockResolvedValueOnce("wallet-1");
  mockCreateSession.mockResolvedValueOnce({ id: sessionId });
  return startSession(userId, "example.com", counter, 0, RELAY);
}

describe("proxy-gateway/session-manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: plan lookup returns default PAYG rate (unlimited bandwidth)
    mockGetUserPlan.mockResolvedValue({ id: "payg", name: "PAYG", pricePerGbCents: 500, monthlyBandwidthBytes: 0, isDefault: true, maxConnections: 100, maxSessionsPerMinute: 30 });
    mockGetMonthlyUsage.mockResolvedValue(0);
    mockGetPricing.mockResolvedValue(500_000n);
    mockGetBalance.mockResolvedValue(100_000);
    mockGetChargeSnapshot.mockResolvedValue(SNAPSHOT);
    mockSettleRelayCharge.mockResolvedValue({ status: "settled", paidInFull: true, grossMusd: 0n, debitCents: 0 });
  });

  describe("reservation sizing (DESIGN.md §8)", () => {
    it("reserves ceil(price x byteCap), not a flat 50c", async () => {
      mockGetPricing.mockResolvedValueOnce(100_000n); // $0.10/GB -> 10c for the 1GB cap
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockResolvedValueOnce({ id: "sess-price" });
      const counter = makeCounter();
      await startSession("user-p", "example.com", counter, 0, RELAY);
      expect(mockReserveBalance).toHaveBeenCalledWith("user-p", 10);
      await endSession("sess-price");
    });

    it("caps the reservation at the available balance instead of refusing", async () => {
      mockGetBalance.mockResolvedValueOnce(7);
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockResolvedValueOnce({ id: "sess-low" });
      const counter = makeCounter();
      await startSession("user-low", "example.com", counter, 0, RELAY);
      expect(mockReserveBalance).toHaveBeenCalledWith("user-low", 7);
      // 7c at $0.50/GB, no 10% overrun headroom
      expect(counter.maxBytes).toBe(maxBytesForReservation(7, 500_000n));
      expect(counter.maxBytes * 500_000 / BYTES_PER_GB / 10_000).toBeLessThanOrEqual(7);
      await endSession("sess-low");
    });

    it("refuses a zero balance without attempting a reservation", async () => {
      mockGetBalance.mockResolvedValueOnce(0);
      await expect(startSession("user-zero", "example.com", makeCounter(), 0, RELAY)).rejects.toThrow("Insufficient balance");
      expect(mockReserveBalance).not.toHaveBeenCalled();
    });

    it("reservationCentsFor rounds up and is at least 1c", () => {
      expect(reservationCentsFor(500_000n, BYTES_PER_GB)).toBe(50);
      expect(reservationCentsFor(1n, 1024)).toBe(1);
      expect(reservationCentsFor(0n)).toBe(0);
    });
  });

  describe("startSession", () => {
    it("should reserve balance and create session", async () => {
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockResolvedValueOnce({ id: "sess-123" });

      const counter = makeCounter();
      const sessionId = await startSession("user-1", "example.com", counter, 0, RELAY);

      expect(sessionId).toBe("sess-123");
      expect(mockReserveBalance).toHaveBeenCalledWith("user-1", 50); // MIN_RESERVATION_CENTS
      expect(mockCreateSession).toHaveBeenCalledWith("user-1", "node-1", 443);
    });

    it("should throw if insufficient balance for reservation", async () => {
      mockReserveBalance.mockResolvedValueOnce(null);

      const counter = makeCounter();
      await expect(
        startSession("user-1", "example.com", counter, 0, RELAY),
      ).rejects.toThrow("Insufficient balance for reservation");
    });

    it("should release reservation if DB session creation fails", async () => {
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockRejectedValueOnce(new Error("DB error"));

      const counter = makeCounter();
      await expect(
        startSession("user-1", "example.com", counter, 0, RELAY),
      ).rejects.toThrow("DB error");

      expect(mockReleaseReservation).toHaveBeenCalledWith("user-1", 50);
    });

    it("should not call createSession if reservation fails", async () => {
      mockReserveBalance.mockResolvedValueOnce(null);

      const counter = makeCounter();
      await expect(
        startSession("user-1", "example.com", counter, 0, RELAY),
      ).rejects.toThrow("Insufficient balance");

      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it("should increment active session count after starting", async () => {
      const before = getActiveSessionCount();

      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockResolvedValueOnce({ id: `sess-count-${Date.now()}` });

      const counter = makeCounter();
      const sessId = await startSession("user-count", "target.io", counter, 0, RELAY);

      expect(getActiveSessionCount()).toBeGreaterThanOrEqual(before + 1);

      // Clean up by ending the session
      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession(sessId);
    });

    it("should pass target host correctly when logTargetHosts=true", async () => {
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockResolvedValueOnce({ id: "sess-target" });

      const counter = makeCounter();
      await startSession("user-1", "api.example.org", counter, 0, RELAY, undefined, true);

      // End the session and verify targetHost is used in recordUsage
      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession("sess-target");

      // recordUsage now takes 8 args: userId, sessionId, bytesIn, bytesOut, targetHost, pricePerGbCents, connectLatencyMs, proxyType
      expect(mockSettleRelayCharge).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess-target", usageTargetHost: "api.example.org" }));
    });

    it("should store empty targetHost when logTargetHosts=false (default)", async () => {
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockResolvedValueOnce({ id: "sess-private" });

      const counter = makeCounter();
      await startSession("user-1", "api.example.org", counter, 0, RELAY);

      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession("sess-private");

      expect(mockSettleRelayCharge).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess-private", usageTargetHost: "" }));
    });

    it("should propagate non-balance DB errors", async () => {
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockRejectedValueOnce(new Error("connection timeout"));

      const counter = makeCounter();
      await expect(
        startSession("user-1", "example.com", counter, 0, RELAY),
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
        startSession("user-free", "example.com", counter, 0, RELAY),
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
      const sessId = await startSession("user-free", "example.com", counter, 0, RELAY);
      expect(sessId).toBe("sess-within-limit");

      // Free plan: no reservation should have been made
      expect(mockReserveBalance).not.toHaveBeenCalled();

      // Clean up (free plan endSession skips wallet settlement)
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession(sessId);
    });

    it("caps free-plan session bytes at the per-session reservation, not the whole remaining quota", async () => {
      mockGetUserPlan.mockResolvedValueOnce({
        id: "free", name: "Free", pricePerGbCents: 0, monthlyBandwidthBytes: 1073741824,
        isDefault: true, maxConnections: 10, maxSessionsPerMinute: 30,
      });
      mockGetMonthlyUsage.mockResolvedValueOnce(0);
      mockCreateSession.mockResolvedValueOnce({ id: "sess-free-cap" });

      const counter = makeCounter();
      const sessId = await startSession("user-free-cap", "example.com", counter, 0, RELAY);
      expect(counter.maxBytes).toBe(50 * 1024 * 1024);

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
      const sessId = await startSession("user-free2", "example.com", counter, 0, RELAY);
      expect(sessId).toBe("sess-free-no-reserve");

      // Should NOT have attempted to reserve balance
      expect(mockReserveBalance).not.toHaveBeenCalled();

      // End session: should record usage but skip wallet settlement
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession(sessId);

      // Usage should still be recorded (targetHost is "" because logTargetHosts defaults to false)
      expect(mockSettleRelayCharge).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess-free-no-reserve", usageTargetHost: "" }));
      // Wallet settle should NOT have been called
      expect(mockSettleSession).not.toHaveBeenCalled();
      expect(mockSettleRelayCharge).toHaveBeenCalledWith(expect.objectContaining({ rail: "free", bytesGateway: 15000n }));
    });

    it("should skip bandwidth check for unlimited plans (0 bytes)", async () => {
      // PAYG has monthlyBandwidthBytes = 0 (unlimited) — already default mock
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockResolvedValueOnce({ id: "sess-unlimited" });

      const counter = makeCounter();
      const sessId = await startSession("user-payg", "example.com", counter, 0, RELAY);
      expect(sessId).toBe("sess-unlimited");

      // getMonthlyUsage should NOT have been called (skipped because limit is 0)
      expect(mockGetMonthlyUsage).not.toHaveBeenCalled();

      // Clean up
      mockSettleSession.mockResolvedValueOnce(true);
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession(sessId);
    });

    it("should reject session when plan check fails (fail closed)", async () => {
      mockGetUserPlan.mockRejectedValueOnce(new Error("DB connection error"));

      const counter = makeCounter();
      await expect(
        startSession("user-err", "example.com", counter, 0, RELAY),
      ).rejects.toThrow("Unable to verify plan. Please try again.");
    });
  });

  describe("startPrepaidSession (x402)", () => {
    it("reserves nothing, caps bytes at what the payment bought, and settles as x402 with gross = paid", async () => {
      mockCreateSession.mockResolvedValueOnce({ id: "sess-x402" });
      const counter = makeCounter(100, 200);
      const id = await startPrepaidSession({
        userId: "x402-user", targetHost: "example.com", counter, connectLatencyMs: 0, relay: RELAY,
        rail: "x402", paidMusd: 4883n, quotedPricePerGbMusd: 500_000n, maxBytes: 10_485_760,
      });
      expect(id).toBe("sess-x402");
      expect(mockReserveBalance).not.toHaveBeenCalled();
      expect(mockGetBalance).not.toHaveBeenCalled();
      expect(counter.maxBytes).toBe(Math.min(maxBytesForPrepaid(4883n, 500_000n), 10_485_760));
      expect(counter.maxBytes).toBeLessThanOrEqual(10_485_760);
      mockSettleRelayCharge.mockResolvedValueOnce({ status: "settled", paidInFull: true, grossMusd: 4883n, debitCents: 0 });
      await endSession(id);
      expect(mockSettleRelayCharge).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "sess-x402", requesterUserId: "x402-user", rail: "x402", reservedCents: 0, prepaidGrossMusd: 4883n,
        pricePerGbMusd: 500_000n, bytesGateway: 300n,
      }));
    });

    it("abortPrepaidSession closes the session with no relay charge, once", async () => {
      mockCreateSession.mockResolvedValueOnce({ id: "sess-abort" });
      const id = await startPrepaidSession({
        userId: "x402-user", targetHost: "example.com", counter: makeCounter(10, 10), connectLatencyMs: 0, relay: RELAY,
        rail: "x402", paidMusd: 4883n, quotedPricePerGbMusd: 500_000n, maxBytes: 10_485_760,
      });
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      expect(await abortPrepaidSession(id)).toBe(true);
      expect(await abortPrepaidSession(id)).toBe(false);
      await endSession(id);
      expect(mockSettleRelayCharge).not.toHaveBeenCalled();
      expect(mockEndSessionRepo).toHaveBeenCalledWith("sess-abort", 0, "error");
    });

    it("refuses a non-positive prepaid amount", async () => {
      await expect(startPrepaidSession({
        userId: "u", targetHost: "example.com", counter: makeCounter(), connectLatencyMs: 0, relay: RELAY,
        rail: "x402", paidMusd: 0n, quotedPricePerGbMusd: 500_000n, maxBytes: 1000,
      })).rejects.toThrow();
      expect(mockCreateSession).not.toHaveBeenCalled();
    });
  });

  describe("endSession", () => {
    const settled = (over: Record<string, unknown> = {}) => ({
      status: "settled", relayChargeId: "rc-1", paidInFull: true, grossMusd: 10_000n, nodeMusd: 2_500n,
      platformMusd: 7_500n, debitCents: 1, zeroReason: null, ...over,
    });

    it("settles through settleRelayCharge with gateway bytes and locked price/split", async () => {
      const counter = makeCounter(1000, 2000);
      const sessId = await startTestSession("user-1", "sess-end-1", counter);
      mockSettleRelayCharge.mockResolvedValueOnce(settled());

      await endSession(sessId);

      expect(mockSettleRelayCharge).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "sess-end-1",
        requesterUserId: "user-1",
        rail: "wallet",
        reservedCents: 50,
        nodeId: "node-1",
        bytesGateway: 3000n,
        bytesIn: 1000,
        bytesOut: 2000,
        pricePerGbMusd: 500_000n,
        snapshot: SNAPSHOT,
        destHost: "example.com",
        destPort: 443,
      }));
      expect(mockEndSessionRepo).not.toHaveBeenCalled();
    });

    it("tracks in-flight settlements so shutdown can await them before closing the pool", async () => {
      const sessId = await startTestSession("user-sd", "sess-sd", makeCounter(10, 10));
      let commit!: () => void;
      mockSettleRelayCharge.mockImplementationOnce(() => new Promise((r) => { commit = () => r(settled()); }));
      const before = getActiveSessionCount();
      const p = endSession(sessId);
      expect(getActiveSessionCount()).toBe(before - 1); // gone from the active map already...
      expect(getInFlightSettlementCount()).toBe(1); // ...but still settling
      let drained = false;
      const wait = awaitInFlightSettlements(5_000).then((ok) => { drained = ok; });
      await new Promise((r) => setTimeout(r, 10));
      expect(drained).toBe(false);
      commit();
      await wait;
      await p;
      expect(drained).toBe(true);
      expect(getInFlightSettlementCount()).toBe(0);
    });

    it("awaitInFlightSettlements gives up at the timeout", async () => {
      const sessId = await startTestSession("user-sd2", "sess-sd2", makeCounter(1, 1));
      let commit!: () => void;
      mockSettleRelayCharge.mockImplementationOnce(() => new Promise((r) => { commit = () => r(settled()); }));
      const p = endSession(sessId);
      expect(await awaitInFlightSettlements(20)).toBe(false);
      commit();
      await p;
    });

    it("counts in-flight reservations against the daily spend cap (no concurrency bypass)", async () => {
      _resetPolicyEnforcer();
      const policy = { ports: [443], denyDomains: [], plaintext: "allow", requesterLimits: { reqPerSec: 1000, dailySpendMusd: 1_000_000 } } as any;
      expect(enforcePolicy(policy, { userId: "user-cap", host: "example.com", port: 443, plaintext: false, allowHttp: false }).allowed).toBe(true);
      // 50c reservations = 500_000 µUSD each against a 1_000_000 µUSD cap
      const a = await startTestSession("user-cap", "sess-cap-a", makeCounter(1, 1));
      await startTestSession("user-cap", "sess-cap-b", makeCounter(1, 1));
      expect(getRequesterInflightSpend("user-cap")).toBe(1_000_000n);
      await expect(startSession("user-cap", "example.com", makeCounter(), 0, RELAY)).rejects.toThrow("Daily spend cap reached");
      expect(enforcePolicy(policy, { userId: "user-cap", host: "example.com", port: 443, plaintext: false, allowHttp: false }))
        .toMatchObject({ allowed: false, code: "SPEND_CAP_EXCEEDED" });
      // Settle: the hold is replaced by the real (small) spend.
      mockSettleRelayCharge.mockResolvedValueOnce(settled({ grossMusd: 1_000n }));
      await endSession(a);
      expect(getRequesterInflightSpend("user-cap")).toBe(500_000n);
      expect(getRequesterSpend("user-cap")).toBe(1_000n);
      await startTestSession("user-cap", "sess-cap-d", makeCounter());
      _resetPolicyEnforcer();
    });

    it("releases the in-flight hold when session start fails", async () => {
      _resetPolicyEnforcer();
      mockReserveBalance.mockResolvedValueOnce("wallet-1");
      mockCreateSession.mockRejectedValueOnce(new Error("db down"));
      await expect(startSession("user-hold", "example.com", makeCounter(), 0, RELAY)).rejects.toThrow("db down");
      expect(getRequesterInflightSpend("user-hold")).toBe(0n);
      _resetPolicyEnforcer();
    });

    it("locks price per node class and owner tier at start", async () => {
      await startTestSession("user-lock", "sess-lock", makeCounter());
      expect(mockGetPricing).toHaveBeenCalledWith("residential");
      expect(mockGetChargeSnapshot).toHaveBeenCalledWith("owner-1");
      expect(mockCreateSession).toHaveBeenCalledWith("user-lock", "node-1", 443);
    });

    it("rejects the session when pricing cannot be locked (fail closed)", async () => {
      mockGetPricing.mockRejectedValueOnce(new Error("network pricing not configured"));
      await expect(startSession("user-np", "example.com", makeCounter(), 0, RELAY))
        .rejects.toThrow("Unable to lock relay pricing");
    });

    it("should be a no-op for unknown session ID", async () => {
      await endSession("unknown-session");
      expect(mockSettleRelayCharge).not.toHaveBeenCalled();
    });

    it("queues a durable retry (session left active) when settleRelayCharge throws", async () => {
      const sessId = await startTestSession("user-err", "sess-settle-err", makeCounter(500, 500));
      mockSettleRelayCharge.mockRejectedValueOnce(new Error("DB connection lost"));
      mockEnqueueRetry.mockResolvedValueOnce(undefined);
      await endSession(sessId);
      expect(mockEnqueueRetry).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "sess-settle-err", requesterUserId: "user-err", reservedCents: 50, bytesGateway: 1000n, rail: "wallet",
      }), "DB connection lost");
      expect(mockEndSessionRepo).not.toHaveBeenCalled();
    });

    it("marks session error only when the retry cannot be queued", async () => {
      const sessId = await startTestSession("user-err2", "sess-settle-err2", makeCounter(500, 500));
      mockSettleRelayCharge.mockRejectedValueOnce(new Error("DB connection lost"));
      mockEnqueueRetry.mockRejectedValueOnce(new Error("DB down"));
      mockEndSessionRepo.mockResolvedValueOnce(undefined);
      await endSession(sessId);
      expect(mockEndSessionRepo).toHaveBeenCalledWith("sess-settle-err2", 1000, "error");
    });

    it("swallows errors in the error-recovery path (best-effort)", async () => {
      const sessId = await startTestSession("user-double-err", "sess-double-err", makeCounter(500, 500));
      mockEnqueueRetry.mockRejectedValueOnce(new Error("queue down"));
      mockSettleRelayCharge.mockRejectedValueOnce(new Error("settle failed"));
      mockEndSessionRepo.mockRejectedValueOnce(new Error("DB totally down"));
      await endSession(sessId);
    });

    it("should be a no-op on double call (once guard)", async () => {
      const sessId = await startTestSession("user-double", "sess-double-call", makeCounter(100, 200));
      mockSettleRelayCharge.mockResolvedValueOnce(settled());
      await endSession(sessId);
      await endSession(sessId);
      expect(mockSettleRelayCharge).toHaveBeenCalledTimes(1);
    });

    it("invalidates the balance cache after settlement", async () => {
      const { invalidateBalanceCache } = await import("./balance-check.js");
      const sessId = await startTestSession("user-cache-inv", "sess-cache-inv", makeCounter(100, 200));
      mockSettleRelayCharge.mockResolvedValueOnce(settled());
      await endSession(sessId);
      expect(invalidateBalanceCache).toHaveBeenCalled();
    });

    it("uses the free rail for free plans", async () => {
      mockGetUserPlan.mockResolvedValueOnce({
        id: "free", name: "Free", pricePerGbCents: 0, monthlyBandwidthBytes: 1_000_000_000,
        isDefault: true, maxConnections: 10, maxSessionsPerMinute: 30,
      });
      mockGetMonthlyUsage.mockResolvedValueOnce(0);
      mockCreateSession.mockResolvedValueOnce({ id: "sess-free-rail" });
      const sessId = await startSession("user-free-rail", "example.com", makeCounter(10, 10), 0, RELAY);
      mockSettleRelayCharge.mockResolvedValueOnce(settled({ grossMusd: 0n, debitCents: 0 }));
      await endSession(sessId);
      expect(mockSettleRelayCharge).toHaveBeenCalledWith(expect.objectContaining({ rail: "free", reservedCents: 0 }));
    });

    it("should reject session when getUserPlan throws (fail closed)", async () => {
      mockGetUserPlan.mockRejectedValueOnce(new Error("plan lookup failed"));

      const counter = makeCounter(500, 500);
      // Sessions are now rejected when plan can't be determined
      await expect(
        startSession("user-no-plan", "example.com", counter, 0, RELAY),
      ).rejects.toThrow("Unable to verify plan. Please try again.");
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
      const sessId = await startSession("user-active", "target.com", counter, 0, RELAY);

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
      const sessId = await startSession("user-dec", "target.com", counter, 0, RELAY);
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
        startSession(userId, "example.com", counter, 0, RELAY),
      ).rejects.toThrow("Session rate limit exceeded");
    });

    it("should respect per-plan session rate limit", () => {
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
