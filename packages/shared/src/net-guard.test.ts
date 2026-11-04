import { describe, it, expect, vi, beforeEach } from "vitest";

const mockResolve4 = vi.fn();
const mockResolve6 = vi.fn();

vi.mock("node:dns", () => ({
  promises: {
    resolve4: (...args: unknown[]) => mockResolve4(...args),
    resolve6: (...args: unknown[]) => mockResolve6(...args),
  },
}));

import {
  isValidHostname,
  isValidPort,
  isBlockedIp,
  isBlockedIPv6,
  isBlockedPort,
  isBlockedTarget,
  isPublicAddress,
  resolveAndCheck,
} from "./net-guard.js";

describe("shared/net-guard floor (DESIGN §14)", () => {
  beforeEach(() => {
    mockResolve4.mockReset();
    mockResolve6.mockReset();
  });

  describe("IPv4 ranges", () => {
    it.each([
      "127.0.0.1", "127.255.255.254", // 127/8
      "10.0.0.1", "10.255.255.255", // 10/8
      "172.16.0.1", "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", "169.254.1.1", // metadata + link-local
      "100.64.0.1", "100.127.255.255", // CGNAT
      "0.0.0.0", "224.0.0.1", "255.255.255.255", "240.0.0.1",
    ])("blocks %s", (ip) => {
      expect(isBlockedIp(ip)).toBe(true);
      expect(isPublicAddress(ip)).toBe(false);
      expect(isBlockedTarget(ip, 443)).toBe(true);
    });

    it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.128.0.1"])(
      "allows public %s",
      (ip) => {
        expect(isBlockedIp(ip)).toBe(false);
        expect(isPublicAddress(ip)).toBe(true);
      },
    );
  });

  describe("IPv6 forms", () => {
    it.each([
      "::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1",
      "fd00:ec2::254", // AWS IMDS v6
      "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", // mapped
      "::127.0.0.1", "::10.0.0.1", "::7f00:1", // IPv4-compatible
      "::ffff:169.254.169.254",
      // Teredo: client IPv4 XOR 0xff — 127.0.0.1 -> 80ff:fffe, 10.0.0.1 -> f5ff:fffe
      "2001:0:4136:e378:8000:63bf:80ff:fffe",
      "2001:0:4136:e378:8000:63bf:f5ff:fffe",
      // 6to4: 2002:AABB:CCDD:: -> 127.0.0.1 / 10.0.0.1 / 192.168.1.1
      "2002:7f00:1::1", "2002:a00:1::", "2002:c0a8:101::1",
      "fe80::1%eth0",
    ])("blocks %s", (ip) => {
      expect(isBlockedIp(ip)).toBe(true);
      expect(isPublicAddress(ip)).toBe(false);
    });

    it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "2002:808:808::1", "[2606:4700:4700::1111]"])(
      "allows public %s",
      (ip) => expect(isPublicAddress(ip)).toBe(true),
    );
  });

  describe("hostnames", () => {
    it.each([
      "localhost", "localhost.", "LOCALHOST", "foo.localhost", "printer.local",
      "metadata.google.internal", "1.0.0.127.in-addr.arpa",
      "0x7f000001", "0177.0.0.1", "2130706433", "127.1", "0x7f.0.0.1", "10.1",
      "1.2.3.4.", "foo.127", "", "a..b", "-bad.com", "evil.com/", "a b.com",
    ])("rejects %j", (h) => {
      expect(isValidHostname(h)).toBe(false);
      expect(isBlockedTarget(h, 443)).toBe(true);
    });

    it.each(["example.com", "httpbin.org", "a-b.co.uk", "xn--bcher-kva.de", "1.1.1.1", "::1"])(
      "accepts syntax of %j",
      (h) => expect(isValidHostname(h)).toBe(true),
    );

    it("rejects over-long hostnames and labels", () => {
      expect(isValidHostname("a".repeat(254))).toBe(false);
      expect(isValidHostname(`${"a".repeat(64)}.com`)).toBe(false);
    });
  });

  describe("ports", () => {
    it("validates range", () => {
      expect(isValidPort(0)).toBe(false);
      expect(isValidPort(65536)).toBe(false);
      expect(isValidPort(1.5)).toBe(false);
      expect(isValidPort(NaN)).toBe(false);
      expect(isValidPort(443)).toBe(true);
    });
  });

  describe("isPublicAddress fail-closed", () => {
    it.each(["", "example.com", "not-an-ip", "999.1.1.1"])("returns false for %j", (v) => {
      expect(isPublicAddress(v)).toBe(false);
    });
  });

  describe("resolveAndCheck", () => {
    it("allows when all A+AAAA are public", async () => {
      mockResolve4.mockResolvedValueOnce(["93.184.216.34"]);
      mockResolve6.mockResolvedValueOnce(["2606:2800:220:1::1"]);
      const r = await resolveAndCheck("example.com");
      expect(r.allowed).toBe(true);
      expect(r.addresses).toEqual(["93.184.216.34", "2606:2800:220:1::1"]);
      expect(mockResolve4).toHaveBeenCalledTimes(1);
      expect(mockResolve6).toHaveBeenCalledTimes(1);
    });

    it("rejects if ANY A record is blocked", async () => {
      mockResolve4.mockResolvedValueOnce(["93.184.216.34", "10.0.0.1"]);
      mockResolve6.mockRejectedValueOnce(new Error("ENODATA"));
      expect((await resolveAndCheck("mixed.example.com")).allowed).toBe(false);
    });

    it("rejects if A is public but AAAA is blocked", async () => {
      mockResolve4.mockResolvedValueOnce(["93.184.216.34"]);
      mockResolve6.mockResolvedValueOnce(["::1"]);
      expect((await resolveAndCheck("sneaky.example.com")).allowed).toBe(false);
    });

    it("rejects metadata address via DNS", async () => {
      mockResolve4.mockResolvedValueOnce(["169.254.169.254"]);
      mockResolve6.mockResolvedValueOnce(["fd00:ec2::254"]);
      expect((await resolveAndCheck("meta.example.com")).allowed).toBe(false);
    });

    it("fails closed when both lookups fail", async () => {
      mockResolve4.mockRejectedValueOnce(new Error("SERVFAIL"));
      mockResolve6.mockRejectedValueOnce(new Error("SERVFAIL"));
      const r = await resolveAndCheck("down.example.com");
      expect(r).toEqual({ allowed: false, reason: "DNS resolution failed" });
    });

    it("fails closed on empty answers", async () => {
      mockResolve4.mockResolvedValueOnce([]);
      mockResolve6.mockRejectedValueOnce(new Error("ENODATA"));
      expect((await resolveAndCheck("empty.example.com")).reason).toContain("no addresses");
    });

    it("rejects invalid hostnames without DNS", async () => {
      expect((await resolveAndCheck("localhost.")).allowed).toBe(false);
      expect((await resolveAndCheck("0x7f000001")).allowed).toBe(false);
      expect(mockResolve4).not.toHaveBeenCalled();
    });

    it("checks IP literals directly", async () => {
      expect((await resolveAndCheck("127.0.0.1")).allowed).toBe(false);
      expect((await resolveAndCheck("::127.0.0.1")).allowed).toBe(false);
      expect((await resolveAndCheck("8.8.8.8")).allowed).toBe(true);
      expect(mockResolve4).not.toHaveBeenCalled();
    });
  });

  describe("review regressions", () => {
    it("rejects uppercase hex IP forms", () => {
      expect(isValidHostname("0X7F000001")).toBe(false);
      expect(isValidHostname("0X7f.0.0.1")).toBe(false);
      expect(isValidHostname("a.0XFF")).toBe(false);
      expect(isBlockedTarget("0X7F000001", 80)).toBe(true);
    });
    it("blocks NAT64 prefixes", () => {
      expect(isBlockedIPv6("64:ff9b::7f00:1")).toBe(true);
      expect(isBlockedIPv6("64:ff9b::a00:1")).toBe(true);
      expect(isBlockedIPv6("64:ff9b:1::808:808")).toBe(true);
      expect(isPublicAddress("64:ff9b::7f00:1")).toBe(false);
    });
    it("blocks all Teredo addresses incl. server field", () => {
      expect(isBlockedIPv6("2001:0:7f00:1::")).toBe(true);
      expect(isBlockedIPv6("2001:0:a00:1::")).toBe(true);
    });
    it("blocks port 25", () => {
      expect(isBlockedPort(25)).toBe(true);
      expect(isBlockedPort(443)).toBe(false);
      expect(isBlockedTarget("example.com", 25)).toBe(true);
      expect(isBlockedTarget("example.com", 443)).toBe(false);
    });
  });
});
