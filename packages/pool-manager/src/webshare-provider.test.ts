import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@dominusnode/shared", () => ({
  BLOCKED_COUNTRY_CODES: new Set(["CU", "IR", "KP", "RU", "SY"]),
}));

import { WebshareDCProvider, WebshareResidentialProvider } from "./webshare-provider.js";

describe("WebshareDCProvider", () => {
  let provider: WebshareDCProvider;

  beforeEach(() => {
    provider = new WebshareDCProvider();
  });

  it("should have correct name and priority", () => {
    expect(provider.name).toBe("webshare-dc");
    expect(provider.priority).toBe(1);
    expect(provider.fallbackOnly).toBe(false);
  });

  it("should be available initially", () => {
    expect(provider.isAvailable()).toBe(true);
  });

  it("should delegate to buildUpstreamProxy with dc pool", () => {
    const proxy = provider.getProxy();
    expect(typeof proxy.host).toBe("string");
    expect(proxy.host.length).toBeGreaterThan(0);
    expect(typeof proxy.port).toBe("number");
    // Username should contain dc username with -rotate suffix
    expect(proxy.username).toContain("testdcuser");
    expect(proxy.username).toContain("-rotate");
  });

  it("should pass proxy options through", () => {
    const proxy = provider.getProxy({ country: "US" });
    expect(proxy.username).toContain("-country-US");
  });

  it("should throw for sanctioned countries", () => {
    expect(() => provider.getProxy({ country: "CU" })).toThrow("sanctioned");
  });

  it("should track stats", () => {
    provider.recordSuccess(100);
    provider.recordSuccess(200);
    provider.recordFailure();

    const stats = provider.getStats();
    expect(stats.name).toBe("webshare-dc");
    expect(stats.totalRequests).toBe(3);
    expect(stats.totalErrors).toBe(1);
    expect(stats.avgLatencyMs).toBe(150);
    expect(stats.fallbackOnly).toBe(false);
  });

  it("should become unavailable after circuit breaker trips", () => {
    for (let i = 0; i < 5; i++) {
      provider.recordFailure();
    }
    expect(provider.isAvailable()).toBe(false);
    expect(provider.getStats().state).toBe("open");
  });
});

describe("WebshareResidentialProvider", () => {
  let provider: WebshareResidentialProvider;

  beforeEach(() => {
    provider = new WebshareResidentialProvider();
  });

  it("should have correct name and priority", () => {
    expect(provider.name).toBe("webshare-residential");
    expect(provider.priority).toBe(2);
    expect(provider.fallbackOnly).toBe(false);
  });

  it("should be available initially", () => {
    expect(provider.isAvailable()).toBe(true);
  });

  it("should delegate to buildUpstreamProxy with residential pool", () => {
    const proxy = provider.getProxy();
    expect(proxy.username).toContain("testresuser");
    expect(proxy.username).toContain("-rotate");
  });

  it("should pass proxy options through", () => {
    const proxy = provider.getProxy({ country: "DE" });
    expect(proxy.username).toContain("-country-DE");
  });

  it("should throw for sanctioned countries", () => {
    expect(() => provider.getProxy({ country: "IR" })).toThrow("sanctioned");
  });

  it("should track stats independently", () => {
    provider.recordSuccess(50);
    provider.recordFailure();

    const stats = provider.getStats();
    expect(stats.name).toBe("webshare-residential");
    expect(stats.totalRequests).toBe(2);
    expect(stats.totalErrors).toBe(1);
  });

  it("should become unavailable after circuit breaker trips", () => {
    for (let i = 0; i < 5; i++) {
      provider.recordFailure();
    }
    expect(provider.isAvailable()).toBe(false);
  });
});
