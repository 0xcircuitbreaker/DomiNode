import { describe, it, expect } from "vitest";
import { normalizeIpv4, isPrivateIp, validateUrl } from "../src/shared/ssrf";

// ===========================================================================
// normalizeIpv4
// ===========================================================================

describe("normalizeIpv4", () => {
  it("normalizes decimal integer to dotted-decimal", () => {
    expect(normalizeIpv4("2130706433")).toBe("127.0.0.1");
  });

  it("normalizes hex to dotted-decimal", () => {
    expect(normalizeIpv4("0x7f000001")).toBe("127.0.0.1");
  });

  it("normalizes octal octets", () => {
    expect(normalizeIpv4("0177.0.0.1")).toBe("127.0.0.1");
  });

  it("normalizes mixed-radix hex octets", () => {
    expect(normalizeIpv4("0xC0.0xA8.0x01.0x01")).toBe("192.168.1.1");
  });

  it("returns null for hostnames", () => {
    expect(normalizeIpv4("example.com")).toBeNull();
  });

  it("handles zero", () => {
    expect(normalizeIpv4("0")).toBe("0.0.0.0");
  });

  it("handles max uint32", () => {
    expect(normalizeIpv4("4294967295")).toBe("255.255.255.255");
  });

  it("returns null for out-of-range", () => {
    expect(normalizeIpv4("4294967296")).toBeNull();
  });
});

// ===========================================================================
// isPrivateIp
// ===========================================================================

describe("isPrivateIp", () => {
  // IPv4 private ranges
  it("detects 127.0.0.1 as private", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
  });

  it("detects 10.0.0.0 as private", () => {
    expect(isPrivateIp("10.0.0.0")).toBe(true);
  });

  it("detects 172.16.0.1 as private", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
  });

  it("allows 172.15.0.1 (not private)", () => {
    expect(isPrivateIp("172.15.0.1")).toBe(false);
  });

  it("detects 192.168.0.1 as private", () => {
    expect(isPrivateIp("192.168.0.1")).toBe(true);
  });

  it("detects 169.254.169.254 (link-local/cloud metadata) as private", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });

  it("detects 0.0.0.0 as private", () => {
    expect(isPrivateIp("0.0.0.0")).toBe(true);
  });

  // CGNAT
  it("detects 100.64.0.1 (CGNAT) as private", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
  });

  it("detects 100.127.255.255 (CGNAT upper) as private", () => {
    expect(isPrivateIp("100.127.255.255")).toBe(true);
  });

  it("allows 100.63.255.255 (below CGNAT)", () => {
    expect(isPrivateIp("100.63.255.255")).toBe(false);
  });

  // Multicast
  it("detects 224.0.0.1 (multicast) as private", () => {
    expect(isPrivateIp("224.0.0.1")).toBe(true);
  });

  it("detects 255.255.255.255 (broadcast) as private", () => {
    expect(isPrivateIp("255.255.255.255")).toBe(true);
  });

  // Public IPs
  it("allows 8.8.8.8 (public)", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("allows 1.1.1.1 (public)", () => {
    expect(isPrivateIp("1.1.1.1")).toBe(false);
  });

  // IPv6
  it("detects ::1 as private", () => {
    expect(isPrivateIp("::1")).toBe(true);
  });

  it("detects :: as private", () => {
    expect(isPrivateIp("::")).toBe(true);
  });

  it("detects fc00::1 as private (ULA)", () => {
    expect(isPrivateIp("fc00::1")).toBe(true);
  });

  it("detects fe80::1 as private (link-local)", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
  });

  // IPv4-mapped IPv6
  it("detects ::ffff:127.0.0.1 as private", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
  });

  it("detects ::ffff:7f00:0001 as private (hex form)", () => {
    expect(isPrivateIp("::ffff:7f00:0001")).toBe(true);
  });

  // IPv4-compatible IPv6
  it("detects ::127.0.0.1 (IPv4-compatible) as private", () => {
    expect(isPrivateIp("::127.0.0.1")).toBe(true);
  });

  // Bracketed IPv6
  it("handles [::1] bracketed form", () => {
    expect(isPrivateIp("[::1]")).toBe(true);
  });

  // Zone ID
  it("strips IPv6 zone ID", () => {
    expect(isPrivateIp("fe80::1%eth0")).toBe(true);
  });

  // Teredo (2001:0000::/32) — inverted IPv4 in last 32 bits
  it("detects Teredo embedding private IPv4", () => {
    // Teredo inverts bits: to embed 127.0.0.1 (7f.00.00.01), inverted = 80.ff.ff.fe
    // But we check the INVERTED result, so embedding 80ff:fffe should decode to 127.0.0.1
    expect(isPrivateIp("2001:0000:0000:0000:0000:0000:80ff:fffe")).toBe(true);
  });

  // 6to4 (2002::/16)
  it("detects 6to4 embedding private IPv4 (127.0.0.1)", () => {
    // 127.0.0.1 = 7f00:0001
    expect(isPrivateIp("2002:7f00:0001::1")).toBe(true);
  });

  it("detects 6to4 embedding 10.0.0.1", () => {
    // 10.0.0.1 = 0a00:0001
    expect(isPrivateIp("2002:0a00:0001::1")).toBe(true);
  });
});

