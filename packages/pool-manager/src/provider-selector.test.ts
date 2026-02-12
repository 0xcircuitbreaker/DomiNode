import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@dominode/shared", () => ({
  BLOCKED_COUNTRY_CODES: new Set(["CU", "IR", "KP", "RU", "SY"]),
}));

import { ProviderSelector } from "./provider-selector.js";
import { PacketStreamProvider } from "./packetstream-provider.js";
import { DirectProvider } from "./direct-provider.js";

// Set env vars for PacketStream
process.env["PACKETSTREAM_USERNAME"] = "testuser";
process.env["PACKETSTREAM_PASSWORD"] = "testpass";

describe("ProviderSelector", () => {
  let packetstream: PacketStreamProvider;
  let fallback1: DirectProvider;
  let fallback2: DirectProvider;
  let selector: ProviderSelector;

  beforeEach(() => {
    packetstream = new PacketStreamProvider();
    fallback1 = new DirectProvider({
      host: "fallback1.example.com",
      port: 8080,
      name: "fallback-1",
    });
    fallback2 = new DirectProvider({
      host: "fallback2.example.com",
      port: 8080,
      name: "fallback-2",
    });
    selector = new ProviderSelector([packetstream, fallback1, fallback2]);
  });

  it("should select primary provider when available", () => {
    const { provider, proxy } = selector.select();
    expect(provider.name).toBe("packetstream");
    // Host comes from env vars, just verify it's set
    expect(typeof proxy.host).toBe("string");
    expect(proxy.host.length).toBeGreaterThan(0);
  });

  it("should fall back when primary is down", () => {
    // Trip packetstream circuit breaker
    for (let i = 0; i < 5; i++) {
      packetstream.recordFailure();
    }
    expect(packetstream.isAvailable()).toBe(false);

    const { provider, proxy } = selector.select();
    expect(provider.name).toBe("fallback-1");
    expect(proxy.host).toBe("fallback1.example.com");
  });

  it("should try second fallback when first is also down", () => {
    // Trip both packetstream and fallback-1
    for (let i = 0; i < 5; i++) {
      packetstream.recordFailure();
      fallback1.recordFailure();
    }

    const { provider } = selector.select();
    expect(provider.name).toBe("fallback-2");
  });

  it("should throw when all providers are down", () => {
    for (let i = 0; i < 5; i++) {
      packetstream.recordFailure();
      fallback1.recordFailure();
      fallback2.recordFailure();
    }

    expect(() => selector.select()).toThrow("All proxy providers are unavailable");
  });

  it("should record success for named provider", () => {
    selector.recordSuccess("packetstream", 100);
    const stats = selector.getStats();
    const ps = stats.find((s) => s.name === "packetstream")!;
    expect(ps.totalRequests).toBe(1);
    expect(ps.avgLatencyMs).toBe(100);
  });

  it("should record failure for named provider", () => {
    selector.recordFailure("fallback-1");
    const stats = selector.getStats();
    const fb = stats.find((s) => s.name === "fallback-1")!;
    expect(fb.totalErrors).toBe(1);
    expect(fb.consecutiveFailures).toBe(1);
  });

  it("should return stats for all providers", () => {
    const stats = selector.getStats();
    expect(stats).toHaveLength(3);
    expect(stats.map((s) => s.name)).toContain("packetstream");
    expect(stats.map((s) => s.name)).toContain("fallback-1");
    expect(stats.map((s) => s.name)).toContain("fallback-2");
  });

  it("should report provider count", () => {
    expect(selector.getProviderCount()).toBe(3);
  });

  it("should sort providers by priority", () => {
    const stats = selector.getStats();
    // packetstream (priority 1) should come before fallbacks (priority 10)
    expect(stats[0].name).toBe("packetstream");
  });

  it("should pass proxy options to selected provider", () => {
    const { proxy } = selector.select({ country: "US" });
    // PacketStream should add country suffix
    expect(Object.getOwnPropertyDescriptor(proxy, "password")?.value).toContain("_country-US");
  });

  it("should handle single-provider selector", () => {
    const single = new ProviderSelector([packetstream]);
    const { provider } = single.select();
    expect(provider.name).toBe("packetstream");
    expect(single.getProviderCount()).toBe(1);
  });

  it("should ignore record calls for unknown provider names", () => {
    // Should not throw
    selector.recordSuccess("nonexistent", 100);
    selector.recordFailure("nonexistent");
  });
});
