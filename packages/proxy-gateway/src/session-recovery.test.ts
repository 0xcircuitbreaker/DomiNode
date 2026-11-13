import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReserveBalance = vi.fn();
const mockReleaseReservation = vi.fn();
const mockCreateSession = vi.fn();
const mockEndSessionRepo = vi.fn();
const mockSettleRelayCharge = vi.fn();
const mockAttach = vi.fn();
const mockHeartbeat = vi.fn();
const mockListRecoverable = vi.fn();
const mockCloseLegacy = vi.fn(async () => 0);
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
    closeLegacyOrphans: (...a: unknown[]) => mockCloseLegacy(...(a as [])),
  },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  RELAY_BYTES_PER_GB: 1_000_000_000,
}));
vi.mock("./balance-check.js", () => ({ invalidateBalanceCache: vi.fn(), invalidateTeamBalanceCache: vi.fn() }));

import { startSession, endSession, configureSessionRecovery, configureSettledHook, heartbeatActiveSessions, recoverOrphanedSessions, getActiveSessionCount } from "./session-manager.js";

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

  it("closes legacy orphans on every recovery pass, not only at startup", async () => {
    mockCloseLegacy.mockClear();
    mockListRecoverable.mockResolvedValue([]);
    await recoverOrphanedSessions(120);
    await recoverOrphanedSessions(120);
    expect(mockCloseLegacy).toHaveBeenCalledTimes(2);
    expect(mockCloseLegacy).toHaveBeenCalledWith(3600);
    mockCloseLegacy.mockRejectedValueOnce(new Error("db down"));
    await expect(recoverOrphanedSessions(120)).resolves.toEqual({ settled: 0, failed: 0 });
    mockListRecoverable.mockReset();
  });

  it("does not report unpaid sessions (zero bytes, zero charge, zeroed) to the registry hook", async () => {
    const events: unknown[] = [];
    configureSettledHook((e) => events.push(e));
    try {
      const rows = [
        { sessionId: "z1", input: { nodeId: "n", requesterUserId: "u", bytesGateway: 0n, destHost: "a" } },
        { sessionId: "z2", input: { nodeId: "n", requesterUserId: "u", bytesGateway: 5000n, destHost: "a" } },
        { sessionId: "z3", input: { nodeId: "n", requesterUserId: "u", bytesGateway: 5000n, destHost: "a" } },
      ];
      mockListRecoverable.mockResolvedValueOnce(rows);
      mockSettleRelayCharge
        .mockResolvedValueOnce({ status: "settled", grossMusd: 0n, nodeMusd: 0n, zeroReason: null })
        .mockResolvedValueOnce({ status: "settled", grossMusd: 0n, nodeMusd: 0n, zeroReason: null })
        .mockResolvedValueOnce({ status: "settled", grossMusd: 900n, nodeMusd: 0n, zeroReason: "self_dealing" });
      await recoverOrphanedSessions(120);
      expect(events).toEqual([]);
    } finally {
      configureSettledHook(null);
    }
  });

  it("reports each settled charge to the node registry hook (reputation, daily stats, earnings)", async () => {
    const events: unknown[] = [];
    configureSettledHook((e) => events.push(e));
    try {
      mockReserveBalance.mockResolvedValueOnce("w1");
      mockCreateSession.mockResolvedValueOnce({ id: "sess-d" });
      await startSession("user-d", "www.example.com", counter(4000, 1000), 0, RELAY);
      mockSettleRelayCharge.mockResolvedValueOnce({ status: "settled", paidInFull: true, grossMusd: 10n, nodeMusd: 3n, debitCents: 0, disputed: true });
      await endSession("sess-d");
      expect(events).toEqual([{ nodeId: "node-1", requesterUserId: "user-d", bytes: 5000, destHost: "www.example.com", nodeMusd: 3n, disputed: true }]);
      // Duplicates (already settled elsewhere) are not counted twice.
      mockListRecoverable.mockResolvedValueOnce([{ sessionId: "x", input: { nodeId: "node-1", requesterUserId: "u", bytesGateway: 1n, destHost: "a" } }]);
      mockSettleRelayCharge.mockResolvedValueOnce({ status: "duplicate", nodeMusd: 1n });
      await recoverOrphanedSessions(120);
      expect(events).toHaveLength(1);
    } finally {
      configureSettledHook(null);
    }
  });
});