// ===========================================================================
// validateUrl
// ===========================================================================

describe("validateUrl", () => {
  it("accepts valid https URL", () => {
    const parsed = validateUrl("https://httpbin.org/ip");
    expect(parsed.hostname).toBe("httpbin.org");
  });

  it("accepts valid http URL", () => {
    const parsed = validateUrl("http://example.com/path");
    expect(parsed.hostname).toBe("example.com");
  });

  it("rejects invalid URL", () => {
    expect(() => validateUrl("not-a-url")).toThrow(/Invalid URL/);
  });

  it("rejects file:// protocol", () => {
    expect(() => validateUrl("file:///etc/passwd")).toThrow(/protocols/);
  });

  it("rejects ftp:// protocol", () => {
    expect(() => validateUrl("ftp://ftp.example.com")).toThrow(/protocols/);
  });

  it("rejects localhost", () => {
    expect(() => validateUrl("http://localhost/secret")).toThrow(/localhost/);
  });

  it("rejects 0.0.0.0", () => {
    expect(() => validateUrl("http://0.0.0.0/")).toThrow(/localhost/);
  });

  it("rejects private IPs", () => {
    expect(() => validateUrl("http://192.168.1.1/admin")).toThrow(/private/i);
  });

  it("rejects .localhost TLD", () => {
    expect(() => validateUrl("http://evil.localhost/")).toThrow(/localhost/);
  });

  it("rejects .local hostname", () => {
    expect(() => validateUrl("http://printer.local/")).toThrow(/internal/);
  });

  it("rejects .internal hostname", () => {
    expect(() => validateUrl("http://db.internal/")).toThrow(/internal/);
  });

  it("rejects .arpa hostname", () => {
    expect(() => validateUrl("http://1.168.192.in-addr.arpa/")).toThrow(/internal/);
  });

  it("rejects embedded credentials", () => {
    expect(() => validateUrl("http://user:pass@example.com/")).toThrow(/credentials/);
  });

  it("rejects cloud metadata endpoint", () => {
    expect(() => validateUrl("http://169.254.169.254/latest/meta-data/")).toThrow(/blocked/i);
    expect(() => validateUrl("http://metadata.google.internal/computeMetadata/v1/")).toThrow(/blocked/i);
  });

  it("rejects hex-encoded loopback", () => {
    expect(() => validateUrl("http://0x7f000001/")).toThrow(/private/i);
  });

  it("rejects decimal-encoded loopback", () => {
    expect(() => validateUrl("http://2130706433/")).toThrow(/private/i);
  });
});
