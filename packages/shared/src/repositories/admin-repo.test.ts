import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import {
  listUsers, getUserDetails, suspendUser, reactivateUser,
  deleteUser, getRevenueStats, getDailyRevenue, getSystemStats,
} from "./admin-repo.js";

describe("admin-repo", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe("listUsers", () => {
    it("should return paginated users with total", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: "u1", email: "a@b.com", status: "active", plan_id: "payg", balance_cents: "1000", created_at: new Date(), is_admin: false }] })
        .mockResolvedValueOnce({ rows: [{ count: "42" }] });
      const r = await listUsers(1, 20);
      expect(r.users).toHaveLength(1);
      expect(r.total).toBe(42);
      expect(r.users[0].balanceCents).toBe(1000);
    });

    it("should calculate correct offset", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: "0" }] });
      await listUsers(3, 10);
      expect(mockQuery.mock.calls[0][1]).toEqual([10, 20]);
    });

    it("should return empty when no users", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: "0" }] });
      const r = await listUsers(1, 20);
      expect(r.users).toEqual([]);
      expect(r.total).toBe(0);
    });

    it("should default planId to payg", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "u1", email: "x", status: "active", plan_id: null, balance_cents: "0", created_at: new Date(), is_admin: false }] }).mockResolvedValueOnce({ rows: [{ count: "1" }] });
      const r = await listUsers(1, 20);
      expect(r.users[0].planId).toBe("payg");
    });

    it("should handle null balance_cents", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "u1", email: "x", status: "active", plan_id: "payg", balance_cents: null, created_at: new Date(), is_admin: false }] }).mockResolvedValueOnce({ rows: [{ count: "1" }] });
      const r = await listUsers(1, 20);
      expect(r.users[0].balanceCents).toBe(0);
    });
  });

  describe("getUserDetails", () => {
    it("should return detailed info", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "u1", email: "d@t.com", status: "active", plan_id: "payg", balance_cents: "5000", created_at: new Date(), is_admin: false, api_key_count: "3", total_usage_bytes: "1000000", total_spent_cents: "500", last_active: new Date("2025-06-15") }] });
      const r = await getUserDetails("u1");
      expect(r).not.toBeNull();
      expect(r!.apiKeyCount).toBe(3);
      expect(r!.totalUsageBytes).toBe(1000000);
      expect(r!.totalSpentCents).toBe(500);
    });

    it("should return null when not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await getUserDetails("missing")).toBeNull();
    });

    it("should pass userId", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await getUserDetails("abc");
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("WHERE u.id = "), ["abc"]);
    });

    it("should handle null values", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: "u2", email: "x", status: "active", plan_id: null, balance_cents: null, created_at: new Date(), is_admin: null, api_key_count: "0", total_usage_bytes: "0", total_spent_cents: "0", last_active: null }] });
      const r = await getUserDetails("u2");
      expect(r!.balanceCents).toBe(0);
      expect(r!.planId).toBe("payg");
      expect(r!.isAdmin).toBe(false);
      expect(r!.lastActive).toBeNull();
    });
  });

  describe("suspendUser", () => {
    it("should set status to suspended", async () => {
      mockQuery.mockResolvedValueOnce({});
      await suspendUser("u1");
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("SET status = 'suspended'"), ["u1"]);
    });
    it("should only suspend active users", async () => {
      mockQuery.mockResolvedValueOnce({});
      await suspendUser("u1");
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'active'"), expect.any(Array));
    });
  });

  describe("reactivateUser", () => {
    it("should set status to active", async () => {
      mockQuery.mockResolvedValueOnce({});
      await reactivateUser("u1");
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("SET status = 'active'"), ["u1"]);
    });
    it("should only reactivate suspended users", async () => {
      mockQuery.mockResolvedValueOnce({});
      await reactivateUser("u1");
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'suspended'"), expect.any(Array));
    });
  });

  describe("deleteUser", () => {
    it("should soft-delete", async () => {
      mockQuery.mockResolvedValueOnce({});
      await deleteUser("u1");
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("SET status = 'deleted'"), ["u1"]);
    });
  });

  describe("getRevenueStats", () => {
    it("should return aggregated data", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total_revenue_cents: "50000", total_transactions: "100", avg_transaction_cents: "500", topup_count: "80", unique_paying_users: "25" }] });
      const r = await getRevenueStats(new Date(), new Date());
      expect(r.totalRevenueCents).toBe(50000);
      expect(r.totalTransactions).toBe(100);
      expect(r.topUpCount).toBe(80);
      expect(r.uniquePayingUsers).toBe(25);
    });
    it("should pass date params", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total_revenue_cents: "0", total_transactions: "0", avg_transaction_cents: "0", topup_count: "0", unique_paying_users: "0" }] });
      const s = new Date("2025-03-01"); const u = new Date("2025-03-31");
      await getRevenueStats(s, u);
      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [s, u]);
    });
    it("should round avg", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total_revenue_cents: "1000", total_transactions: "3", avg_transaction_cents: "333.333", topup_count: "3", unique_paying_users: "2" }] });
      const r = await getRevenueStats(new Date(), new Date());
      expect(r.avgTransactionCents).toBe(333);
    });
  });

  describe("getDailyRevenue", () => {
    it("should return daily breakdown", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ date: "2025-01-01", revenue_cents: "1000", transaction_count: "5" }] });
      const r = await getDailyRevenue(new Date(), new Date());
      expect(r).toHaveLength(1);
      expect(r[0].revenueCents).toBe(1000);
      expect(r[0].transactionCount).toBe(5);
    });
    it("should return empty when no revenue", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await getDailyRevenue(new Date(), new Date())).toEqual([]);
    });
    it("should order by date ASC", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await getDailyRevenue(new Date(), new Date());
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("ORDER BY date ASC"), expect.any(Array));
    });
  });

  describe("getSystemStats", () => {
    it("should return system counts", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total_users: "100", active_users: "80", suspended_users: "5", total_api_keys: "200", active_api_keys: "150", total_sessions: "1000", active_sessions: "10" }] });
      const r = await getSystemStats();
      expect(r.totalUsers).toBe(100);
      expect(r.activeUsers).toBe(80);
      expect(r.suspendedUsers).toBe(5);
      expect(r.totalApiKeys).toBe(200);
      expect(r.activeApiKeys).toBe(150);
      expect(r.totalSessions).toBe(1000);
      expect(r.activeSessions).toBe(10);
    });
    it("should convert strings to numbers", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total_users: "0", active_users: "0", suspended_users: "0", total_api_keys: "0", active_api_keys: "0", total_sessions: "0", active_sessions: "0" }] });
      const r = await getSystemStats();
      expect(typeof r.totalUsers).toBe("number");
      expect(typeof r.activeUsers).toBe("number");
    });
  });
});