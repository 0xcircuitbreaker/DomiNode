import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@dominusnode/shared", () => ({
  BLOCKED_COUNTRY_CODES: new Set(["CU", "IR", "KP", "RU", "SY"]),
}));

import { ProviderSelector } from "./provider-selector.js";
import { WebshareDCProvider, WebshareResidentialProvider } from "./webshare-provider.js";
import { DirectProvider } from "./direct-provider.js";

describe("ProviderSelector", () => {
  let dc: WebshareDCProvider;
  let residential: WebshareResidentialProvider;
  let fallback1: DirectProvider;
  let selector: ProviderSelector;

  beforeEach(() => {
    dc = new WebshareDCProvider();
    residential = new WebshareResidentialProvider();
    fallback1 = new DirectProvider({
      host: "fallback1.example.com",
      port: 8080,
      name: "fallback-1",
    });
    selector = new ProviderSelector([dc, residential, fallback1]);
  });

  it("should select DC provider (highest priority) by default", () => {
    const { provider, proxy } = selector.select();
    expect(provider.name).toBe("webshare-dc");
    expect(typeof proxy.host).toBe("string");
    expect(proxy.host.length).toBeGreaterThan(0);
  });

  it("should select residential when DC is down", () => {
    for (let i = 0; i < 5; i++) {
      dc.recordFailure();
    }
    expect(dc.isAvailable()).toBe(false);

    const { provider } = selector.select();
    expect(provider.name).toBe("webshare-residential");
  });

  it("should fall back to DirectProvider when both Webshare pools are down", () => {
    for (let i = 0; i < 5; i++) {
      dc.recordFailure();
      residential.recordFailure();
    }

    const { provider, proxy } = selector.select();
    expect(provider.name).toBe("fallback-1");
    expect(proxy.host).toBe("fallback1.example.com");
  });

  it("should throw when all providers are down", () => {
    for (let i = 0; i < 5; i++) {
      dc.recordFailure();
      residential.recordFailure();
      fallback1.recordFailure();
    }

    expect(() => selector.select()).toThrow("All proxy providers are unavailable");
  });

  it("should filter to DC only when proxyType is dc", () => {
    const { provider } = selector.select({ proxyType: "dc" });
    expect(provider.name).toBe("webshare-dc");
  });

  it("should filter to residential only when proxyType is residential", () => {
    const { provider } = selector.select({ proxyType: "residential" });
    expect(provider.name).toBe("webshare-residential");
  });

  it("should throw when proxyType=dc but DC is down", () => {
    for (let i = 0; i < 5; i++) {
      dc.recordFailure();
    }

    expect(() => selector.select({ proxyType: "dc" })).toThrow("All proxy providers are unavailable");
  });

  it("should use all providers when proxyType is auto", () => {
    const { provider } = selector.select({ proxyType: "auto" });
    // auto should select DC (priority 1) first
    expect(provider.name).toBe("webshare-dc");
  });

  it("should record success for named provider", () => {
    selector.recordSuccess("webshare-dc", 100);
    const stats = selector.getStats();
    const dcStats = stats.find((s) => s.name === "webshare-dc")!;
    expect(dcStats.totalRequests).toBe(1);
    expect(dcStats.avgLatencyMs).toBe(100);
  });

  it("should record failure for named provider", () => {
    selector.recordFailure("webshare-residential");
    const stats = selector.getStats();
    const resStats = stats.find((s) => s.name === "webshare-residential")!;
    expect(resStats.totalErrors).toBe(1);
    expect(resStats.consecutiveFailures).toBe(1);
  });

  it("should return stats for all providers", () => {
    const stats = selector.getStats();
    expect(stats).toHaveLength(3);
    expect(stats.map((s) => s.name)).toContain("webshare-dc");
    expect(stats.map((s) => s.name)).toContain("webshare-residential");
    expect(stats.map((s) => s.name)).toContain("fallback-1");
  });

  it("should report provider count", () => {
    expect(selector.getProviderCount()).toBe(3);
  });

  it("should sort providers by priority", () => {
    const stats = selector.getStats();
    // DC (priority 1) should come first, then residential (priority 2), then fallback (priority 10)
    expect(stats[0].name).toBe("webshare-dc");
    expect(stats[1].name).toBe("webshare-residential");
    expect(stats[2].name).toBe("fallback-1");
  });

  it("should pass proxy options to selected provider", () => {
    const { proxy } = selector.select({ country: "US" });
    // DC provider should add country to username
    expect(proxy.username).toContain("-country-US");
  });

  it("should handle single-provider selector", () => {
    const single = new ProviderSelector([dc]);
    const { provider } = single.select();
    expect(provider.name).toBe("webshare-dc");
    expect(single.getProviderCount()).toBe(1);
  });

  it("should ignore record calls for unknown provider names", () => {
    // Should not throw
    selector.recordSuccess("nonexistent", 100);
    selector.recordFailure("nonexistent");
  });
});
