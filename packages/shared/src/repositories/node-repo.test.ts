import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockConnect = vi.fn();

vi.mock("../db.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: () => ({ connect: () => mockConnect() }),
}));

import {
  createChallenge, consumeChallenge, registerNode, getNodeForTunnelAuth,
  markOnline, markOffline, flushHealth, setStatus, listForOwner, listAdmin,
  hashNodeKey, FLUSH_HEALTH_LIMIT, NODE_PENALTY_WINDOW_DAYS, revokeOwnedNode, getOwnerPrefixProbeClasses,
} from "./node-repo.js";

const U = "11111111-1111-1111-1111-111111111111";
const N = "22222222-2222-2222-2222-222222222222";
const H = "a".repeat(64);
const W = "0x" + "b".repeat(40);
const SIG = "0x" + "c".repeat(130);

function sqlCalls(): string[] {
  return mockClientQuery.mock.calls.map((c) => String(c[0]));
}

describe("node-repo", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    mockConnect.mockReset();
    mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
  });

  describe("createChallenge", () => {
    it("locks the user, purges expired and inserts", async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: U }] })
        .mockResolvedValueOnce({}) // delete expired
        .mockResolvedValueOnce({ rows: [{ count: "0" }] })
        .mockResolvedValueOnce({ rows: [{ nonce_hash: H, user_id: U, expires_at: new Date() }] })
        .mockResolvedValueOnce({}); // COMMIT
      const r = await createChallenge(U, H);
      expect(r?.nonce_hash).toBe(H);
      const s = sqlCalls();
      expect(s[1]).toContain("FOR UPDATE");
      expect(s[1]).toContain("status = 'active'");
      expect(s[4]).toContain("RETURNING nonce_hash, user_id, expires_at");
      expect(s[5]).toBe("COMMIT");
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it("returns null when too many outstanding", async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: U }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ count: "10" }] })
        .mockResolvedValueOnce({});
      expect(await createChallenge(U, H)).toBeNull();
      expect(sqlCalls()).toContain("ROLLBACK");
    });

    it("rejects bad nonce hash", async () => {
      await expect(createChallenge(U, "xyz")).rejects.toThrow();
    });
  });

  describe("consumeChallenge", () => {
    it("uses atomic DELETE...RETURNING bound to user and expiry", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ nonce_hash: H, user_id: U }] });
      const r = await consumeChallenge(U, H);
      expect(r).not.toBeNull();
      const sql = String(mockQuery.mock.calls[0][0]);
      expect(sql).toMatch(/DELETE FROM node_challenges/);
      expect(sql).toContain("expires_at > now()");
      expect(sql).toContain("RETURNING nonce_hash");
      expect(mockQuery.mock.calls[0][1]).toEqual([H, U]);
    });
    it("returns null when not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await consumeChallenge(U, H)).toBeNull();
    });
  });

  describe("penalty carry-over (revoke + re-register)", () => {
    it("revokeOwnedNode records the status the node had", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: N, status: "revoked" }] });
      expect(await revokeOwnedNode(N, U)).toEqual({ id: N, status: "revoked" });
      const sql = String(mockQuery.mock.calls[0][0]);
      expect(sql).toContain("revoked_from_status = status");
      expect(sql).toContain("owner_user_id = $2");
      expect(mockQuery.mock.calls[0][1]).toEqual([N, U]);
    });

    it("getOwnerPrefixProbeClasses reads the owner's other nodes on the prefix, revoked included", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ probe_class: "masked" }, { probe_class: "bogus" }] });
      expect(await getOwnerPrefixProbeClasses(U, "73.1.2.0/24", N)).toEqual(["masked"]);
      const sql = String(mockQuery.mock.calls[0][0]);
      expect(sql).not.toContain("status <> 'revoked'");
      expect(sql).toContain("ip_prefix24 = $2::cidr");
      expect(await getOwnerPrefixProbeClasses(U, "not-a-prefix", N)).toEqual([]);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe("registerNode", () => {
    const input = { ownerUserId: U, ownerWallet: W.toUpperCase().replace("0X", "0x"), attestationVersion: 1, attestationSig: SIG };

    it("registers under tier cap and stores only the key hash", async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ status: "active", tier_name: "probation", max_nodes: 10 }] })
        .mockResolvedValueOnce({ rows: [{ count: "9" }] })
        .mockResolvedValueOnce({ rows: [{ n: "0" }] })
        .mockResolvedValueOnce({ rows: [{ id: N, status: "pending" }] })
        .mockResolvedValueOnce({});
      const r = await registerNode(input);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.nodeKey.startsWith("dn_node_")).toBe(true);
      const s = sqlCalls();
      expect(s[1]).toContain("FOR UPDATE OF u");
      expect(s[1]).toContain("node_tiers");
      expect(s[2]).toContain("status <> 'revoked'");
      expect(s[3]).toContain("revoked_from_status IN ('quarantined','suspended')");
      expect(s[4]).not.toContain("RETURNING *");
      expect(s[4]).not.toMatch(/RETURNING[\s\S]*node_key_hash/);
      const params = mockClientQuery.mock.calls[4][1] as unknown[];
      expect(params[1]).toBe(W);
      expect(params[2]).toBe(hashNodeKey(r.nodeKey));
      expect(params).not.toContain(r.nodeKey);
      expect(s[5]).toBe("COMMIT");
    });

    it("refuses while the owner has a quarantined/suspended node or revoked one in that state", async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ status: "active", tier_name: "probation", max_nodes: 10 }] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] })
        .mockResolvedValueOnce({ rows: [{ n: "1" }] })
        .mockResolvedValueOnce({});
      const r = await registerNode(input);
      expect(r).toEqual({ ok: false, reason: "owner_penalized" });
      const s = sqlCalls();
      expect(s[3]).toContain("status IN ('quarantined','suspended')");
      expect(mockClientQuery.mock.calls[3][1]).toEqual([U, NODE_PENALTY_WINDOW_DAYS]);
      expect(s[4]).toBe("ROLLBACK");
      expect(s.some((q) => q.includes("INSERT INTO nodes"))).toBe(false);
    });

    it.each([["probation", 10], ["bronze", 25], ["silver", 100], ["gold", 500], ["platinum", 2000], ["partner", 2000]])(
      "rejects at cap for %s (%i)", async (tier, cap) => {
        mockClientQuery
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ rows: [{ status: "active", tier_name: tier, max_nodes: cap }] })
          .mockResolvedValueOnce({ rows: [{ count: String(cap) }] })
          .mockResolvedValueOnce({});
        const r = await registerNode(input);
        expect(r).toEqual({ ok: false, reason: "node_cap_reached", cap });
        expect(sqlCalls()).toContain("ROLLBACK");
        expect(sqlCalls().some((q) => q.includes("INSERT INTO nodes"))).toBe(false);
      });

    it("fails closed when tier row missing", async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ status: "active", tier_name: null, max_nodes: null }] })
        .mockResolvedValueOnce({});
      expect(await registerNode(input)).toEqual({ ok: false, reason: "tier_not_found" });
    });

    it("rejects inactive owner", async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ status: "suspended", tier_name: "gold", max_nodes: 500 }] })
        .mockResolvedValueOnce({});
      expect(await registerNode(input)).toEqual({ ok: false, reason: "owner_inactive" });
    });

    it("rolls back and releases on error", async () => {
      mockClientQuery.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("db")).mockResolvedValueOnce({});
      await expect(registerNode(input)).rejects.toThrow("db");
      expect(sqlCalls()).toContain("ROLLBACK");
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it("validates inputs", async () => {
      await expect(registerNode({ ...input, ownerWallet: "nope" })).rejects.toThrow();
      await expect(registerNode({ ...input, attestationSig: "short" })).rejects.toThrow();
      await expect(registerNode({ ...input, attestationVersion: NaN })).rejects.toThrow();
    });
  });

  describe("getNodeForTunnelAuth", () => {
    it("requires active owner and excludes revoked", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: N }] });
      expect(await getNodeForTunnelAuth(H)).toEqual({ id: N });
      const sql = String(mockQuery.mock.calls[0][0]);
      expect(sql).toContain("u.status = 'active'");
      expect(sql).toContain("n.status <> 'revoked'");
      expect(sql).not.toContain("SELECT *");
    });
    it("returns null for malformed hash without querying", async () => {
      expect(await getNodeForTunnelAuth("dn_node_abc")).toBeNull();
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe("markOnline / markOffline", () => {
    it("updates ip, prefix and geo", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      expect(await markOnline(N, "203.0.113.5", "us", 64500, "residential")).toBe(true);
      expect(mockQuery.mock.calls[0][1]).toEqual([N, "203.0.113.5", "US", 64500, "residential"]);
      expect(String(mockQuery.mock.calls[0][0])).toContain("set_masklen");
    });
    it("rejects bad country", async () => {
      await expect(markOnline(N, "1.2.3.4", "USA", null)).rejects.toThrow();
    });
    it("markOffline updates last_seen_at", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });
      expect(await markOffline(N)).toBe(false);
      expect(String(mockQuery.mock.calls[0][0])).toContain("status <> 'revoked'");
    });
  });

  describe("flushHealth", () => {
    it("caps at LIMIT 1000 in one transaction", async () => {
      mockClientQuery.mockResolvedValue({});
      const batch = Array.from({ length: 1500 }, (_, i) => ({
        nodeId: `22222222-2222-2222-2222-${i.toString(16).padStart(12, "0")}`, bytes: 1, reputation: 3000,
      }));
      expect(await flushHealth(batch)).toBe(FLUSH_HEALTH_LIMIT);
      const s = sqlCalls();
      expect(s[0]).toBe("BEGIN");
      expect(s.at(-1)).toBe("COMMIT");
      expect((mockClientQuery.mock.calls[1][1] as unknown[][])[0]).toHaveLength(1000);
    });
    it("merges duplicate nodeIds with capped sums and caps INSERT aggregates", async () => {
      mockClientQuery.mockResolvedValue({});
      const M = "33333333-3333-3333-3333-333333333333";
      await flushHealth([
        { nodeId: N, streams: 1_500_000_000, bytes: 900_000_000_000_000 },
        { nodeId: M, streams: 5 },
        { nodeId: N, streams: 1_500_000_000, bytes: 900_000_000_000_000, failures: 2 },
      ]);
      const [sql, params] = mockClientQuery.mock.calls[1] as [string, unknown[][]];
      expect(params[0]).toEqual([N, M]);
      expect(params[1]).toEqual([1_000_000_000_000_000, 0]);
      expect(params[2]).toEqual([2_000_000_000, 5]);
      expect(params[3]).toEqual([2, 0]);
      expect(sql).toContain("LEAST(SUM(v.streams), 2000000000)");
      expect(sql).toContain("LEAST(SUM(v.bytes), 1000000000000000)");
    });
    it("dedupes reputation (last wins) and skips revoked nodes", async () => {
      mockClientQuery.mockResolvedValue({});
      const M = "33333333-3333-3333-3333-333333333333";
      await flushHealth([
        { nodeId: N, reputation: 100 },
        { nodeId: M, reputation: 50 },
        { nodeId: N, reputation: 900 },
      ]);
      const [sql, params] = mockClientQuery.mock.calls[2] as [string, unknown[][]];
      expect(sql).toContain("n.status <> 'revoked'");
      expect(params[0]).toEqual([M, N]);
      expect(params[1]).toEqual([50, 900]);
    });
    it("no-op on empty batch", async () => {
      expect(await flushHealth([])).toBe(0);
      expect(mockConnect).not.toHaveBeenCalled();
    });
    it("rejects negative counters", async () => {
      await expect(flushHealth([{ nodeId: N, bytes: -1 }])).rejects.toThrow();
    });
  });

  describe("setStatus / lists", () => {
    it("setStatus never resurrects revoked", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: N, status: "active" }] });
      await setStatus(N, "active", ["pending"]);
      expect(String(mockQuery.mock.calls[0][0])).toContain("status <> 'revoked'");
      expect(mockQuery.mock.calls[0][1]).toEqual([N, "active", ["pending"]]);
    });
    it("setStatus rejects unknown status", async () => {
      await expect(setStatus(N, "bogus" as never)).rejects.toThrow();
    });
    it("listForOwner clamps limit", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await listForOwner(U, { limit: 99999, offset: -5 });
      expect(mockQuery.mock.calls[0][1]).toEqual([U, 2000, 0, null, null]);
      expect(String(mockQuery.mock.calls[0][0])).not.toContain("node_key_hash");
    });
    it("listForOwner keyset cursor ignores offset", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const at = new Date("2026-01-02T03:04:05.678Z");
      await listForOwner(U, { limit: 10, offset: 50, cursor: { createdAt: at, id: N } });
      expect(mockQuery.mock.calls[0][1]).toEqual([U, 10, 0, at, N]);
      expect(String(mockQuery.mock.calls[0][0])).toContain("< ($4::timestamptz, $5::uuid)");
    });
    it("listAdmin filters and totals", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: N }] }).mockResolvedValueOnce({ rows: [{ count: "1" }] });
      const r = await listAdmin({ status: "active", country: "de", limit: 10 });
      expect(r).toEqual({ nodes: [{ id: N }], total: 1 });
      expect(mockQuery.mock.calls[0][1]).toEqual(["active", "DE", null, 10, 0]);
    });
  });
});
