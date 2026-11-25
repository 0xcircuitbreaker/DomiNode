import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory proxy_tokens row; reserve/settle mirror the repo's row-locked
// semantics (each call is atomic w.r.t. the others, as under FOR UPDATE).
const tok = vi.hoisted(() => ({
  row: { maxBytes: null as bigint | null, maxSpendMusd: null as bigint | null, bytesUsed: 0n, spendUsedMusd: 0n, revoked: false },
  failReserve: false,
}));
const mockCreateSession = vi.fn();
const mockReserveBalance = vi.fn();

vi.mock("@dominusnode/shared", async () => {
  const real = await vi.importActual<typeof import("./../../shared/src/repositories/proxy-token-repo.js")>("./../../shared/src/repositories/proxy-token-repo.js");
  return {
    walletRepo: {
      reserveBalance: (...a: unknown[]) => mockReserveBalance(...a),
      getBalance: async () => 100_000,
      releaseReservation: vi.fn(),
    },
    agenticWalletRepo: {},
    teamRepo: {},
    sessionRecoveryRepo: { attachRecoveryPayload: vi.fn() },
    usageRepo: { createRelaySession: (...a: unknown[]) => mockCreateSession(...a), endSession: vi.fn() },
    planRepo: {
      getUserPlan: async () => ({ id: "payg", monthlyBandwidthBytes: 0, maxConnections: 1000, maxSessionsPerMinute: 1000 }),
      getMonthlyUsage: async () => 0,
    },
    policyRepo: { getPricing: async () => 500_000n },
    tierRepo: { getChargeSnapshot: async () => ({ splitConfigId: 1, tierId: 1, nodeShareBps: 2500, holdDays: 14 }) },
    relayChargeRepo: { settleRelayCharge: async () => ({ status: "settled", paidInFull: true, grossMusd: 0n, debitCents: 0 }) },
    relaySettleRetryRepo: { enqueueSettleRetry: vi.fn() },
    userRepo: {},
    verifyProxySessionToken: vi.fn(),
    proxyTokenRepo: {
      ...real,
      reserveSessionBudget: async (_id: string, want: bigint, price: bigint, fixed?: bigint | null) => {
        await new Promise((r) => setTimeout(r, Math.random() * 3)); // interleave concurrent callers
        if (tok.failReserve) throw new Error("db down");
        if (tok.row.revoked) return null;
        const g = real.computeGrant(tok.row, want, price, fixed);
        if (!g) return null;
        tok.row.bytesUsed += g.bytes;
        tok.row.spendUsedMusd += g.spendMusd;
        return g;
      },
      settleSessionBudget: async (_id: string, g: { bytes: bigint; spendMusd: bigint }, b: bigint, s: bigint) => {
        const clamp = (v: bigint, cap: bigint | null) => (v < 0n ? 0n : cap !== null && v > cap ? cap : v);
        tok.row.bytesUsed = clamp(tok.row.bytesUsed - g.bytes + b, tok.row.maxBytes);
        tok.row.spendUsedMusd = clamp(tok.row.spendUsedMusd - g.spendMusd + s, tok.row.maxSpendMusd);
        return { exhausted: real.isExhausted(tok.row) };
      },
    },
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    RELAY_BYTES_PER_GB: 1_000_000_000, BYTES_PER_GIB: 1_073_741_824,
    isClassDowngrade: () => false,
  };
});
vi.mock("./balance-check.js", () => ({ invalidateBalanceCache: vi.fn(), invalidateTeamBalanceCache: vi.fn() }));

import { startSession, endSession, terminateProxyTokenSessions, liveProxyTokenIds, registerSessionDestroy, getActiveSessionCount, maxBytesForReservation } from "./session-manager.js";
import type { ByteCounter } from "./counting-stream.js";
import { _resetPolicyEnforcer } from "./policy-enforcer.js";
import { runOnce as sweep } from "./jobs/proxy-token-status.js";
import { reserveProxyTokenBudget, isProxyTokenBudgetError } from "./auth.js";

