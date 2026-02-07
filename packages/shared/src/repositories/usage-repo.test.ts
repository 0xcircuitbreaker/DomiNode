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
        ["u2", "s2", 500, 1500, 3, "datacenter", "api.example.org"],
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
        ["u4", "s4", 0, 0, 0, "residential", "empty.com"],
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
});
