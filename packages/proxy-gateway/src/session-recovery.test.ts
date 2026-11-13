import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReserveBalance = vi.fn();
const mockReleaseReservation = vi.fn();
const mockCreateSession = vi.fn();
const mockEndSessionRepo = vi.fn();
const mockSettleRelayCharge = vi.fn();
const mockAttach = vi.fn();
const mockHeartbeat = vi.fn();
const mockListRecoverable = vi.fn();
const SNAPSHOT = { splitConfigId: 1, tierId: 1, nodeShareBps: 2500, holdDays: 14 };
const RELAY = { nodeId: "node-1", ipClass: "residential" as const, nodeOwnerUserId: "owner-1", destPort: 443 };

vi.mock("@dominusnode/shared", () => ({
  walletRepo: {
    reserveBalance: (...a: unknown[]) => mockReserveBalance(...a),
    getBalance: async () => 100_000,
    releaseReservation: (...a: unknown[]) => mockReleaseReservation(...a),
  },
  usageRepo: {
    createRelaySession: (...a: unknown[]) => mockCreateSession(...a),
    endSession: (...a: unknown[]) => mockEndSessionRepo(...a),
  },
  planRepo: {
    getUserPlan: async () => ({ id: "payg", monthlyBandwidthBytes: 0, maxConnections: 100, maxSessionsPerMinute: 30 }),
    getMonthlyUsage: async () => 0,
  },
  policyRepo: { getPricing: async () => 500_000n },
  tierRepo: { getChargeSnapshot: async () => SNAPSHOT },
  teamRepo: {},
  relayChargeRepo: { settleRelayCharge: (...a: unknown[]) => mockSettleRelayCharge(...a) },
  relaySettleRetryRepo: { enqueueSettleRetry: vi.fn() },
  sessionRecoveryRepo: {
    attachRecoveryPayload: (...a: unknown[]) => mockAttach(...a),
    heartbeatSessions: (...a: unknown[]) => mockHeartbeat(...a),
    listRecoverableSessions: (...a: unknown[]) => mockListRecoverable(...a),
  },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  RELAY_BYTES_PER_GB: 1_000_000_000,
}));
vi.mock("./balance-check.js", () => ({ invalidateBalanceCache: vi.fn(), invalidateTeamBalanceCache: vi.fn() }));

import { startSession, endSession, configureSessionRecovery, heartbeatActiveSessions, recoverOrphanedSessions, getActiveSessionCount } from "./session-manager.js";

const counter = (i = 0, o = 0) => ({ bytesIn: i, bytesOut: o, maxBytes: 0, onLimitExceeded: null });

describe("session crash/restart recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettleRelayCharge.mockResolvedValue({ status: "settled", paidInFull: true, grossMusd: 0n, debitCents: 0 });
    configureSessionRecovery("gw-self");
  });

  it("persists the reservation, price and snapshot on the session row at start", async () => {
    mockReserveBalance.mockResolvedValueOnce("w1");
    mockCreateSession.mockResolvedValueOnce({ id: "sess-a" });
    mockAttach.mockResolvedValueOnce(undefined);
    await startSession("user-a", "example.com", counter(), 0, RELAY);
    expect(mockAttach).toHaveBeenCalledTimes(1);
    const [inst, input] = mockAttach.mock.calls[0] as [string, Record<string, unknown>];
    expect(inst).toBe("gw-self");
    expect(input).toMatchObject({ sessionId: "sess-a", reservedCents: 50, rail: "wallet", pricePerGbMusd: 500_000n, snapshot: SNAPSHOT });
    await endSession("sess-a");
  });

  it("releases the reservation and refuses the session when the payload cannot be stored", async () => {
    mockReserveBalance.mockResolvedValueOnce("w1");
    mockCreateSession.mockResolvedValueOnce({ id: "sess-b" });
    mockAttach.mockRejectedValueOnce(new Error("db down"));
    await expect(startSession("user-b", "example.com", counter(), 0, RELAY)).rejects.toThrow("db down");
    expect(mockReleaseReservation).toHaveBeenCalledWith("user-b", 50);
    expect(mockEndSessionRepo).toHaveBeenCalledWith("sess-b", 0, "error");
    expect(getActiveSessionCount()).toBe(0);
  });

  it("heartbeats live sessions with their current gateway byte counts", async () => {
    mockReserveBalance.mockResolvedValueOnce("w1");
    mockCreateSession.mockResolvedValueOnce({ id: "sess-c" });
    const c = counter();
    await startSession("user-c", "example.com", c, 0, RELAY);
    c.bytesIn = 1234; c.bytesOut = 99;
    await heartbeatActiveSessions();
    expect(mockHeartbeat).toHaveBeenCalledWith("gw-self", [{ sessionId: "sess-c", bytesIn: 1234, bytesOut: 99 }]);
    await endSession("sess-c");
  });

  it("settles orphaned sessions (refunding the rest of the reservation) instead of marking them error", async () => {
    const input = { sessionId: "sess-old", reservedCents: 50, bytesGateway: 1000n };
    mockListRecoverable.mockResolvedValueOnce([{ sessionId: "sess-old", input }]);
    const r = await recoverOrphanedSessions(120);
    expect(mockListRecoverable).toHaveBeenCalledWith("gw-self", 120, 1000);
    expect(mockSettleRelayCharge).toHaveBeenCalledWith(input);
    expect(r).toEqual({ settled: 1, failed: 0 });
  });
});
