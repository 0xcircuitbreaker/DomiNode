import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@dominusnode/shared", () => ({
  BLOCKED_COUNTRY_CODES: new Set(["CU", "IR", "KP", "RU", "SY"]),
}));

import { PacketStreamProvider } from "./packetstream-provider.js";

// Set env vars before importing
process.env["PACKETSTREAM_USERNAME"] = "testuser";
process.env["PACKETSTREAM_PASSWORD"] = "testpass";

describe("PacketStreamProvider", () => {
  let provider: PacketStreamProvider;

  beforeEach(() => {
    provider = new PacketStreamProvider();
  });

  it("should have correct name and priority", () => {
    expect(provider.name).toBe("packetstream");
    expect(provider.priority).toBe(1);
    expect(provider.fallbackOnly).toBe(false);
  });

  it("should be available initially", () => {
    expect(provider.isAvailable()).toBe(true);
  });

  it("should delegate to buildUpstreamProxy", () => {
    const proxy = provider.getProxy();
    // Host/port come from env vars (may be overridden by other tests)
    expect(typeof proxy.host).toBe("string");
    expect(proxy.host.length).toBeGreaterThan(0);
    expect(typeof proxy.port).toBe("number");
    expect(proxy.username).toBe("testuser");
  });

  it("should pass proxy options through", () => {
    const proxy = provider.getProxy({ country: "US" });
    // Password should contain country suffix (non-enumerable)
    expect(Object.getOwnPropertyDescriptor(proxy, "password")?.value).toContain("_country-US");
  });

  it("should throw for sanctioned countries", () => {
    expect(() => provider.getProxy({ country: "CU" })).toThrow("sanctioned");
  });

  it("should track stats", () => {
    provider.recordSuccess(100);
    provider.recordSuccess(200);
    provider.recordFailure();

    const stats = provider.getStats();
    expect(stats.name).toBe("packetstream");
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
