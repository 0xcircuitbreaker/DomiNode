import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@dominode/shared", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockResolve = vi.fn();
const mockResolve6 = vi.fn();

vi.mock("node:dns", () => ({
  promises: {
    resolve: (...args: unknown[]) => mockResolve(...args),
    resolve6: (...args: unknown[]) => mockResolve6(...args),
  },
}));

import {
  isValidHostname,
  isValidPort,
  isBlockedTarget,
  validateTarget,
} from "./target-validator.js";

describe("proxy-gateway/target-validator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isValidHostname", () => {
    it("should accept valid hostnames", () => {
      expect(isValidHostname("example.com")).toBe(true);
      expect(isValidHostname("sub.example.com")).toBe(true);
      expect(isValidHostname("my-host.io")).toBe(true);
    });

    it("should accept IP addresses as hostnames", () => {
      expect(isValidHostname("8.8.8.8")).toBe(true);
    });

    it("should accept IPv6 in bracket notation", () => {
      expect(isValidHostname("[::1]")).toBe(true);
    });

    it("should reject CRLF characters", () => {
      expect(isValidHostname("example.com\r\n")).toBe(false);
      expect(isValidHostname("host\ninjection")).toBe(false);
    });

    it("should reject spaces", () => {
      expect(isValidHostname("example .com")).toBe(false);
      expect(isValidHostname(" example.com")).toBe(false);
    });

    it("should reject null bytes", () => {
      expect(isValidHostname("example.com\0")).toBe(false);
    });

    it("should reject too-long hostnames (>253)", () => {
      expect(isValidHostname("a".repeat(254))).toBe(false);
    });

    it("should accept hostname at exactly 253 chars", () => {
      expect(isValidHostname("a".repeat(253))).toBe(true);
    });

    it("should reject empty hostname", () => {
      expect(isValidHostname("")).toBe(false);
    });

    it("should reject special characters", () => {
      expect(isValidHostname("example.com;ls")).toBe(false);
      expect(isValidHostname("example.com|cat")).toBe(false);
    });
  });

  describe("isValidPort", () => {
    it("should accept valid ports", () => {
      expect(isValidPort(1)).toBe(true);
      expect(isValidPort(80)).toBe(true);
      expect(isValidPort(443)).toBe(true);
      expect(isValidPort(65535)).toBe(true);
    });

    it("should reject port 0", () => {
      expect(isValidPort(0)).toBe(false);
    });

    it("should reject negative ports", () => {
      expect(isValidPort(-1)).toBe(false);
    });

    it("should reject port above 65535", () => {
      expect(isValidPort(65536)).toBe(false);
    });

    it("should reject NaN", () => {
      expect(isValidPort(NaN)).toBe(false);
    });

    it("should reject non-integer values", () => {
      expect(isValidPort(80.5)).toBe(false);
    });

    it("should reject Infinity", () => {
      expect(isValidPort(Infinity)).toBe(false);
    });
  });

  describe("isBlockedTarget", () => {
    it("should block loopback addresses", () => {
      expect(isBlockedTarget("127.0.0.1", 80)).toBe(true);
    });

    it("should block private 10.x.x.x", () => {
      expect(isBlockedTarget("10.0.0.1", 80)).toBe(true);
    });

    it("should block private 172.16.x.x", () => {
      expect(isBlockedTarget("172.16.0.1", 80)).toBe(true);
    });

    it("should block private 192.168.x.x", () => {
      expect(isBlockedTarget("192.168.1.1", 80)).toBe(true);
    });

    it("should block cloud metadata 169.254.169.254", () => {
      expect(isBlockedTarget("169.254.169.254", 80)).toBe(true);
    });

    it("should block 0.0.0.0", () => {
      expect(isBlockedTarget("0.0.0.0", 80)).toBe(true);
    });

    it("should block IPv6 loopback ::1", () => {
      expect(isBlockedTarget("::1", 80)).toBe(true);
    });

    it("should block IPv6 link-local fe80::1", () => {
      expect(isBlockedTarget("fe80::1", 80)).toBe(true);
    });

    it("should block IPv6 unique local", () => {
      expect(isBlockedTarget("fc00::1", 80)).toBe(true);
      expect(isBlockedTarget("fd00::1", 80)).toBe(true);
    });

    it("should allow public IPs", () => {
      expect(isBlockedTarget("8.8.8.8", 80)).toBe(false);
      expect(isBlockedTarget("1.1.1.1", 80)).toBe(false);
      expect(isBlockedTarget("93.184.216.34", 80)).toBe(false);
    });

    it("should allow hostnames (not resolved synchronously)", () => {
      expect(isBlockedTarget("example.com", 80)).toBe(false);
    });

    it("should block invalid hostname", () => {
      expect(isBlockedTarget("", 80)).toBe(true);
    });

    it("should block invalid port", () => {
      expect(isBlockedTarget("example.com", 0)).toBe(true);
      expect(isBlockedTarget("example.com", 65536)).toBe(true);
    });

    it("should block CGNAT range", () => {
      expect(isBlockedTarget("100.64.0.1", 80)).toBe(true);
    });

    it("should block documentation ranges", () => {
      expect(isBlockedTarget("192.0.2.1", 80)).toBe(true);
      expect(isBlockedTarget("198.51.100.1", 80)).toBe(true);
      expect(isBlockedTarget("203.0.113.1", 80)).toBe(true);
    });

    it("should block multicast range", () => {
      expect(isBlockedTarget("224.0.0.1", 80)).toBe(true);
    });

    it("should block IPv6 all-zeros", () => {
      expect(isBlockedTarget("::", 80)).toBe(true);
    });

    it("should block IPv6 multicast", () => {
      expect(isBlockedTarget("ff02::1", 80)).toBe(true);
    });

    it("should block IPv4-mapped IPv6 private (hex notation)", () => {
      // ::ffff:7f00:1 = ::ffff:127.0.0.1
      expect(isBlockedTarget("::ffff:7f00:1", 80)).toBe(true);
      // ::ffff:a00:1 = ::ffff:10.0.0.1
      expect(isBlockedTarget("::ffff:a00:1", 80)).toBe(true);
    });
  });

  describe("validateTarget", () => {
    it("should allow valid public IP", async () => {
      const result = await validateTarget("8.8.8.8", 80);
      expect(result.allowed).toBe(true);
    });

    it("should block private IP directly", async () => {
      const result = await validateTarget("127.0.0.1", 80);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("private/internal");
    });

    it("should block invalid hostname", async () => {
      const result = await validateTarget("", 80);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Invalid hostname");
    });

    it("should block invalid port", async () => {
      const result = await validateTarget("example.com", 0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Invalid port");
    });

    it("should resolve hostname and allow public IPs (double resolve)", async () => {
      // Both resolutions return same public IP
      mockResolve.mockResolvedValueOnce(["93.184.216.34"]);
      mockResolve.mockResolvedValueOnce(["93.184.216.34"]);
      const result = await validateTarget("example.com", 80);
      expect(result.allowed).toBe(true);
      expect(mockResolve).toHaveBeenCalledTimes(2);
    });

    it("should block hostname resolving to private IP on first resolve", async () => {
      mockResolve.mockResolvedValueOnce(["127.0.0.1"]);
      const result = await validateTarget("evil.example.com", 80);
      expect(result.allowed).toBe(false);
      // Should not reach second resolution
      expect(mockResolve).toHaveBeenCalledTimes(1);
    });

    it("should block when DNS returns empty", async () => {
      mockResolve.mockResolvedValueOnce([]);
      const result = await validateTarget("no-records.example.com", 80);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("no addresses");
    });

    it("should fall back to AAAA when A fails (both resolutions)", async () => {
      // First resolution: A fails, AAAA succeeds
      mockResolve.mockRejectedValueOnce(new Error("ENODATA"));
      mockResolve6.mockResolvedValueOnce(["2606:4700:4700::1111"]);
      // Second resolution: A fails, AAAA succeeds
      mockResolve.mockRejectedValueOnce(new Error("ENODATA"));
      mockResolve6.mockResolvedValueOnce(["2606:4700:4700::1111"]);
      const result = await validateTarget("ipv6only.example.com", 80);
      expect(result.allowed).toBe(true);
    });

    it("should block when AAAA resolves to private IPv6", async () => {
      mockResolve.mockRejectedValueOnce(new Error("ENODATA"));
      mockResolve6.mockResolvedValueOnce(["::1"]);
      const result = await validateTarget("evil-ipv6.example.com", 80);
      expect(result.allowed).toBe(false);
    });

    it("should deny when both lookups fail (fail-closed)", async () => {
      mockResolve.mockRejectedValueOnce(new Error("SERVFAIL"));
      mockResolve6.mockRejectedValueOnce(new Error("SERVFAIL"));
      const result = await validateTarget("unreachable.example.com", 80);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("DNS resolution failed");
    });

    it("should check all resolved addresses", async () => {
      mockResolve.mockResolvedValueOnce(["93.184.216.34", "10.0.0.1"]);
      const result = await validateTarget("mixed.example.com", 80);
      expect(result.allowed).toBe(false);
    });

    it("should allow when all addresses are public (both resolutions)", async () => {
      mockResolve.mockResolvedValueOnce(["93.184.216.34", "8.8.8.8"]);
      mockResolve.mockResolvedValueOnce(["93.184.216.34", "8.8.8.8"]);
      const result = await validateTarget("multi.example.com", 80);
      expect(result.allowed).toBe(true);
    });

    // DNS rebinding detection tests
    it("should detect DNS rebinding: first public, second private", async () => {
      // First resolution: public IP (passes check)
      mockResolve.mockResolvedValueOnce(["93.184.216.34"]);
      // Second resolution: private IP (would be caught by check)
      mockResolve.mockResolvedValueOnce(["127.0.0.1"]);
      const result = await validateTarget("rebinding.evil.com", 80);
      expect(result.allowed).toBe(false);
    });

    it("should detect DNS rebinding: addresses change between resolutions", async () => {
      // First resolution: public IP A
      mockResolve.mockResolvedValueOnce(["93.184.216.34"]);
      // Second resolution: different public IP (suspicious change)
      mockResolve.mockResolvedValueOnce(["1.2.3.4"]);
      const result = await validateTarget("rebinding-different.evil.com", 80);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("DNS rebinding");
    });

    it("should allow when both resolutions return same addresses", async () => {
      mockResolve.mockResolvedValueOnce(["93.184.216.34", "8.8.8.8"]);
      mockResolve.mockResolvedValueOnce(["93.184.216.34", "8.8.8.8"]);
      const result = await validateTarget("stable.example.com", 80);
      expect(result.allowed).toBe(true);
    });

    it("should block when second resolution fails (fail-closed)", async () => {
      // First resolution succeeds
      mockResolve.mockResolvedValueOnce(["93.184.216.34"]);
      // Second resolution fails
      mockResolve.mockRejectedValueOnce(new Error("SERVFAIL"));
      mockResolve6.mockRejectedValueOnce(new Error("SERVFAIL"));
      const result = await validateTarget("flaky-dns.example.com", 80);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("DNS resolution failed");
    });
  });
});
