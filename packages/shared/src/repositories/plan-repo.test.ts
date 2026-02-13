import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import {
  getPlan,
  getAllPlans,
  getUserPlan,
  setUserPlan,
  getMonthlyUsage,
} from "./plan-repo.js";

const defaultPlanRow = {
  id: "payg",
  name: "PAYG",
  price_per_gb_cents: 500,
  monthly_bandwidth_bytes: "0",
  is_default: true,
  max_connections: 100,
  max_sessions_per_minute: 30,
};

const proPlanRow = {
  id: "pro",
  name: "Pro",
  price_per_gb_cents: 300,
  monthly_bandwidth_bytes: "107374182400",
  is_default: false,
  max_connections: 100,
  max_sessions_per_minute: 60,
};

describe("plan-repo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getPlan", () => {
    it("should return a plan when found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [defaultPlanRow] });

      const result = await getPlan("payg");
      expect(result).toEqual({
        id: "payg",
        name: "PAYG",
        pricePerGbCents: 500,
        monthlyBandwidthBytes: 0,
        isDefault: true,
        maxConnections: 100,
        maxSessionsPerMinute: 30,
      });
    });

    it("should return null when plan not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await getPlan("nonexistent");
      expect(result).toBeNull();
    });

    it("should query by plan ID", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getPlan("plan-xyz");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("WHERE id = $1"),
        ["plan-xyz"],
      );
    });

    it("should convert monthly_bandwidth_bytes from string to number", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [proPlanRow] });

      const result = await getPlan("pro");
      expect(result!.monthlyBandwidthBytes).toBe(107374182400);
      expect(typeof result!.monthlyBandwidthBytes).toBe("number");
    });
  });

  describe("getAllPlans", () => {
    it("should return all plans", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [defaultPlanRow, proPlanRow] });

      const result = await getAllPlans();
      expect(result.length).toBe(2);
      expect(result[0].id).toBe("payg");
      expect(result[1].id).toBe("pro");
    });

    it("should return empty array when no plans exist", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await getAllPlans();
      expect(result).toEqual([]);
    });

    it("should order by price_per_gb_cents DESC", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getAllPlans();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY price_per_gb_cents DESC"),
      );
    });

    it("should map all rows through rowToPlan", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [defaultPlanRow, proPlanRow] });

      const result = await getAllPlans();
      for (const plan of result) {
        expect(plan).toHaveProperty("id");
        expect(plan).toHaveProperty("name");
        expect(plan).toHaveProperty("pricePerGbCents");
        expect(plan).toHaveProperty("monthlyBandwidthBytes");
        expect(plan).toHaveProperty("isDefault");
        expect(plan).toHaveProperty("maxConnections");
        expect(plan).toHaveProperty("maxSessionsPerMinute");
      }
    });

    it("should map maxSessionsPerMinute from row", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [proPlanRow] });

      const result = await getAllPlans();
      expect(result[0].maxSessionsPerMinute).toBe(60);
    });

    it("should default maxSessionsPerMinute to 30 when column is null", async () => {
      const rowWithoutColumn = { ...defaultPlanRow, max_sessions_per_minute: undefined as any };
      mockQuery.mockResolvedValueOnce({ rows: [rowWithoutColumn] });

      const result = await getAllPlans();
      expect(result[0].maxSessionsPerMinute).toBe(30);
    });
  });

  describe("getUserPlan", () => {
    it("should return user's assigned plan", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [proPlanRow] });

      const result = await getUserPlan("user-1");
      expect(result).toEqual({
        id: "pro",
        name: "Pro",
        pricePerGbCents: 300,
        monthlyBandwidthBytes: 107374182400,
        isDefault: false,
        maxConnections: 100,
        maxSessionsPerMinute: 60,
      });
    });

    it("should throw when user plan not found (R17: no silent fallback to free tier)", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // user plan lookup returns nothing

      await expect(getUserPlan("user-no-plan")).rejects.toThrow(
        "No plan found for user user-no-plan",
      );
    });

    it("should query by user ID with JOIN", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [defaultPlanRow] });

      await getUserPlan("user-abc");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("JOIN users u ON u.plan_id = p.id"),
        ["user-abc"],
      );
    });

    it("should only query once (no fallback query)", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(getUserPlan("user-fallback")).rejects.toThrow();
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe("setUserPlan", () => {
    it("should update user's plan", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [proPlanRow] }) // plan exists
        .mockResolvedValueOnce({ rowCount: 1 }); // update succeeds

      await setUserPlan("user-1", "pro");
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it("should throw when plan not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // plan doesn't exist

      await expect(setUserPlan("user-1", "nonexistent")).rejects.toThrow(
        "Plan 'nonexistent' not found",
      );
    });

    it("should throw when user not found", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [proPlanRow] }) // plan exists
        .mockResolvedValueOnce({ rowCount: 0 }); // no user updated

      await expect(setUserPlan("user-missing", "pro")).rejects.toThrow(
        "User 'user-missing' not found",
      );
    });

    it("should verify plan exists before updating user", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [defaultPlanRow] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await setUserPlan("user-1", "payg");
      // First call should be SELECT plan
      expect(mockQuery.mock.calls[0][0]).toContain("SELECT * FROM plans WHERE id = $1");
      expect(mockQuery.mock.calls[0][1]).toEqual(["payg"]);
    });

    it("should handle null rowCount as 0", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [proPlanRow] }) // plan exists
        .mockResolvedValueOnce({ rowCount: null }); // null rowCount

      await expect(setUserPlan("user-null", "pro")).rejects.toThrow(
        "User 'user-null' not found",
      );
    });
  });

  describe("getMonthlyUsage", () => {
    it("should return total bytes used this month", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total_bytes: "5000000" }] });

      const result = await getMonthlyUsage("user-1");
      expect(result).toBe(5000000);
    });

    it("should return 0 when no usage", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total_bytes: "0" }] });

      const result = await getMonthlyUsage("user-no-usage");
      expect(result).toBe(0);
    });

    it("should convert string to number", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total_bytes: "999999999999" }] });

      const result = await getMonthlyUsage("user-heavy");
      expect(typeof result).toBe("number");
      expect(result).toBe(999999999999);
    });

    it("should filter by current month using date_trunc", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total_bytes: "0" }] });

      await getMonthlyUsage("user-1");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("date_trunc('month', now())"),
        ["user-1"],
      );
    });

    it("should use COALESCE for null-safe aggregation", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ total_bytes: "0" }] });

      await getMonthlyUsage("user-1");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("COALESCE"),
        expect.any(Array),
      );
    });
  });
});
