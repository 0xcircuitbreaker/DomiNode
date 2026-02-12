import { describe, it, expect, vi, beforeEach } from "vitest";
import { PerProviderCircuitBreaker } from "./provider.js";

describe("PerProviderCircuitBreaker", () => {
  let cb: PerProviderCircuitBreaker;

  beforeEach(() => {
    cb = new PerProviderCircuitBreaker(5, 30000);
  });

  it("should start in closed/available state", () => {
    expect(cb.isAvailable()).toBe(true);
    expect(cb.getState()).toBe("closed");
    expect(cb.getConsecutiveFailures()).toBe(0);
  });

  it("should stay available below failure threshold", () => {
    for (let i = 0; i < 4; i++) {
      cb.recordFailure();
    }
    expect(cb.isAvailable()).toBe(true);
    expect(cb.getState()).toBe("closed");
    expect(cb.getConsecutiveFailures()).toBe(4);
  });

  it("should trip to open after reaching failure threshold", () => {
    for (let i = 0; i < 5; i++) {
      cb.recordFailure();
    }
    expect(cb.isAvailable()).toBe(false);
    expect(cb.getState()).toBe("open");
    expect(cb.getConsecutiveFailures()).toBe(5);
  });

  it("should reset failure count on success", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.getConsecutiveFailures()).toBe(0);
    expect(cb.getState()).toBe("closed");
  });

  it("should transition to half-open after cooldown", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      cb.recordFailure();
    }
    expect(cb.isAvailable()).toBe(false);

    vi.advanceTimersByTime(30_001);
    expect(cb.isAvailable()).toBe(true);
    expect(cb.getState()).toBe("half-open");
    vi.useRealTimers();
  });

  it("should close after successful probe in half-open", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      cb.recordFailure();
    }
    vi.advanceTimersByTime(30_001);
    cb.isAvailable(); // triggers half-open

    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");
    expect(cb.isAvailable()).toBe(true);
    vi.useRealTimers();
  });

  it("should re-open after failed probe in half-open", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      cb.recordFailure();
    }
    vi.advanceTimersByTime(30_001);
    cb.isAvailable(); // triggers half-open

    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    expect(cb.isAvailable()).toBe(false);
    vi.useRealTimers();
  });

  it("should track total requests and errors", () => {
    cb.recordSuccess();
    cb.recordSuccess();
    cb.recordFailure();
    expect(cb.getTotalRequests()).toBe(3);
    expect(cb.getTotalErrors()).toBe(1);
  });

  it("should compute average latency", () => {
    cb.recordSuccess(100);
    cb.recordSuccess(200);
    cb.recordSuccess(300);
    expect(cb.getAvgLatencyMs()).toBe(200);
  });

  it("should return 0 avg latency when no data", () => {
    expect(cb.getAvgLatencyMs()).toBe(0);
  });

  it("should support configurable threshold", () => {
    const cb3 = new PerProviderCircuitBreaker(3, 1000);
    cb3.recordFailure();
    cb3.recordFailure();
    expect(cb3.isAvailable()).toBe(true);
    cb3.recordFailure();
    expect(cb3.isAvailable()).toBe(false);
  });

  it("should reset state via _reset()", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess(100);
    cb._reset();
    expect(cb.getConsecutiveFailures()).toBe(0);
    expect(cb.getTotalRequests()).toBe(0);
    expect(cb.getTotalErrors()).toBe(0);
    expect(cb.getAvgLatencyMs()).toBe(0);
    expect(cb.getState()).toBe("closed");
  });

  it("should stay open when checked before cooldown expires", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      cb.recordFailure();
    }
    vi.advanceTimersByTime(15_000); // half of cooldown
    expect(cb.isAvailable()).toBe(false);
    expect(cb.getState()).toBe("open");
    vi.useRealTimers();
  });
});
