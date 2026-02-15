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
  incrementUserConns,
  decrementUserConns,
  getUserConnCount,
} from "./connection-tracker.js";

describe("proxy-gateway/connection-tracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("incrementUserConns", () => {
    it("should return true when under limit", () => {
      const userId = "inc-user-1-" + Date.now();
      expect(incrementUserConns(userId)).toBe(true);
      expect(getUserConnCount(userId)).toBe(1);
      decrementUserConns(userId);
    });

    it("should increment count on each call", () => {
      const userId = "inc-user-2-" + Date.now();
      incrementUserConns(userId);
      incrementUserConns(userId);
      incrementUserConns(userId);
      expect(getUserConnCount(userId)).toBe(3);
      decrementUserConns(userId);
      decrementUserConns(userId);
      decrementUserConns(userId);
    });

    it("should return false at MAX_PER_USER (100)", () => {
      const userId = "inc-user-limit-" + Date.now();
      for (let i = 0; i < 100; i++) {
        expect(incrementUserConns(userId)).toBe(true);
      }
      expect(incrementUserConns(userId)).toBe(false);
      expect(getUserConnCount(userId)).toBe(100);
      for (let i = 0; i < 100; i++) {
        decrementUserConns(userId);
      }
    });

    it("should respect custom maxConns parameter", () => {
      const userId = "inc-user-custom-" + Date.now();
      // Custom limit of 10 (like free plan)
      for (let i = 0; i < 10; i++) {
        expect(incrementUserConns(userId, 10)).toBe(true);
      }
      // 11th should be rejected with custom limit
      expect(incrementUserConns(userId, 10)).toBe(false);
      expect(getUserConnCount(userId)).toBe(10);
      for (let i = 0; i < 10; i++) {
        decrementUserConns(userId);
      }
    });

    it("should use default MAX_PER_USER when maxConns not provided", () => {
      const userId = "inc-user-default-" + Date.now();
      expect(incrementUserConns(userId)).toBe(true);
      expect(getUserConnCount(userId)).toBe(1);
      decrementUserConns(userId);
    });

    it("should track different users independently", () => {
      const user1 = "inc-indep-1-" + Date.now();
      const user2 = "inc-indep-2-" + Date.now();
      incrementUserConns(user1);
      incrementUserConns(user1);
      incrementUserConns(user2);
      expect(getUserConnCount(user1)).toBe(2);
      expect(getUserConnCount(user2)).toBe(1);
      decrementUserConns(user1);
      decrementUserConns(user1);
      decrementUserConns(user2);
    });
  });

  describe("decrementUserConns", () => {
    it("should decrease count", () => {
      const userId = "dec-user-1-" + Date.now();
      incrementUserConns(userId);
      incrementUserConns(userId);
      decrementUserConns(userId);
      expect(getUserConnCount(userId)).toBe(1);
      decrementUserConns(userId);
    });

    it("should not go below 0", () => {
      const userId = "dec-user-below-" + Date.now();
      decrementUserConns(userId);
      decrementUserConns(userId);
      expect(getUserConnCount(userId)).toBe(0);
    });

    it("should clean up map entry when count reaches zero", () => {
      const userId = "dec-user-cleanup-" + Date.now();
      incrementUserConns(userId);
      decrementUserConns(userId);
      expect(getUserConnCount(userId)).toBe(0);
    });

    it("should allow incrementing again after decrement to zero", () => {
      const userId = "dec-user-reinc-" + Date.now();
      incrementUserConns(userId);
      decrementUserConns(userId);
      expect(incrementUserConns(userId)).toBe(true);
      expect(getUserConnCount(userId)).toBe(1);
      decrementUserConns(userId);
    });
  });

  describe("getUserConnCount", () => {
    it("should return 0 for unknown user", () => {
      expect(getUserConnCount("unknown-user-xyz-" + Date.now())).toBe(0);
    });

    it("should return correct count after increments", () => {
      const userId = "count-user-1-" + Date.now();
      incrementUserConns(userId);
      incrementUserConns(userId);
      expect(getUserConnCount(userId)).toBe(2);
      decrementUserConns(userId);
      decrementUserConns(userId);
    });

    it("should reflect decrements correctly", () => {
      const userId = "count-user-dec-" + Date.now();
      incrementUserConns(userId);
      incrementUserConns(userId);
      incrementUserConns(userId);
      decrementUserConns(userId);
      expect(getUserConnCount(userId)).toBe(2);
      decrementUserConns(userId);
      decrementUserConns(userId);
    });
  });

  describe("shared state across protocols", () => {
    it("should share connection counts between HTTP and SOCKS5 contexts", () => {
      const userId = "shared-user-" + Date.now();
      incrementUserConns(userId);
      incrementUserConns(userId);
      expect(getUserConnCount(userId)).toBe(2);
      decrementUserConns(userId);
      decrementUserConns(userId);
    });
  });
});
