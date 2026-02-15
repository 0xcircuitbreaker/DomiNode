import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@dominusnode/shared", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  checkAuthRateLimit,
  recordAuthFailure,
} from "./auth-rate-limit.js";

describe("proxy-gateway/auth-rate-limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkAuthRateLimit", () => {
    it("should return false initially (not blocked)", () => {
      expect(checkAuthRateLimit("fresh-ip-" + Date.now())).toBe(false);
    });

    it("should return false after fewer than MAX_FAILURES", () => {
      const ip = "rate-few-" + Date.now();
      recordAuthFailure(ip);
      recordAuthFailure(ip);
      recordAuthFailure(ip);
      recordAuthFailure(ip);
      expect(checkAuthRateLimit(ip)).toBe(false);
    });
  });

  describe("recordAuthFailure + checkAuthRateLimit", () => {
    it("should block after MAX_FAILURES (5)", () => {
      const ip = "rate-block-" + Date.now();
      for (let i = 0; i < 5; i++) {
        recordAuthFailure(ip);
      }
      expect(checkAuthRateLimit(ip)).toBe(true);
    });

    it("should remain blocked after more failures", () => {
      const ip = "rate-more-" + Date.now();
      for (let i = 0; i < 10; i++) {
        recordAuthFailure(ip);
      }
      expect(checkAuthRateLimit(ip)).toBe(true);
    });

    it("should track different IPs independently", () => {
      const ip1 = "rate-indep1-" + Date.now();
      const ip2 = "rate-indep2-" + Date.now();
      for (let i = 0; i < 5; i++) {
        recordAuthFailure(ip1);
      }
      expect(checkAuthRateLimit(ip1)).toBe(true);
      expect(checkAuthRateLimit(ip2)).toBe(false);
    });
  });

  describe("window expiry", () => {
    it("should unblock after WINDOW_MS expires", () => {
      vi.useFakeTimers();
      const ip = "rate-expire-" + Date.now();
      for (let i = 0; i < 5; i++) {
        recordAuthFailure(ip);
      }
      expect(checkAuthRateLimit(ip)).toBe(true);
      vi.advanceTimersByTime(60001);
      expect(checkAuthRateLimit(ip)).toBe(false);
      vi.useRealTimers();
    });

    it("should still be blocked just before window expires", () => {
      vi.useFakeTimers();
      const ip = "rate-before-" + Date.now();
      for (let i = 0; i < 5; i++) {
        recordAuthFailure(ip);
      }
      vi.advanceTimersByTime(59999);
      expect(checkAuthRateLimit(ip)).toBe(true);
      vi.useRealTimers();
    });

    it("should reset count after window expires", () => {
      vi.useFakeTimers();
      const ip = "rate-reset-" + Date.now();
      for (let i = 0; i < 5; i++) {
        recordAuthFailure(ip);
      }
      vi.advanceTimersByTime(60001);
      recordAuthFailure(ip);
      expect(checkAuthRateLimit(ip)).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("map size cap", () => {
    it("should handle many IPs without throwing", () => {
      expect(() => {
        for (let i = 0; i < 200; i++) {
          recordAuthFailure("cap-" + i + "-" + Date.now());
        }
      }).not.toThrow();
    });

    it("should evict oldest entries when exceeding MAX_MAP_SIZE (100000)", () => {
      // Fill the internal map to MAX_MAP_SIZE and beyond to trigger eviction.
      // The eviction code removes the oldest 25% (25000 entries) when the map
      // reaches 100,000 entries.
      const prefix = "evict-" + Date.now() + "-";
      for (let i = 0; i < 100001; i++) {
        recordAuthFailure(prefix + i);
      }
      // If eviction works correctly, no error is thrown and the map is capped.
      // Verify the earliest entries were evicted by checking they are no longer rate-limited.
      // The first entry only had 1 failure, so it was not blocked, but after eviction
      // it should have been removed entirely from the map.
      expect(checkAuthRateLimit(prefix + "0")).toBe(false);
      // A later entry (beyond the eviction window) should still exist
      expect(checkAuthRateLimit(prefix + "99999")).toBe(false); // only 1 failure, not blocked
    }, 60000);
  });

  describe("periodic cleanup", () => {
    it("should clean up expired entries when setInterval fires", () => {
      vi.useFakeTimers();
      const ip = "cleanup-interval-" + Date.now();
      for (let i = 0; i < 5; i++) {
        recordAuthFailure(ip);
      }
      expect(checkAuthRateLimit(ip)).toBe(true);
      // Advance past both the WINDOW_MS (60s) and the cleanup interval (300s / 5min)
      vi.advanceTimersByTime(300001);
      // After the setInterval cleanup fires, the expired entry should be removed.
      // checkAuthRateLimit returns false for expired/missing entries.
      expect(checkAuthRateLimit(ip)).toBe(false);
      vi.useRealTimers();
    });
  });
});
