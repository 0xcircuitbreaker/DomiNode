import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@dominusnode/shared", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  walletRepo: { reserveBalance: vi.fn(), releaseReservation: vi.fn(), settleSession: vi.fn() },
  usageRepo: { createSession: vi.fn(), endSession: vi.fn(), createUsageRecord: vi.fn() },
  planRepo: { getUserPlan: vi.fn(), getMonthlyUsage: vi.fn() },
}));

vi.mock("@dominusnode/metering", () => ({
  computeCostCents: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("./balance-check.js", () => ({
  invalidateBalanceCache: vi.fn(),
}));

import {
  recordRequest,
  recordError,
  recordLatency,
  getAvgLatencyMs,
  getStats,
  _reset,
} from "./stats.js";

describe("proxy-gateway/stats", () => {
  beforeEach(() => {
    _reset();
  });

  it("should start with zero counters", () => {
    const stats = getStats();
    expect(stats.totalRequests).toBe(0);
    expect(stats.totalErrors).toBe(0);
    expect(stats.avgLatencyMs).toBe(0);
    expect(stats.status).toBe("operational");
  });

  it("should increment request counter", () => {
    recordRequest();
    recordRequest();
    expect(getStats().totalRequests).toBe(2);
  });

  it("should increment error counter", () => {
    recordError();
    expect(getStats().totalErrors).toBe(1);
  });

  it("should compute average latency", () => {
    recordLatency(100);
    recordLatency(200);
    recordLatency(300);
    expect(getAvgLatencyMs()).toBe(200);
  });

  it("should maintain rolling window for latency", () => {
    // Fill window with 100 values of 1000
    for (let i = 0; i < 100; i++) {
      recordLatency(1000);
    }
    expect(getAvgLatencyMs()).toBe(1000);

    // Add 100 more values of 200, pushing out all 1000s
    for (let i = 0; i < 100; i++) {
      recordLatency(200);
    }
    // Window now has only 200s
    expect(getAvgLatencyMs()).toBe(200);
  });

  it("should report operational when healthy", () => {
    recordRequest();
    expect(getStats().status).toBe("operational");
  });

  it("should report degraded when error rate > 50%", () => {
    recordRequest();
    recordRequest();
    recordError();
    recordError();
    expect(getStats().status).toBe("degraded");
  });

  it("should track uptime in seconds", () => {
    const stats = getStats();
    expect(stats.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("should report status as operational by default", () => {
    expect(getStats().status).toBe("operational");
  });
});
