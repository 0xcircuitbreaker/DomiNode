import { describe, it, expect, beforeEach } from "vitest";
import { DirectProvider } from "./direct-provider.js";

describe("DirectProvider", () => {
  let provider: DirectProvider;

  beforeEach(() => {
    provider = new DirectProvider({
      host: "oracle-vm.example.com",
      port: 8080,
      username: "proxyuser",
      password: "proxypass",
      name: "oracle-vm-1",
    });
  });

  it("should have correct name from config", () => {
    expect(provider.name).toBe("oracle-vm-1");
  });

  it("should default name from host", () => {
    const p = new DirectProvider({ host: "10.0.0.1", port: 3128 });
    expect(p.name).toBe("direct-10.0.0.1");
  });

  it("should have fallbackOnly = true and priority = 10", () => {
    expect(provider.fallbackOnly).toBe(true);
    expect(provider.priority).toBe(10);
  });

  it("should be available initially", () => {
    expect(provider.isAvailable()).toBe(true);
  });

  it("should return static proxy config", () => {
    const proxy = provider.getProxy();
    expect(proxy.host).toBe("oracle-vm.example.com");
    expect(proxy.port).toBe(8080);
    expect(proxy.username).toBe("proxyuser");
  });

  it("should make password non-enumerable", () => {
    const proxy = provider.getProxy();
    expect(Object.keys(proxy)).not.toContain("password");
    expect(Object.getOwnPropertyDescriptor(proxy, "password")?.value).toBe("proxypass");
  });

  it("should handle missing credentials", () => {
    const p = new DirectProvider({ host: "10.0.0.1", port: 3128 });
    const proxy = p.getProxy();
    expect(proxy.username).toBe("");
    expect(Object.getOwnPropertyDescriptor(proxy, "password")?.value).toBe("");
  });

  it("should reject country targeting it cannot honor", () => {
    expect(() => provider.getProxy({ country: "US" })).toThrow(/country targeting/);
    expect(() => provider.getProxy({ country: "IR" })).toThrow(/sanctioned/);
  });

  it("should reject sticky sessions and other geo options", () => {
    expect(() => provider.getProxy({ sessionId: "abc" })).toThrow(/sticky/);
    expect(() => provider.getProxy({ sticky: true })).toThrow(/sticky/);
    expect(() => provider.getProxy({ city: "berlin" })).toThrow(/geo/);
  });

  it("should serve untargeted requests", () => {
    expect(provider.getProxy({ proxyType: "auto" }).host).toBe("oracle-vm.example.com");
  });

  it("should track stats", () => {
    provider.recordSuccess(50);
    provider.recordFailure();

    const stats = provider.getStats();
    expect(stats.name).toBe("oracle-vm-1");
    expect(stats.totalRequests).toBe(2);
    expect(stats.totalErrors).toBe(1);
    expect(stats.avgLatencyMs).toBe(50);
    expect(stats.fallbackOnly).toBe(true);
  });

  it("should become unavailable after circuit breaker trips", () => {
    for (let i = 0; i < 5; i++) {
      provider.recordFailure();
    }
    expect(provider.isAvailable()).toBe(false);
  });
});
