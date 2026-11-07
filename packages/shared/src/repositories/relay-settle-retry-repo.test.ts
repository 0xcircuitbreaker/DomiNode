import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("../db.js", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
import { encodeSettleInput, decodeSettleInput, enqueueSettleRetry, listDueSettleRetries, markSettleRetryFailed } from "./relay-settle-retry-repo.js";
import type { SettleRelayChargeInput } from "./relay-charge-repo.js";

const input: SettleRelayChargeInput = {
  sessionId: "s1", requesterUserId: "u1", requesterWallet: null, requesterTeamId: null, rail: "x402", reservedCents: 0,
  nodeId: "n1", bytesGateway: 12345n, bytesNode: null, bytesIn: 100, bytesOut: 12245, pricePerGbMusd: 500_000n,
  snapshot: { splitConfigId: 1, tierId: 2, nodeShareBps: 2500, holdDays: 14 }, destHost: "example.com", destPort: 443,
  usageTargetHost: "", prepaidGrossMusd: 4883n,
};

describe("relay-settle-retry-repo", () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it("round-trips the settle input through JSON (bigints preserved)", () => {
    const back = decodeSettleInput(JSON.parse(JSON.stringify(encodeSettleInput(input))));
    expect(back).toEqual({ ...input, snapshot: { ...input.snapshot, genesisBonusBps: 0, buyerTierId: null, buyerDiscountBps: 0, minPlatformMarginBps: 2500 } });
  });

  it("rejects malformed or polluted payloads without copying unknown keys", () => {
    const enc = JSON.parse(JSON.stringify(encodeSettleInput(input)));
    expect(() => decodeSettleInput({ ...enc, rail: "evil" })).toThrow();
    expect(() => decodeSettleInput({ ...enc, bytesGateway: "-1" })).toThrow();
    const polluted = JSON.parse(JSON.stringify(enc).replace("{", '{"__proto__":{"x":1},'));
    const d = decodeSettleInput(polluted) as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(d, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });

  it("enqueue is idempotent on session_id", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await enqueueSettleRetry(input, "boom");
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT \(session_id\) DO NOTHING/);
    expect(params[0]).toBe("s1");
    expect(params[2]).toBe("12345");
  });

  it("lists due rows and dead-letters unreadable payloads", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [
        { session_id: "s1", attempts: 1, payload: encodeSettleInput(input) },
        { session_id: "bad", attempts: 0, payload: { nope: 1 } },
      ] })
      .mockResolvedValueOnce({ rows: [] });
    const rows = await listDueSettleRetries(5000);
    expect(rows).toHaveLength(1);
    expect(mockQuery.mock.calls[0][1]).toEqual([1000]);
    expect(mockQuery.mock.calls[1][0]).toMatch(/status = 'dead'/);
  });

  it("markSettleRetryFailed reports dead-lettering", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: "dead" }] });
    expect(await markSettleRetryFailed("s1", "x", 20)).toBe(true);
    expect(mockQuery.mock.calls[0][0]).toMatch(/power\(2/);
  });
});
