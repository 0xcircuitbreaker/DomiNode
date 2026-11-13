import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("../db.js", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
import { attachRecoveryPayload, heartbeatSessions, listRecoverableSessions, closeLegacyOrphans } from "./session-recovery-repo.js";
import { encodeSettleInput } from "./relay-settle-retry-repo.js";
import type { SettleRelayChargeInput } from "./relay-charge-repo.js";

const input: SettleRelayChargeInput = {
  sessionId: "11111111-1111-1111-1111-111111111111", requesterUserId: "u1", requesterWallet: null, requesterTeamId: null,
  rail: "wallet", reservedCents: 50, nodeId: "n1", bytesGateway: 999n, bytesNode: 5n, bytesIn: 500, bytesOut: 499,
  pricePerGbMusd: 500_000n, snapshot: { splitConfigId: 1, tierId: 2, nodeShareBps: 2500, holdDays: 14 },
  destHost: "example.com", destPort: 443, usageTargetHost: "",
};

describe("session-recovery-repo", () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it("stores the payload with zeroed bytes and the owning instance", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await attachRecoveryPayload("gw-a:1:ab", input);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("gateway_instance = $2");
    expect(sql).toContain("status = 'active'");
    const p = JSON.parse(params[2] as string);
    expect(p.reservedCents).toBe(50);
    expect(p.bytesGateway).toBe("0");
    expect(p.bytesNode).toBeNull();
  });

  it("throws when the row was not updated (caller fails the session)", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    await expect(attachRecoveryPayload("gw-a", input)).rejects.toThrow();
    await expect(attachRecoveryPayload("bad id;", input)).rejects.toThrow("invalid instance id");
  });

  it("heartbeats only this instance's active rows", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await heartbeatSessions("gw-a", [{ sessionId: input.sessionId, bytesIn: 10, bytesOut: -5 }]);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("s.gateway_instance = $1");
    expect(params).toEqual(["gw-a", [input.sessionId], ["10"], ["0"]]);
    expect(await heartbeatSessions("gw-a", [])).toBe(0);
  });

  it("lists only stale sessions of other instances without a pending retry, with flushed bytes", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { id: input.sessionId, settle_payload: JSON.parse(JSON.stringify(encodeSettleInput({ ...input, bytesGateway: 0n, bytesIn: 0, bytesOut: 0 }))), flushed_bytes_in: "300", flushed_bytes_out: "700" },
      { id: "22222222-2222-2222-2222-222222222222", settle_payload: { junk: true }, flushed_bytes_in: "0", flushed_bytes_out: "0" },
    ] });
    const rows = await listRecoverableSessions("gw-self", 120);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("gateway_instance IS DISTINCT FROM $1");
    expect(sql).toContain("relay_settle_retries");
    expect(params[0]).toBe("gw-self");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.input.bytesGateway).toBe(1000n);
    expect(rows[0]!.input.bytesIn).toBe(300);
    expect(rows[0]!.input.reservedCents).toBe(50);
    expect(rows[0]!.input.sessionStatus).toBe("error");
  });

  it("legacy cleanup only touches payload-less rows that are old and not queued for retry", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 2 });
    expect(await closeLegacyOrphans(10)).toBe(2);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("settle_payload IS NULL");
    expect(sql).toContain("relay_settle_retries");
    expect(params).toEqual([300]);
  });
});
