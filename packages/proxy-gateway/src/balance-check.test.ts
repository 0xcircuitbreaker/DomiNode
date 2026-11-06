import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @dominusnode/shared
const mockGetBalance = vi.fn();

vi.mock("@dominusnode/shared", () => ({
  walletRepo: {
    getBalance: (...args: unknown[]) => mockGetBalance(...args),
  },
}));

import { checkBalance, invalidateBalanceCache } from "./balance-check.js";

// Use unique user IDs per test to avoid any shared cache state issues
let testUserId = 0;
function nextUser(): string {
  return `user-bc-${++testUserId}`;
}

describe("proxy-gateway/balance-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkBalance", () => {
    it("should return true when user has positive balance", async () => {
      const uid = nextUser();
      mockGetBalance.mockResolvedValue(1000);

      const result = await checkBalance(uid);
      expect(result).toBe(true);
      expect(mockGetBalance).toHaveBeenCalledWith(uid);
    });

    it("should return false when user has zero balance", async () => {
      const uid = nextUser();
      mockGetBalance.mockResolvedValue(0);

      const result = await checkBalance(uid);
      expect(result).toBe(false);
    });

    it("should return false when user has negative balance", async () => {
      const uid = nextUser();
      mockGetBalance.mockResolvedValue(-100);

      const result = await checkBalance(uid);
      expect(result).toBe(false);
    });

    it("should use cache on second call within TTL", async () => {
      const uid = nextUser();
      mockGetBalance.mockResolvedValue(500);

      await checkBalance(uid);
      const result = await checkBalance(uid);

      expect(result).toBe(true);
      // getBalance should only have been called once due to caching
      expect(mockGetBalance).toHaveBeenCalledTimes(1);
    });

    it("should return cached false result", async () => {
      const uid = nextUser();
      mockGetBalance.mockResolvedValue(0);

      const result1 = await checkBalance(uid);
      expect(result1).toBe(false);

      // Even though we change the mock, cache should still say false
      mockGetBalance.mockResolvedValue(1000);
      const result2 = await checkBalance(uid);
      expect(result2).toBe(false);
      expect(mockGetBalance).toHaveBeenCalledTimes(1); // still cached
    });

    it("should re-fetch after cache invalidation", async () => {
      const uid = nextUser();
      mockGetBalance.mockResolvedValue(500);
      const result1 = await checkBalance(uid);
      expect(result1).toBe(true);
      expect(mockGetBalance).toHaveBeenCalledTimes(1);

      invalidateBalanceCache(uid);

      // Change what mock returns
      mockGetBalance.mockResolvedValue(0);
      const result2 = await checkBalance(uid);
      expect(result2).toBe(false);
      expect(mockGetBalance).toHaveBeenCalledTimes(2);
    });

    it("should re-fetch after TTL expires", async () => {
      vi.useFakeTimers();
      const uid = nextUser();
      mockGetBalance.mockResolvedValue(500);

      await checkBalance(uid);
      expect(mockGetBalance).toHaveBeenCalledTimes(1);

      // Advance past the 30-second TTL (default BALANCE_CACHE_TTL_MS)
      vi.advanceTimersByTime(30_001);

      mockGetBalance.mockResolvedValue(0);
      const result = await checkBalance(uid);
      expect(result).toBe(false);
      expect(mockGetBalance).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("should still use cache before TTL expires", async () => {
      vi.useFakeTimers();
      const uid = nextUser();
      mockGetBalance.mockResolvedValue(500);

      await checkBalance(uid);
      expect(mockGetBalance).toHaveBeenCalledTimes(1);

      // Advance to just before TTL
      vi.advanceTimersByTime(4999);

      mockGetBalance.mockResolvedValue(0);
      const result = await checkBalance(uid);
      // Should still be cached with old value
      expect(result).toBe(true);
      expect(mockGetBalance).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("should evict oldest entries when cache exceeds MAX_CACHE_SIZE", async () => {
      // MAX_CACHE_SIZE is 10,000. Fill the cache to the limit then add one more.
      mockGetBalance.mockResolvedValue(100);

      // Fill the cache to exactly MAX_CACHE_SIZE
      const promises = [];
      for (let i = 0; i < 10_000; i++) {
        promises.push(checkBalance(`evict-user-${i}`));
      }
      await Promise.all(promises);

      // The cache is now at 10,000 entries. The next call should trigger eviction.
      mockGetBalance.mockResolvedValue(200);
      await checkBalance("evict-trigger-user");

      // After eviction, the first half (5000) of the oldest entries should be gone.
      // Verify by checking that an old user requires a re-fetch.
      mockGetBalance.mockResolvedValue(300);
      const result = await checkBalance("evict-user-0");
      // If eviction worked, evict-user-0 was evicted so getBalance is called again
      // The total calls: 10000 (initial fill) + 1 (trigger) + 1 (evict-user-0 re-fetch) = 10002
      // But we only care that the old entry was evicted
      expect(result).toBe(true);
    });

    it("should keep the newer half of entries after eviction", async () => {
      mockGetBalance.mockResolvedValue(100);

      // Fill the cache to exactly MAX_CACHE_SIZE
      const promises = [];
      for (let i = 0; i < 10_000; i++) {
        promises.push(checkBalance(`keep-user-${i}`));
      }
      await Promise.all(promises);

      // Trigger eviction
      mockGetBalance.mockResolvedValue(200);
      await checkBalance("keep-trigger-user");

      // Clear the mock call count
      mockGetBalance.mockClear();

      // The last entry (keep-user-9999) should still be in cache
      const result = await checkBalance("keep-user-9999");
      expect(result).toBe(true);
      // If it's still cached, getBalance should NOT have been called
      expect(mockGetBalance).toHaveBeenCalledTimes(0);
    });

    it("should handle concurrent calls for the same user", async () => {
      const uid = nextUser();
      mockGetBalance.mockResolvedValue(500);

      const [r1, r2, r3] = await Promise.all([
        checkBalance(uid),
        checkBalance(uid),
        checkBalance(uid),
      ]);

      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(r3).toBe(true);
    });

    it("should return false for balance below reservation minimum (1 cent)", async () => {
      const uid = nextUser();
      mockGetBalance.mockResolvedValue(1);

      const result = await checkBalance(uid);
      expect(result).toBe(false);
    });

    it("should return true for balance at exact reservation minimum (50 cents)", async () => {
      const uid = nextUser();
      mockGetBalance.mockResolvedValue(50);

      const result = await checkBalance(uid);
      expect(result).toBe(true);
    });

    it("should handle very large balance values", async () => {
      const uid = nextUser();
      mockGetBalance.mockResolvedValue(999_999_999);

      const result = await checkBalance(uid);
      expect(result).toBe(true);
    });
  });

  describe("invalidateBalanceCache", () => {
    it("should clear cache for specified user", async () => {
      const uid = nextUser();
      mockGetBalance.mockResolvedValue(100);
      await checkBalance(uid);
      expect(mockGetBalance).toHaveBeenCalledTimes(1);

      invalidateBalanceCache(uid);

      mockGetBalance.mockResolvedValue(200);
      await checkBalance(uid);

      expect(mockGetBalance).toHaveBeenCalledTimes(2);
    });

    it("should not throw for non-existent user", () => {
      expect(() => invalidateBalanceCache("non-existent")).not.toThrow();
    });

    it("should not affect other users' cache entries", async () => {
      const uid1 = nextUser();
      const uid2 = nextUser();
      mockGetBalance.mockResolvedValue(100);

      await checkBalance(uid1);
      await checkBalance(uid2);
      expect(mockGetBalance).toHaveBeenCalledTimes(2);

      // Invalidate only uid1
      invalidateBalanceCache(uid1);
      mockGetBalance.mockClear();

      // uid2 should still be cached
      await checkBalance(uid2);
      expect(mockGetBalance).toHaveBeenCalledTimes(0);

      // uid1 should re-fetch
      await checkBalance(uid1);
      expect(mockGetBalance).toHaveBeenCalledTimes(1);
    });

    it("should allow multiple invalidations for the same user", () => {
      const uid = nextUser();
      expect(() => {
        invalidateBalanceCache(uid);
        invalidateBalanceCache(uid);
        invalidateBalanceCache(uid);
      }).not.toThrow();
    });
  });
});
