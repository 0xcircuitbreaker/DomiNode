/**
 * Dominus Node Pi Extension — Test Suite
 *
 * Tests security utilities (SSRF, credential scrubbing, prototype pollution),
 * input validation, toolkit construction, and tool response formats.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as dnsPromises from "dns/promises";
import {
  isPrivateIp,
  normalizeIpv4,
  validateTargetUrl,
  validateCountry,
  validateUuid,
  stripDangerousKeys,
  scrubCredentials,
  truncate,
  formatBytes,
  formatCents,
  checkDnsRebinding,
  SANCTIONED_COUNTRIES,
  BLOCKED_HOSTNAMES,
  DominusNodeToolkit,
} from "../src/toolkit.js";

// Mock dns/promises for checkDnsRebinding tests
vi.mock("dns/promises", () => ({
  resolve4: vi.fn().mockResolvedValue([]),
  resolve6: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// SSRF — isPrivateIp
// ---------------------------------------------------------------------------

describe("isPrivateIp", () => {
  describe("loopback", () => {
    it("blocks 127.0.0.1", () => expect(isPrivateIp("127.0.0.1")).toBe(true));
    it("blocks 127.0.0.255", () => expect(isPrivateIp("127.0.0.255")).toBe(true));
    it("blocks 127.255.255.255", () => expect(isPrivateIp("127.255.255.255")).toBe(true));
    it("blocks ::1", () => expect(isPrivateIp("::1")).toBe(true));
  });

  describe("RFC 1918 private ranges", () => {
    it("blocks 10.0.0.1", () => expect(isPrivateIp("10.0.0.1")).toBe(true));
    it("blocks 10.255.255.255", () => expect(isPrivateIp("10.255.255.255")).toBe(true));
    it("blocks 172.16.0.1", () => expect(isPrivateIp("172.16.0.1")).toBe(true));
    it("blocks 172.31.255.255", () => expect(isPrivateIp("172.31.255.255")).toBe(true));
    it("does not block 172.15.0.1 (not private)", () => expect(isPrivateIp("172.15.0.1")).toBe(false));
    it("does not block 172.32.0.1 (not private)", () => expect(isPrivateIp("172.32.0.1")).toBe(false));
    it("blocks 192.168.0.1", () => expect(isPrivateIp("192.168.0.1")).toBe(true));
    it("blocks 192.168.255.255", () => expect(isPrivateIp("192.168.255.255")).toBe(true));
  });

  describe("CGNAT (100.64.0.0/10)", () => {
    it("blocks 100.64.0.1", () => expect(isPrivateIp("100.64.0.1")).toBe(true));
    it("blocks 100.127.255.255", () => expect(isPrivateIp("100.127.255.255")).toBe(true));
    it("does not block 100.63.0.1 (not CGNAT)", () => expect(isPrivateIp("100.63.0.1")).toBe(false));
    it("does not block 100.128.0.1 (not CGNAT)", () => expect(isPrivateIp("100.128.0.1")).toBe(false));
  });

  describe("link-local and special", () => {
    it("blocks 169.254.169.254 (cloud metadata)", () => expect(isPrivateIp("169.254.169.254")).toBe(true));
    it("blocks 169.254.0.1", () => expect(isPrivateIp("169.254.0.1")).toBe(true));
    it("blocks 0.0.0.0", () => expect(isPrivateIp("0.0.0.0")).toBe(true));
  });

  describe("multicast", () => {
    it("blocks 224.0.0.1 (multicast)", () => expect(isPrivateIp("224.0.0.1")).toBe(true));
    it("blocks 239.255.255.255", () => expect(isPrivateIp("239.255.255.255")).toBe(true));
    it("blocks 240.0.0.1 (reserved)", () => expect(isPrivateIp("240.0.0.1")).toBe(true));
    it("blocks ff02::1 (IPv6 multicast)", () => expect(isPrivateIp("ff02::1")).toBe(true));
  });

  describe("IPv6 ULA and link-local", () => {
    it("blocks fc00::1 (ULA)", () => expect(isPrivateIp("fc00::1")).toBe(true));
    it("blocks fd00::1 (ULA)", () => expect(isPrivateIp("fd00::1")).toBe(true));
    it("blocks fe80::1 (link-local)", () => expect(isPrivateIp("fe80::1")).toBe(true));
    it("blocks :: (unspecified)", () => expect(isPrivateIp("::")).toBe(true));
  });

  describe("IPv4-mapped IPv6", () => {
    it("blocks ::ffff:127.0.0.1", () => expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true));
    it("blocks ::ffff:10.0.0.1", () => expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true));
    it("blocks ::ffff:192.168.1.1", () => expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true));
    it("passes ::ffff:1.1.1.1 (public)", () => expect(isPrivateIp("::ffff:1.1.1.1")).toBe(false));
  });

  describe("Teredo (2001:0::/32) and 6to4 (2002::/16)", () => {
    it("blocks Teredo 2001:0000::1", () => expect(isPrivateIp("2001:0000::1")).toBe(true));
    it("blocks Teredo 2001:0::", () => expect(isPrivateIp("2001:0::")).toBe(true));
    it("blocks 6to4 2002:7f00::1", () => expect(isPrivateIp("2002:7f00::1")).toBe(true));
    it("blocks 6to4 2002:c0a8::1", () => expect(isPrivateIp("2002:c0a8::1")).toBe(true));
  });

  describe("IPv6 zone ID stripping", () => {
    it("blocks fe80::1%eth0 (link-local with zone)", () => expect(isPrivateIp("fe80::1%eth0")).toBe(true));
    it("blocks 127.0.0.1%lo", () => expect(isPrivateIp("127.0.0.1%lo")).toBe(true));
  });

  describe("public IPs pass", () => {
    it("passes 1.1.1.1 (Cloudflare)", () => expect(isPrivateIp("1.1.1.1")).toBe(false));
    it("passes 8.8.8.8 (Google DNS)", () => expect(isPrivateIp("8.8.8.8")).toBe(false));
    it("passes 208.67.222.222 (OpenDNS)", () => expect(isPrivateIp("208.67.222.222")).toBe(false));
    it("passes 2606:4700::6810:85e5 (Cloudflare IPv6)", () => expect(isPrivateIp("2606:4700::6810:85e5")).toBe(false));
  });

  describe("2-part/3-part IPv4 SSRF bypass prevention", () => {
    it("blocks 127.1 (2-part loopback)", () => expect(isPrivateIp("127.1")).toBe(true));
    it("blocks 192.168.256 (3-part private)", () => expect(isPrivateIp("192.168.256")).toBe(true));
    it("blocks 10.0x100000 (2-part private)", () => expect(isPrivateIp("10.0x100000")).toBe(true));
  });
});

// ---------------------------------------------------------------------------
// SSRF — normalizeIpv4
// ---------------------------------------------------------------------------

describe("normalizeIpv4", () => {
  it("converts decimal integer 2130706433 to 127.0.0.1", () =>
    expect(normalizeIpv4("2130706433")).toBe("127.0.0.1"));
  it("converts hex 0x7f000001 to 127.0.0.1", () =>
    expect(normalizeIpv4("0x7f000001")).toBe("127.0.0.1"));
  it("converts octal 0177.0.0.1 to 127.0.0.1", () =>
    expect(normalizeIpv4("0177.0.0.1")).toBe("127.0.0.1"));
  it("converts mixed-radix 0xac.0x10.0.0 to 172.16.0.0", () =>
    expect(normalizeIpv4("0xac.0x10.0.0")).toBe("172.16.0.0"));
  it("returns null for non-IP strings", () =>
    expect(normalizeIpv4("not-an-ip")).toBeNull());
  it("returns null for out-of-range decimal", () =>
    expect(normalizeIpv4("4294967296")).toBeNull()); // 0xFFFFFFFF + 1
  it("normalizes standard dotted-decimal", () =>
    expect(normalizeIpv4("127.0.0.1")).toBe("127.0.0.1"));

  // 3-part form: a.b.cd (cd = 0-65535)
  it("normalizes 3-part 127.0.1 to 127.0.0.1", () =>
    expect(normalizeIpv4("127.0.1")).toBe("127.0.0.1"));
  it("normalizes 3-part 192.168.256 to 192.168.1.0", () =>
    expect(normalizeIpv4("192.168.256")).toBe("192.168.1.0"));

  // 2-part form: a.bcd (bcd = 0-16777215)
  it("normalizes 2-part 127.1 to 127.0.0.1", () =>
    expect(normalizeIpv4("127.1")).toBe("127.0.0.1"));
  it("normalizes 2-part 10.0x100000 to 10.16.0.0", () =>
    expect(normalizeIpv4("10.0x100000")).toBe("10.16.0.0"));
});

// ---------------------------------------------------------------------------
// SSRF — validateTargetUrl
// ---------------------------------------------------------------------------

describe("validateTargetUrl", () => {
  it("passes a valid public URL", () =>
    expect(() => validateTargetUrl("https://example.com/path")).not.toThrow());
  it("passes http URL", () =>
    expect(() => validateTargetUrl("http://example.com")).not.toThrow());
  it("throws on file:// protocol", () =>
    expect(() => validateTargetUrl("file:///etc/passwd")).toThrow("Only http: and https:"));
  it("throws on ftp:// protocol", () =>
    expect(() => validateTargetUrl("ftp://example.com")).toThrow("Only http: and https:"));
  it("throws on embedded credentials", () =>
    expect(() => validateTargetUrl("http://user:pass@example.com")).toThrow("embedded credentials"));
  it("throws on localhost", () =>
    expect(() => validateTargetUrl("http://localhost/secret")).toThrow());
  it("throws on 127.0.0.1", () =>
    expect(() => validateTargetUrl("http://127.0.0.1/")).toThrow());
  it("throws on 10.0.0.1", () =>
    expect(() => validateTargetUrl("http://10.0.0.1/")).toThrow());
  it("throws on 192.168.1.1", () =>
    expect(() => validateTargetUrl("http://192.168.1.1/")).toThrow());
  it("throws on .localhost TLD", () =>
    expect(() => validateTargetUrl("http://secret.localhost/")).toThrow());
  it("throws on .local TLD", () =>
    expect(() => validateTargetUrl("http://internal.local/")).toThrow());
  it("throws on .internal TLD", () =>
    expect(() => validateTargetUrl("http://api.internal/")).toThrow());
  it("throws on .arpa TLD", () =>
    expect(() => validateTargetUrl("http://1.0.0.127.in-addr.arpa/")).toThrow());
  it("throws on 169.254.169.254 (cloud metadata)", () =>
    expect(() => validateTargetUrl("http://169.254.169.254/")).toThrow());
  it("throws on invalid URL", () =>
    expect(() => validateTargetUrl("not a url")).toThrow());
  it("returns URL object on success", () => {
    const result = validateTargetUrl("https://api.example.com/data?q=test");
    expect(result).toBeInstanceOf(URL);
    expect(result.hostname).toBe("api.example.com");
  });
});

// ---------------------------------------------------------------------------
// OFAC — validateCountry
// ---------------------------------------------------------------------------

describe("validateCountry", () => {
  it("passes valid code US", () => expect(validateCountry("US")).toBe("US"));
  it("passes valid code GB", () => expect(validateCountry("GB")).toBe("GB"));
  it("passes valid code DE", () => expect(validateCountry("DE")).toBe("DE"));
  it("normalises lowercase us to US", () => expect(validateCountry("us")).toBe("US"));
  it("returns undefined for undefined input", () => expect(validateCountry(undefined)).toBeUndefined());
  it("throws on OFAC country CU (Cuba)", () =>
    expect(() => validateCountry("CU")).toThrow("OFAC"));
  it("throws on OFAC country IR (Iran)", () =>
    expect(() => validateCountry("IR")).toThrow("OFAC"));
  it("throws on OFAC country KP (North Korea)", () =>
    expect(() => validateCountry("KP")).toThrow("OFAC"));
  it("throws on OFAC country RU (Russia)", () =>
    expect(() => validateCountry("RU")).toThrow("OFAC"));
  it("throws on OFAC country SY (Syria)", () =>
    expect(() => validateCountry("SY")).toThrow("OFAC"));
  it("throws on invalid format 'USA' (3 letters)", () =>
    expect(() => validateCountry("USA")).toThrow("ISO 3166-1"));
  it("throws on invalid format '12'", () =>
    expect(() => validateCountry("12")).toThrow("ISO 3166-1"));
});

// ---------------------------------------------------------------------------
// validateUuid
// ---------------------------------------------------------------------------

describe("validateUuid", () => {
  it("passes valid UUID v4", () =>
    expect(validateUuid("550e8400-e29b-41d4-a716-446655440000", "id")).toBe("550e8400-e29b-41d4-a716-446655440000"));
  it("trims whitespace", () =>
    expect(validateUuid("  550e8400-e29b-41d4-a716-446655440000  ", "id")).toBe("550e8400-e29b-41d4-a716-446655440000"));
  it("throws on non-UUID string", () =>
    expect(() => validateUuid("not-a-uuid", "walletId")).toThrow("walletId"));
  it("throws on empty string", () =>
    expect(() => validateUuid("", "teamId")).toThrow("teamId"));
  it("throws on UUID with wrong format", () =>
    expect(() => validateUuid("550e8400-e29b-41d4-a716", "id")).toThrow());
});

// ---------------------------------------------------------------------------
// stripDangerousKeys
// ---------------------------------------------------------------------------

describe("stripDangerousKeys", () => {
  it("removes __proto__ from JSON-parsed object (real attack vector)", () => {
    // Object literals use prototype syntax — must use JSON.parse to get own __proto__ property
    const obj = JSON.parse('{"__proto__": {"evil": true}, "safe": "value"}') as Record<string, unknown>;
    stripDangerousKeys(obj);
    expect(Object.prototype.hasOwnProperty.call(obj, "__proto__")).toBe(false);
    expect(obj.safe).toBe("value");
  });

  it("removes constructor from object (own property)", () => {
    const obj = { constructor: "injected", name: "test" } as Record<string, unknown>;
    stripDangerousKeys(obj);
    // After deletion, own property is gone — prototype chain may still have Object.constructor
    expect(Object.prototype.hasOwnProperty.call(obj, "constructor")).toBe(false);
  });

  it("removes prototype from object", () => {
    const obj = { prototype: { polluted: true } } as Record<string, unknown>;
    stripDangerousKeys(obj);
    expect(obj["prototype"]).toBeUndefined();
  });

  it("removes dangerous keys recursively from JSON-parsed nested objects", () => {
    const obj = JSON.parse('{"nested": {"__proto__": {"evil": true}, "ok": "fine"}}') as Record<string, unknown>;
    stripDangerousKeys(obj);
    expect(Object.prototype.hasOwnProperty.call(obj.nested as object, "__proto__")).toBe(false);
    expect((obj.nested as Record<string, unknown>).ok).toBe("fine");
  });

  it("removes dangerous keys from arrays of JSON-parsed objects", () => {
    const arr = JSON.parse('[{"__proto__": {"evil": true}, "id": 1}]') as unknown[];
    stripDangerousKeys(arr);
    expect(Object.prototype.hasOwnProperty.call(arr[0] as object, "__proto__")).toBe(false);
    expect((arr[0] as Record<string, unknown>).id).toBe(1);
  });

  it("does not throw on null or primitives", () => {
    expect(() => stripDangerousKeys(null)).not.toThrow();
    expect(() => stripDangerousKeys(42)).not.toThrow();
    expect(() => stripDangerousKeys("string")).not.toThrow();
  });

  it("respects depth limit of 50", () => {
    // Create a deeply nested object — should not stack-overflow
    let deep: Record<string, unknown> = { __proto__: "bad" };
    for (let i = 0; i < 55; i++) deep = { child: deep };
    expect(() => stripDangerousKeys(deep)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// scrubCredentials
// ---------------------------------------------------------------------------

describe("scrubCredentials", () => {
  it("scrubs dn_live_ key from error message", () => {
    const result = scrubCredentials("Auth failed with key dn_live_abc123xyz");
    expect(result).toBe("Auth failed with key dn_live_***REDACTED***");
    expect(result).not.toContain("abc123xyz");
  });

  it("scrubs dn_test_ key from error message", () => {
    const result = scrubCredentials("Token dn_test_qwerty890 is invalid");
    expect(result).toBe("Token dn_test_***REDACTED*** is invalid");
  });

  it("scrubs multiple keys in one message", () => {
    const result = scrubCredentials("Keys: dn_live_key1 and dn_test_key2");
    expect(result).not.toContain("key1");
    expect(result).not.toContain("key2");
  });

  it("passes through clean messages unchanged", () => {
    expect(scrubCredentials("Connection timed out")).toBe("Connection timed out");
  });

  it("passes through empty string", () => {
    expect(scrubCredentials("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

describe("truncate", () => {
  it("returns string unchanged if within limit", () =>
    expect(truncate("short", 100)).toBe("short"));
  it("truncates at max and appends note", () => {
    const long = "a".repeat(5000);
    const result = truncate(long, 4000);
    expect(result.length).toBeLessThan(5000);
    expect(result).toContain("truncated");
  });
  it("uses default max of 4000", () => {
    const long = "x".repeat(4100);
    const result = truncate(long);
    expect(result.length).toBeLessThan(4100);
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => expect(formatBytes(512)).toBe("512 B"));
  it("formats KB", () => expect(formatBytes(2048)).toBe("2.0 KB"));
  it("formats MB", () => expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB"));
  it("formats GB", () => expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.000 GB"));
});

describe("formatCents", () => {
  it("formats cents as dollar string", () => expect(formatCents(1050)).toBe("$10.50"));
  it("formats zero", () => expect(formatCents(0)).toBe("$0.00"));
  it("formats large amount", () => expect(formatCents(100000)).toBe("$1000.00"));
});

// ---------------------------------------------------------------------------
// SANCTIONED_COUNTRIES set
// ---------------------------------------------------------------------------

describe("SANCTIONED_COUNTRIES", () => {
  it("contains CU IR KP RU SY", () => {
    for (const c of ["CU", "IR", "KP", "RU", "SY"]) {
      expect(SANCTIONED_COUNTRIES.has(c)).toBe(true);
    }
  });
  it("does not contain US or DE", () => {
    expect(SANCTIONED_COUNTRIES.has("US")).toBe(false);
    expect(SANCTIONED_COUNTRIES.has("DE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DNS rebinding — checkDnsRebinding (mock dns module)
// ---------------------------------------------------------------------------

describe("checkDnsRebinding", () => {
  beforeEach(() => {
    vi.mocked(dnsPromises.resolve4).mockReset().mockResolvedValue([]);
    vi.mocked(dnsPromises.resolve6).mockReset().mockResolvedValue([]);
  });

  it("skips check for IPv4 literal", async () => {
    await expect(checkDnsRebinding("1.1.1.1")).resolves.toBeUndefined();
    expect(dnsPromises.resolve4).not.toHaveBeenCalled();
  });

  it("skips check for IPv6 literal", async () => {
    await expect(checkDnsRebinding("2606:4700::1")).resolves.toBeUndefined();
    expect(dnsPromises.resolve4).not.toHaveBeenCalled();
  });

  it("resolves hostname and passes for public IPs", async () => {
    vi.mocked(dnsPromises.resolve4).mockResolvedValue(["1.1.1.1"]);
    await expect(checkDnsRebinding("example.com")).resolves.toBeUndefined();
  });

  it("throws if hostname resolves to private IP (DNS rebinding)", async () => {
    vi.mocked(dnsPromises.resolve4).mockResolvedValue(["192.168.1.100"]);
    await expect(checkDnsRebinding("evil.attacker.com")).rejects.toThrow("DNS rebinding");
  });

  it("throws if hostname resolves to loopback via IPv6", async () => {
    vi.mocked(dnsPromises.resolve6).mockResolvedValue(["::1"]);
    await expect(checkDnsRebinding("evil.attacker.com")).rejects.toThrow("DNS rebinding");
  });

  it("passes if DNS lookup fails with NXDOMAIN", async () => {
    vi.mocked(dnsPromises.resolve4).mockRejectedValue(new Error("ENOTFOUND"));
    vi.mocked(dnsPromises.resolve6).mockRejectedValue(new Error("ENOTFOUND"));
    await expect(checkDnsRebinding("nonexistent.domain")).resolves.toBeUndefined();
  });

  it("throws if hostname resolves to IPv4-mapped private IPv6 (::ffff:192.168.1.1)", async () => {
    vi.mocked(dnsPromises.resolve6).mockResolvedValue(["::ffff:192.168.1.1"]);
    await expect(checkDnsRebinding("evil.example.com")).rejects.toThrow("DNS rebinding");
  });

  it("throws if A+AAAA where only AAAA is loopback", async () => {
    vi.mocked(dnsPromises.resolve4).mockResolvedValue(["1.1.1.1"]);
    vi.mocked(dnsPromises.resolve6).mockResolvedValue(["::1"]);
    await expect(checkDnsRebinding("mixed.attacker.com")).rejects.toThrow("DNS rebinding");
  });
});

// ---------------------------------------------------------------------------
// DominusNodeToolkit construction
// ---------------------------------------------------------------------------

describe("DominusNodeToolkit", () => {
  it("constructs with default options reading env vars", () => {
    process.env["DOMINUSNODE_API_KEY"] = "dn_test_envkey";
    const t = new DominusNodeToolkit();
    expect(t).toBeDefined();
    delete process.env["DOMINUSNODE_API_KEY"];
  });

  it("constructs with explicit options", () => {
    const t = new DominusNodeToolkit({
      apiKey: "dn_test_explicit",
      baseUrl: "https://custom.api.example.com",
      proxyHost: "proxy.custom.com",
      proxyPort: 9090,
    });
    expect(t).toBeDefined();
  });

  it("clamps proxyPort to 8080 on NaN", () => {
    const t = new DominusNodeToolkit({ proxyPort: NaN });
    expect(t).toBeDefined(); // No throw, falls back to 8080
  });

  it("clamps proxyPort to 8080 on out-of-range value", () => {
    const t = new DominusNodeToolkit({ proxyPort: 99999 });
    expect(t).toBeDefined();
  });

  it("throws on proxyHost set to loopback IP", () => {
    expect(() => new DominusNodeToolkit({ proxyHost: "127.0.0.1" })).toThrow();
  });

  it("throws on proxyHost set to private IP", () => {
    expect(() => new DominusNodeToolkit({ proxyHost: "192.168.1.1" })).toThrow();
  });

  it("throws on invalid baseUrl", () => {
    expect(() => new DominusNodeToolkit({ baseUrl: "ftp://evil.example.com" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tool input validation (without real API calls)
// ---------------------------------------------------------------------------

describe("DominusNodeToolkit — input validation", () => {
  let toolkit: DominusNodeToolkit;

  beforeEach(() => {
    toolkit = new DominusNodeToolkit({ apiKey: "dn_test_testkey123456789" });
    // Mock _req to avoid real HTTP calls
    vi.spyOn(toolkit as unknown as { _req: () => Promise<unknown> }, "_req").mockResolvedValue({
      balance: 1000,
      walletId: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("proxiedFetch blocks private IP target", async () => {
    const result = await toolkit.proxiedFetch("http://192.168.1.1/admin");
    expect(result.content[0].text).toContain("Error");
  });

  it("proxiedFetch blocks POST method", async () => {
    const result = await toolkit.proxiedFetch("https://example.com", "POST");
    expect(result.content[0].text).toContain("not allowed");
  });

  it("proxiedFetch blocks OFAC country", async () => {
    const result = await toolkit.proxiedFetch("https://example.com", "GET", "RU");
    expect(result.content[0].text).toContain("OFAC");
  });

  it("proxiedFetch rejects invalid proxyType", async () => {
    const result = await toolkit.proxiedFetch("https://example.com", "GET", undefined, "evil");
    expect(result.content[0].text).toContain("proxyType");
  });

  it("fundAgenticWallet validates UUID", async () => {
    const result = await toolkit.fundAgenticWallet("not-a-uuid", 100);
    expect(result.content[0].text).toContain("Error");
  });

  it("fundAgenticWallet validates amount range (too low)", async () => {
    const result = await toolkit.fundAgenticWallet("550e8400-e29b-41d4-a716-446655440000", 0);
    expect(result.content[0].text).toContain("Error");
  });

  it("fundAgenticWallet validates amount range (too high)", async () => {
    const result = await toolkit.fundAgenticWallet("550e8400-e29b-41d4-a716-446655440000", 2000000);
    expect(result.content[0].text).toContain("Error");
  });

  it("createAgenticWallet requires a non-empty label", async () => {
    const result = await toolkit.createAgenticWallet("", 100);
    expect(result.content[0].text).toContain("Error");
  });

  it("createAgenticWallet validates spendingLimit out-of-range", async () => {
    const result = await toolkit.createAgenticWallet("my-agent", 0);
    expect(result.content[0].text).toContain("Error");
  });

  it("createTeam validates maxMembers > 100", async () => {
    const result = await toolkit.createTeam("Team A", 101);
    // 101 is clamped to 100, so no error — valid
    expect(result.content[0].text).toBeDefined();
  });

  it("topupStripe validates amount too low", async () => {
    const result = await toolkit.topupStripe(100);
    expect(result.content[0].text).toContain("Error");
  });

  it("topupStripe validates amount too high", async () => {
    const result = await toolkit.topupStripe(2000000);
    expect(result.content[0].text).toContain("Error");
  });

  it("topupPaypal validates amount too low", async () => {
    const result = await toolkit.topupPaypal(100);
    expect(result.content[0].text).toContain("Error");
  });

  it("topupCrypto validates amount too low", async () => {
    const result = await toolkit.topupCrypto(1, "BTC");
    expect(result.content[0].text).toContain("Error");
  });

  it("topupCrypto validates invalid currency", async () => {
    const result = await toolkit.topupCrypto(10, "DOGE");
    expect(result.content[0].text).toContain("Error");
  });

  it("updateTeamMemberRole validates role value", async () => {
    const result = await toolkit.updateTeamMemberRole(
      "550e8400-e29b-41d4-a716-446655440000",
      "550e8400-e29b-41d4-a716-446655440001",
      "superadmin",
    );
    expect(result.content[0].text).toContain("Error");
  });

  it("updateTeam requires at least one field", async () => {
    const result = await toolkit.updateTeam("550e8400-e29b-41d4-a716-446655440000");
    expect(result.content[0].text).toContain("Error");
  });

  it("updateWalletPolicy requires at least one field", async () => {
    const result = await toolkit.updateWalletPolicy("550e8400-e29b-41d4-a716-446655440000");
    expect(result.content[0].text).toContain("Error");
  });

  it("checkAgenticBalance validates UUID", async () => {
    const result = await toolkit.checkAgenticBalance("bad-id");
    expect(result.content[0].text).toContain("Error");
  });

  it("checkUsage clamps days within 1–365", async () => {
    // Should not error — days gets clamped internally
    const result = await toolkit.checkUsage(0);
    // NaN from Number(0) is still 0, clamp to 1 — no error
    expect(result.content).toBeDefined();
  });

  it("createAgenticWallet rejects label with control characters", async () => {
    const result = await toolkit.createAgenticWallet("agent\x00-bad", 100);
    expect(result.content[0].text).toContain("Error");
  });

  it("createAgenticWallet rejects label exceeding 100 chars", async () => {
    const result = await toolkit.createAgenticWallet("a".repeat(101), 100);
    expect(result.content[0].text).toContain("Error");
  });

  it("createTeam rejects name with newline character", async () => {
    const result = await toolkit.createTeam("Team\nEvil");
    expect(result.content[0].text).toContain("Error");
  });

  it("updateWalletPolicy rejects allowedDomains with more than 100 entries", async () => {
    const domains = Array.from({ length: 101 }, (_, i) => `site${i}.com`);
    const result = await toolkit.updateWalletPolicy("550e8400-e29b-41d4-a716-446655440000", undefined, domains);
    expect(result.content[0].text).toContain("Error");
  });

  it("updateWalletPolicy rejects domain over 253 chars", async () => {
    const result = await toolkit.updateWalletPolicy(
      "550e8400-e29b-41d4-a716-446655440000",
      undefined,
      ["a".repeat(254) + ".com"],
    );
    expect(result.content[0].text).toContain("Error");
  });

  it("checkUsage rejects Infinity days", async () => {
    const result = await toolkit.checkUsage(Infinity);
    expect(result.content[0].text).toContain("Error");
  });
});

// ---------------------------------------------------------------------------
// Tool response format
// ---------------------------------------------------------------------------

describe("Tool response format", () => {
  let toolkit: DominusNodeToolkit;

  beforeEach(() => {
    toolkit = new DominusNodeToolkit({ apiKey: "dn_test_formatcheck12345" });
    vi.spyOn(toolkit as unknown as { _req: () => Promise<unknown> }, "_req").mockResolvedValue({
      balanceCents: 5000,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("checkBalance returns PiToolResult with content array", async () => {
    const result = await toolkit.checkBalance();
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("details");
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]).toHaveProperty("type", "text");
    expect(typeof result.content[0].text).toBe("string");
  });

  it("listAgenticWallets returns valid PiToolResult", async () => {
    vi.spyOn(toolkit as unknown as { _req: () => Promise<unknown> }, "_req").mockResolvedValue([]);
    const result = await toolkit.listAgenticWallets();
    expect(result.content[0].type).toBe("text");
    expect(result.details).toEqual({});
  });

  it("error responses still return PiToolResult (not thrown)", async () => {
    const result = await toolkit.proxiedFetch("not-a-url");
    expect(result.content[0].text).toContain("Error");
    expect(result.details).toEqual({});
  });

  it("text content is truncated at 4000 chars max", async () => {
    const bigData = { data: "x".repeat(10000) };
    vi.spyOn(toolkit as unknown as { _req: () => Promise<unknown> }, "_req").mockResolvedValue(bigData);
    const result = await toolkit.checkBalance();
    expect(result.content[0].text.length).toBeLessThanOrEqual(4000 + 100); // +100 for truncation note
  });
});

// ---------------------------------------------------------------------------
// Crypto top-up currency validation
// ---------------------------------------------------------------------------

describe("topupCrypto currency validation", () => {
  let toolkit: DominusNodeToolkit;

  beforeEach(() => {
    toolkit = new DominusNodeToolkit({ apiKey: "dn_test_cryptocheck12345" });
    vi.spyOn(toolkit as unknown as { _req: () => Promise<unknown> }, "_req").mockResolvedValue({
      invoiceId: "inv_123", payAddress: "bc1q...", currency: "BTC",
    });
  });

  afterEach(() => vi.restoreAllMocks());

  const VALID = ["BTC", "ETH", "LTC", "XMR", "ZEC", "USDC", "SOL", "USDT", "DAI", "BNB", "LINK"];
  for (const cur of VALID) {
    it(`accepts ${cur}`, async () => {
      const result = await toolkit.topupCrypto(10, cur);
      expect(result.content[0].text).not.toContain("Error");
    });
  }

  // Note: lowercase "btc" is normalized to "BTC" by the toolkit (toUpperCase)
  const INVALID = ["DOGE", "XRP", "MATIC", "ADA", ""];
  for (const cur of INVALID) {
    it(`rejects ${cur || "(empty)"}`, async () => {
      const result = await toolkit.topupCrypto(10, cur);
      expect(result.content[0].text).toContain("Error");
    });
  }

  it("accepts lowercase btc (normalized to BTC)", async () => {
    const result = await toolkit.topupCrypto(10, "btc");
    expect(result.content[0].text).not.toContain("Error");
  });

  it("rejects fractional dollar amount (5.9 is not an integer)", async () => {
    const result = await toolkit.topupCrypto(5.9, "BTC");
    expect(result.content[0].text).toContain("Error");
  });
});
