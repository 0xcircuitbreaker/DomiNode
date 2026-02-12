import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import {
  createSession,
  endSession,
  createUsageRecord,
  getUsageByUser,
  getUsageByDay,
  getUsageSummary,
  getActiveSessions,
  getTopHosts,
  cleanupOrphanedSessions,
} from "./usage-repo.js";

describe("usage-repo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── createSession ─────────────────────────────────────────────────

  describe("createSession", () => {
    it("should create a session and return it", async () => {
      const session = { id: "s1", user_id: "u1", proxy_ip: "1.2.3.4", status: "active" };
      mockQuery.mockResolvedValueOnce({ rows: [session] });

      const result = await createSession("u1", "1.2.3.4");
      expect(result).toEqual(session);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO sessions"),
        ["u1", "1.2.3.4"],
      );
    });

    it("should use empty string as default proxy_ip", async () => {
      const session = { id: "s2", user_id: "u2", proxy_ip: "", status: "active" };
      mockQuery.mockResolvedValueOnce({ rows: [session] });

      const result = await createSession("u2");
      expect(result).toEqual(session);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO sessions"),
        ["u2", ""],
      );
    });

    it("should include RETURNING * clause", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "s3" }] });

      await createSession("u3", "10.0.0.1");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("RETURNING *"),
        expect.any(Array),
      );
    });

    it("should pass user_id and proxy_ip parameters", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "s4" }] });

      await createSession("user-abc", "192.168.1.1");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ["user-abc", "192.168.1.1"],
      );
    });
  });

  // ─── endSession ────────────────────────────────────────────────────

  describe("endSession", () => {
    it("should update session with bytes, status, and ended_at", async () => {
      mockQuery.mockResolvedValueOnce({});

      await endSession("s1", 1000, "completed");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE sessions"),
        [1000, "completed", "s1"],
      );
    });

    it("should accept error status", async () => {
      mockQuery.mockResolvedValueOnce({});

      await endSession("s2", 500, "error");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        [500, "error", "s2"],
      );
    });

    it("should set ended_at to now()", async () => {
      mockQuery.mockResolvedValueOnce({});

      await endSession("s3", 0, "completed");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("ended_at = now()"),
        expect.any(Array),
      );
    });

    it("should accept zero bytes", async () => {
      mockQuery.mockResolvedValueOnce({});

      await endSession("s4", 0, "completed");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        [0, "completed", "s4"],
      );
    });

    it("should accept large byte counts", async () => {
      mockQuery.mockResolvedValueOnce({});

      await endSession("s5", 10_000_000_000, "completed");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        [10_000_000_000, "completed", "s5"],
      );
    });
  });

  // ─── createUsageRecord ────────────────────────────────────────────

  describe("createUsageRecord", () => {
    it("should create a usage record and return it", async () => {
      const record = {
        id: "ur1",
        user_id: "u1",
        session_id: "s1",
        bytes_in: 1000,
        bytes_out: 2000,
        cost_cents: 5,
        proxy_type: "residential",
        target_host: "example.com",
      };
      mockQuery.mockResolvedValueOnce({ rows: [record] });

      const result = await createUsageRecord({
        user_id: "u1",
        session_id: "s1",
        bytes_in: 1000,
        bytes_out: 2000,
        cost_cents: 5,
        proxy_type: "residential",
        target_host: "example.com",
      });
      expect(result).toEqual(record);
    });

    it("should pass all parameters correctly", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "ur2" }] });

      await createUsageRecord({
        user_id: "u2",
        session_id: "s2",
        bytes_in: 500,
        bytes_out: 1500,
        cost_cents: 3,
        proxy_type: "datacenter",
        target_host: "api.example.org",
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO usage_records"),
        ["u2", "s2", 500, 1500, 3, "datacenter", "api.example.org", null],
      );
    });

    it("should include RETURNING * clause", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "ur3" }] });

      await createUsageRecord({
        user_id: "u3",
        session_id: "s3",
        bytes_in: 0,
        bytes_out: 0,
        cost_cents: 0,
        proxy_type: "residential",
        target_host: "test.io",
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("RETURNING *"),
        expect.any(Array),
      );
    });

    it("should handle zero byte values", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "ur4" }] });

      await createUsageRecord({
        user_id: "u4",
        session_id: "s4",
        bytes_in: 0,
        bytes_out: 0,
        cost_cents: 0,
        proxy_type: "residential",
        target_host: "empty.com",
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ["u4", "s4", 0, 0, 0, "residential", "empty.com", null],
      );
    });
  });

  // ─── getUsageByUser ────────────────────────────────────────────────

  describe("getUsageByUser", () => {
    it("should return rows and total count", async () => {
      const usageRows = [
        { id: "ur1", bytes_in: 100, bytes_out: 200 },
        { id: "ur2", bytes_in: 300, bytes_out: 400 },
      ];
      mockQuery
        .mockResolvedValueOnce({ rows: usageRows }) // data query
        .mockResolvedValueOnce({ rows: [{ count: "2" }] }); // count query

      const since = new Date("2025-01-01");
      const until = new Date("2025-12-31");

      const result = await getUsageByUser("u1", since, until);
      expect(result.rows).toEqual(usageRows);
      expect(result.total).toBe(2);
    });

    it("should use default limit 200 and offset 0", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const since = new Date("2025-01-01");
      const until = new Date("2025-12-31");

      await getUsageByUser("u1", since, until);

      // The first call is the data query
      expect(mockQuery.mock.calls[0][1]).toEqual(["u1", since, until, 200, 0]);
    });

    it("should accept custom limit and offset", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const since = new Date("2025-01-01");
      const until = new Date("2025-12-31");

      await getUsageByUser("u1", since, until, 50, 10);

      expect(mockQuery.mock.calls[0][1]).toEqual(["u1", since, until, 50, 10]);
    });

    it("should return empty rows and zero total when no records", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const since = new Date("2025-01-01");
      const until = new Date("2025-01-02");

      const result = await getUsageByUser("u-empty", since, until);
      expect(result.rows).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("should order by created_at DESC", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      await getUsageByUser("u1", new Date(), new Date());

      expect(mockQuery.mock.calls[0][0]).toContain("ORDER BY created_at DESC");
    });

    it("should handle large total counts", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: "ur1" }] })
        .mockResolvedValueOnce({ rows: [{ count: "99999" }] });

      const result = await getUsageByUser("u1", new Date(), new Date());
      expect(result.total).toBe(99999);
    });
  });

  // ─── getUsageByDay ─────────────────────────────────────────────────

  describe("getUsageByDay", () => {
    it("should return daily usage aggregation", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { date: "2025-01-01", total_bytes: "1000", total_cost_cents: "5", request_count: "3" },
          { date: "2025-01-02", total_bytes: "2000", total_cost_cents: "10", request_count: "5" },
        ],
      });

      const result = await getUsageByDay("u1", new Date("2025-01-01"), new Date("2025-01-02"));
      expect(result).toEqual([
        { date: "2025-01-01", total_bytes: 1000, total_cost_cents: 5, request_count: 3 },
        { date: "2025-01-02", total_bytes: 2000, total_cost_cents: 10, request_count: 5 },
      ]);
    });

    it("should convert string values to numbers", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { date: "2025-06-15", total_bytes: "999999", total_cost_cents: "500", request_count: "42" },
        ],
      });

      const result = await getUsageByDay("u1", new Date(), new Date());
      expect(typeof result[0].total_bytes).toBe("number");
      expect(typeof result[0].total_cost_cents).toBe("number");
      expect(typeof result[0].request_count).toBe("number");
    });

    it("should return empty array when no usage", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await getUsageByDay("u-no-usage", new Date(), new Date());
      expect(result).toEqual([]);
    });

    it("should group by DATE(created_at)", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getUsageByDay("u1", new Date(), new Date());
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("GROUP BY DATE(created_at)"),
        expect.any(Array),
      );
    });

    it("should order by date ASC", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getUsageByDay("u1", new Date(), new Date());
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY date ASC"),
        expect.any(Array),
      );
    });

    it("should pass userId, since, and until parameters", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const since = new Date("2025-03-01");
      const until = new Date("2025-03-31");

      await getUsageByDay("user-x", since, until);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ["user-x", since, until],
      );
    });

    it("should handle zero values in aggregation", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { date: "2025-01-01", total_bytes: "0", total_cost_cents: "0", request_count: "0" },
        ],
      });

      const result = await getUsageByDay("u1", new Date(), new Date());
      expect(result[0]).toEqual({
        date: "2025-01-01",
        total_bytes: 0,
        total_cost_cents: 0,
        request_count: 0,
      });
    });
  });

  // ─── getUsageSummary ───────────────────────────────────────────────

  describe("getUsageSummary", () => {
    it("should return summary statistics", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { total_bytes: "50000", total_cost_cents: "250", request_count: "15" },
        ],
      });

      const result = await getUsageSummary("u1", new Date("2025-01-01"));
      expect(result).toEqual({
        total_bytes: 50000,
        total_cost_cents: 250,
        request_count: 15,
      });
    });

    it("should convert string values to numbers", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { total_bytes: "123456789", total_cost_cents: "5000", request_count: "100" },
        ],
      });

      const result = await getUsageSummary("u1", new Date());
      expect(typeof result.total_bytes).toBe("number");
      expect(typeof result.total_cost_cents).toBe("number");
      expect(typeof result.request_count).toBe("number");
    });

    it("should return zeros when no usage", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { total_bytes: "0", total_cost_cents: "0", request_count: "0" },
        ],
      });

      const result = await getUsageSummary("u-no-usage", new Date());
      expect(result).toEqual({
        total_bytes: 0,
        total_cost_cents: 0,
        request_count: 0,
      });
    });

    it("should pass userId and since parameters", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ total_bytes: "0", total_cost_cents: "0", request_count: "0" }],
      });

      const since = new Date("2025-06-01");
      await getUsageSummary("user-y", since);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ["user-y", since],
      );
    });

    it("should use COALESCE for null-safe aggregation", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ total_bytes: "0", total_cost_cents: "0", request_count: "0" }],
      });

      await getUsageSummary("u1", new Date());
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("COALESCE"),
        expect.any(Array),
      );
    });

    it("should filter by created_at >= since", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ total_bytes: "0", total_cost_cents: "0", request_count: "0" }],
      });

      await getUsageSummary("u1", new Date());
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("created_at >= $2"),
        expect.any(Array),
      );
    });
  });


  // --- getActiveSessions ---

  describe("getActiveSessions", () => {
    it("should return active sessions for a user", async () => {
      const rows = [
        { id: "s1", started_at: new Date("2025-06-01"), proxy_ip: "1.2.3.4", status: "active" },
        { id: "s2", started_at: new Date("2025-06-02"), proxy_ip: "5.6.7.8", status: "active" },
      ];
      mockQuery.mockResolvedValueOnce({ rows });

      const result = await getActiveSessions("u1");
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("s1");
      expect(result[0].proxyIp).toBe("1.2.3.4");
      expect(result[0].status).toBe("active");
      expect(result[0].startedAt).toEqual(new Date("2025-06-01"));
    });

    it("should return empty array when no active sessions", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await getActiveSessions("u-no-sessions");
      expect(result).toEqual([]);
    });

    it("should filter by user_id and active status", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getActiveSessions("user-abc");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("WHERE user_id = "),
        ["user-abc"],
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'active'"),
        expect.any(Array),
      );
    });

    it("should order by started_at DESC", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getActiveSessions("u1");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY started_at DESC"),
        expect.any(Array),
      );
    });

    it("should limit to 50 results", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getActiveSessions("u1");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT 50"),
        expect.any(Array),
      );
    });

    it("should map row fields correctly", async () => {
      const now = new Date();
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: "sess-map", started_at: now, proxy_ip: "9.9.9.9", status: "active" }],
      });

      const result = await getActiveSessions("u1");
      expect(result[0]).toEqual({
        id: "sess-map",
        startedAt: now,
        proxyIp: "9.9.9.9",
        status: "active",
      });
    });
  });

  // --- getTopHosts ---

  describe("getTopHosts", () => {
    it("should return top hosts by bandwidth", async () => {
      const rows = [
        { target_host: "example.com", total_bytes: "5000000", request_count: "100" },
        { target_host: "api.test.io", total_bytes: "3000000", request_count: "50" },
      ];
      mockQuery.mockResolvedValueOnce({ rows });

      const result = await getTopHosts("u1", new Date("2025-01-01"), new Date("2025-12-31"));
      expect(result).toHaveLength(2);
      expect(result[0].targetHost).toBe("example.com");
      expect(result[0].totalBytes).toBe(5000000);
      expect(result[0].requestCount).toBe(100);
    });

    it("should return empty array when no usage", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await getTopHosts("u-empty", new Date(), new Date());
      expect(result).toEqual([]);
    });

    it("should pass all parameters including default limit", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const since = new Date("2025-01-01");
      const until = new Date("2025-12-31");
      await getTopHosts("u1", since, until);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ["u1", since, until, 10],
      );
    });

    it("should accept custom limit", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const since = new Date("2025-01-01");
      const until = new Date("2025-12-31");
      await getTopHosts("u1", since, until, 5);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ["u1", since, until, 5],
      );
    });

    it("should order by total_bytes DESC", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getTopHosts("u1", new Date(), new Date());
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY total_bytes DESC"),
        expect.any(Array),
      );
    });

    it("should group by target_host", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getTopHosts("u1", new Date(), new Date());
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("GROUP BY target_host"),
        expect.any(Array),
      );
    });

    it("should convert string values to numbers", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ target_host: "test.com", total_bytes: "999999", request_count: "42" }],
      });

      const result = await getTopHosts("u1", new Date(), new Date());
      expect(typeof result[0].totalBytes).toBe("number");
      expect(typeof result[0].requestCount).toBe("number");
    });
  });

  // ─── cleanupOrphanedSessions ────────────────────────────────────────

  describe("cleanupOrphanedSessions", () => {
    it("should mark active sessions as error", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 3 });

      const count = await cleanupOrphanedSessions();
      expect(count).toBe(3);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE sessions"),
      );
    });

    it("should update status to error and set ended_at", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      await cleanupOrphanedSessions();
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain("status = 'error'");
      expect(sql).toContain("ended_at = now()");
      expect(sql).toContain("WHERE status = 'active'");
    });

    it("should return 0 when no orphaned sessions", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const count = await cleanupOrphanedSessions();
      expect(count).toBe(0);
    });

    it("should handle null rowCount gracefully", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: null });

      const count = await cleanupOrphanedSessions();
      expect(count).toBe(0);
    });
  });

});