const TOKEN = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const relay = (proxyTokenId: string | null = TOKEN) => ({ nodeId: "n1", ipClass: "residential" as const, nodeOwnerUserId: "owner", destPort: 443, proxyTokenId });
const counter = (): ByteCounter => ({ bytesIn: 0, bytesOut: 0, maxBytes: 0, onLimitExceeded: null });
let seq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  _resetPolicyEnforcer?.();
  tok.row = { maxBytes: null, maxSpendMusd: null, bytesUsed: 0n, spendUsedMusd: 0n, revoked: false };
  tok.failReserve = false;
  mockReserveBalance.mockResolvedValue("wallet-1");
  mockCreateSession.mockImplementation(async () => ({ id: `s-${++seq}` }));
});

async function start(c: ByteCounter, tokenId: string | null = TOKEN, user = `u-${seq}`): Promise<string> {
  return startSession(user, "example.com", c, 0, relay(tokenId));
}

describe("dn_proxy_ byte/spend caps at session start", () => {
  it("cuts the session's byte cap to the token's remaining bytes and settles to metered usage", async () => {
    tok.row.maxBytes = 5_000n;
    tok.row.bytesUsed = 1_000n;
    const c = counter();
    const id = await start(c);
    expect(c.maxBytes).toBe(4_000);
    expect(tok.row.bytesUsed).toBe(5_000n); // reserved
    c.bytesIn = 1_500;
    await endSession(id);
    expect(tok.row.bytesUsed).toBe(2_500n); // reservation replaced by actual
  });

  it("caps by the remaining spend at the locked price", async () => {
    tok.row.maxSpendMusd = 50n; // $0.50/GB -> 50 µUSD buys 100_000 bytes
    const c = counter();
    const id = await start(c);
    expect(c.maxBytes).toBe(100_000);
    expect(tok.row.spendUsedMusd).toBe(50n);
    c.bytesOut = 10_000;
    await endSession(id);
    expect(tok.row.spendUsedMusd).toBe(5n);
  });

  it("uses the wallet cap when the token budget is larger", async () => {
    tok.row.maxBytes = 10n ** 15n;
    const c = counter();
    const id = await start(c);
    expect(c.maxBytes).toBe(maxBytesForReservation(50, 500_000n));
    await endSession(id);
    expect(tok.row.bytesUsed).toBe(0n);
  });

  it("refuses when the budget is used up, and fails closed when the lookup errors", async () => {
    tok.row.maxBytes = 10n;
    tok.row.bytesUsed = 10n;
    await expect(start(counter())).rejects.toThrow("Proxy token budget exhausted");
    tok.row.bytesUsed = 0n;
    tok.failReserve = true;
    await expect(start(counter())).rejects.toThrow(/proxy token budget/i);
    expect(mockReserveBalance).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("returns the whole grant when the session fails to start after reserving", async () => {
    tok.row.maxBytes = 5_000n;
    mockCreateSession.mockRejectedValueOnce(new Error("db"));
    await expect(start(counter())).rejects.toThrow("db");
    expect(tok.row.bytesUsed).toBe(0n);
  });

  it("the byte counter cuts the stream at the grant", async () => {
    tok.row.maxBytes = 2_000n;
    const c = counter();
    const id = await start(c);
    const destroy = vi.fn();
    registerSessionDestroy(id, destroy);
    c.bytesIn = 2_001;
    c.onLimitExceeded?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(destroy).toHaveBeenCalled();
    expect(tok.row.bytesUsed).toBe(2_000n); // saturated at the cap
  });

  it("race: sessions started together near the cap never grant more than the cap", async () => {
    tok.row.maxBytes = 25_000n;
    tok.row.bytesUsed = 15_000n; // 10_000 left
    const cs = Array.from({ length: 8 }, () => counter());
    const res = await Promise.allSettled(cs.map((c, i) => start(c, TOKEN, `race-${i}`)));
    const ok = res.filter((r) => r.status === "fulfilled");
    const refused = res.filter((r) => r.status === "rejected");
    const granted = cs.filter((_, i) => res[i].status === "fulfilled").reduce((a, c) => a + c.maxBytes, 0);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(granted).toBeLessThanOrEqual(10_000);
    expect(tok.row.bytesUsed).toBeLessThanOrEqual(25_000n);
    for (const r of refused) expect(String((r as PromiseRejectedResult).reason)).toMatch(/budget exhausted/);
    // every session uses its full grant: total metered stays within the cap
    cs.forEach((c) => { c.bytesIn = c.maxBytes; });
    await Promise.all(ok.map((r) => endSession((r as PromiseFulfilledResult<string>).value)));
    expect(tok.row.bytesUsed).toBeLessThanOrEqual(25_000n);
  });

  it("race on the spend cap", async () => {
    tok.row.maxSpendMusd = 30n; // 60_000 bytes at $0.50/GB
    const cs = Array.from({ length: 6 }, () => counter());
    const res = await Promise.allSettled(cs.map((c, i) => start(c, TOKEN, `rs-${i}`)));
    const granted = cs.filter((_, i) => res[i].status === "fulfilled").reduce((a, c) => a + c.maxBytes, 0);
    expect(granted).toBeLessThanOrEqual(60_000);
    expect(tok.row.spendUsedMusd).toBeLessThanOrEqual(30n);
    await Promise.all(res.filter((r) => r.status === "fulfilled").map((r) => endSession((r as PromiseFulfilledResult<string>).value)));
  });

  it("sessions without a token are unaffected", async () => {
    const c = counter();
    const id = await start(c, null);
    expect(c.maxBytes).toBe(maxBytesForReservation(50, 500_000n));
    await endSession(id);
    expect(tok.row.bytesUsed).toBe(0n);
  });
});

describe("per-token session termination", () => {
  it("ends only the revoked token's sessions and closes their sockets", async () => {
    tok.row.maxBytes = 10n ** 12n;
    const a = await start(counter(), TOKEN, "ta");
    const b = await start(counter(), TOKEN, "tb");
    const c = await start(counter(), OTHER, "tc");
    const d = await start(counter(), null, "td");
    const destroyed: string[] = [];
    for (const id of [a, b, c, d]) registerSessionDestroy(id, () => destroyed.push(id));
    expect(liveProxyTokenIds().sort()).toEqual([TOKEN, OTHER].sort());
    const before = getActiveSessionCount();
    expect(await terminateProxyTokenSessions(TOKEN)).toBe(2);
    expect(destroyed.sort()).toEqual([a, b].sort());
    expect(getActiveSessionCount()).toBe(before - 2);
    expect(liveProxyTokenIds()).toEqual([OTHER]);
    await endSession(c);
    await endSession(d);
  });

  it("sweep ends sessions of tokens revoked elsewhere", async () => {
    tok.row.maxBytes = 10n ** 12n;
    const a = await start(counter(), TOKEN, "sa");
    const b = await start(counter(), OTHER, "sb");
    const forget = vi.fn();
    const out = await sweep({
      liveTokenIds: liveProxyTokenIds,
      findEnded: async (ids) => ids.filter((x) => x === TOKEN),
      terminate: terminateProxyTokenSessions,
      forget,
    });
    expect(out).toEqual({ checked: 2, tokens: 1, sessions: 1 });
    expect(forget).toHaveBeenCalledWith(TOKEN);
    expect(liveProxyTokenIds()).toEqual([OTHER]);
    void a;
    await endSession(b);
  });
});

describe("refusal mapping", () => {
  it("only an exhausted budget maps to PROXY_TOKEN_EXHAUSTED (x402/MPP paths included); lookup errors do not", () => {
    expect(isProxyTokenBudgetError(new Error("Proxy token budget exhausted"))).toBe(true);
    expect(isProxyTokenBudgetError(new Error("Unable to verify proxy token budget. Please try again."))).toBe(false);
    expect(isProxyTokenBudgetError("Proxy token budget exhausted")).toBe(false);
    expect(typeof reserveProxyTokenBudget).toBe("function");
  });
});
