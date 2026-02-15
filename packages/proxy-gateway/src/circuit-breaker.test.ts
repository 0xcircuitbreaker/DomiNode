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
  recordSuccess,
  recordFailure,
  isOpen,
  getState,
  getStats,
  _reset,
} from "./circuit-breaker.js";

describe("proxy-gateway/circuit-breaker", () => {
  beforeEach(() => {
    _reset();
  });

  it("should start in closed state", () => {
    expect(getState()).toBe("closed");
    expect(isOpen()).toBe(false);
  });

  it("should stay closed below failure threshold", () => {
    for (let i = 0; i < 4; i++) {
      recordFailure();
    }
    expect(getState()).toBe("closed");
    expect(isOpen()).toBe(false);
  });

  it("should trip to open after reaching failure threshold", () => {
    for (let i = 0; i < 5; i++) {
      recordFailure();
    }
    expect(getState()).toBe("open");
    expect(isOpen()).toBe(true);
  });

  it("should reset failure count on success", () => {
    recordFailure();
    recordFailure();
    recordFailure();
    recordSuccess();
    expect(getStats().failures).toBe(0);
    expect(getState()).toBe("closed");
  });

  it("should transition to half-open after cooldown", () => {
    for (let i = 0; i < 5; i++) {
      recordFailure();
    }
    expect(isOpen()).toBe(true);

    // Simulate cooldown expiry
    vi.useFakeTimers();
    vi.advanceTimersByTime(30_001);
    expect(isOpen()).toBe(false); // allows probe through
    expect(getState()).toBe("half-open");
    vi.useRealTimers();
  });

  it("should close after successful probe in half-open", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      recordFailure();
    }
    vi.advanceTimersByTime(30_001);
    isOpen(); // triggers half-open transition

    recordSuccess();
    expect(getState()).toBe("closed");
    expect(isOpen()).toBe(false);
    vi.useRealTimers();
  });

  it("should re-open after failed probe in half-open", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      recordFailure();
    }
    vi.advanceTimersByTime(30_001);
    isOpen(); // triggers half-open transition

    recordFailure();
    expect(getState()).toBe("open");
    expect(isOpen()).toBe(true);
    vi.useRealTimers();
  });

  it("should track lastFailure and lastSuccess timestamps", () => {
    expect(getStats().lastFailure).toBeNull();
    expect(getStats().lastSuccess).toBeNull();

    recordFailure();
    expect(getStats().lastFailure).toBeInstanceOf(Date);
    expect(getStats().lastSuccess).toBeNull();

    recordSuccess();
    expect(getStats().lastSuccess).toBeInstanceOf(Date);
  });

  it("getStats returns full state object", () => {
    recordFailure();
    recordFailure();
    const stats = getStats();
    expect(stats.state).toBe("closed");
    expect(stats.failures).toBe(2);
    expect(stats.lastFailure).toBeInstanceOf(Date);
    expect(stats.lastSuccess).toBeNull();
  });

  it("should stay open when checked before cooldown expires", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      recordFailure();
    }

    vi.advanceTimersByTime(15_000); // half of cooldown
    expect(isOpen()).toBe(true);
    expect(getState()).toBe("open");
    vi.useRealTimers();
  });
});
