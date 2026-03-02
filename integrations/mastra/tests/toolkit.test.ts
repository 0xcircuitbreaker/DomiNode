import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dns/promises for checkDnsRebinding tests
vi.mock("dns/promises", () => ({
  resolve4: vi.fn().mockResolvedValue([]),
  resolve6: vi.fn().mockResolvedValue([]),
}));

// Mock @mastra/core/tools before importing the toolkit
vi.mock("@mastra/core/tools", () => ({
  createTool: (opts: any) => ({
    id: opts.id,
    description: opts.description,
    inputSchema: opts.inputSchema,
    outputSchema: opts.outputSchema,
    execute: opts.execute,
  }),
}));

import {
  isPrivateIp,
  validateTargetUrl,
  validateCountry,
  validateUuid,
  normalizeIpv4,
  stripDangerousKeys,
  scrubCredentials,
  truncate,
  formatBytes,
  formatCents,
  DominusNodeToolkit,
  checkDnsRebinding,
  SANCTIONED_COUNTRIES,
  BLOCKED_HOSTNAMES,
} from "../src/index.js";
import * as dnsPromises from "dns/promises";

// =========================================================================
// SSRF Protection — isPrivateIp
// =========================================================================

describe("isPrivateIp", () => {
  // IPv4 private ranges
  it("detects 127.0.0.1 as private", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
  });

  it("detects 127.0.0.2 as private", () => {
    expect(isPrivateIp("127.0.0.2")).toBe(true);
  });

  it("detects 10.0.0.0 as private", () => {
    expect(isPrivateIp("10.0.0.0")).toBe(true);
  });

  it("detects 10.255.255.255 as private", () => {
    expect(isPrivateIp("10.255.255.255")).toBe(true);
  });

  it("detects 172.16.0.1 as private", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
  });

  it("detects 172.31.255.255 as private", () => {
    expect(isPrivateIp("172.31.255.255")).toBe(true);
  });

  it("allows 172.15.255.255 (not private)", () => {
    expect(isPrivateIp("172.15.255.255")).toBe(false);
  });

  it("allows 172.32.0.1 (not private)", () => {
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });

  it("detects 192.168.0.1 as private", () => {
    expect(isPrivateIp("192.168.0.1")).toBe(true);
  });

  it("detects 169.254.169.254 (link-local / cloud metadata) as private", () => {
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

  it("allows 203.0.113.1 (public)", () => {
    expect(isPrivateIp("203.0.113.1")).toBe(false);
  });

  // IPv6 private ranges
  it("detects ::1 as private (IPv6 loopback)", () => {
    expect(isPrivateIp("::1")).toBe(true);
  });

  it("detects :: as private (IPv6 unspecified)", () => {
    expect(isPrivateIp("::")).toBe(true);
  });

  it("detects fc00::1 as private (IPv6 ULA)", () => {
    expect(isPrivateIp("fc00::1")).toBe(true);
  });

  it("detects fd12::1 as private (IPv6 ULA)", () => {
    expect(isPrivateIp("fd12::1")).toBe(true);
  });

  it("detects fe80::1 as private (IPv6 link-local)", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
  });

  // IPv6 mapped IPv4
  it("detects ::ffff:127.0.0.1 as private (IPv4-mapped)", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
  });

  it("detects ::ffff:10.0.0.1 as private (IPv4-mapped)", () => {
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
  });

  it("detects ::ffff:192.168.1.1 as private (IPv4-mapped)", () => {
    expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true);
  });

  // Hex IPv6 mapped
  it("detects ::ffff:7f00:0001 as private (hex IPv4-mapped)", () => {
    expect(isPrivateIp("::ffff:7f00:0001")).toBe(true);
  });

  // Bracketed IPv6
  it("detects [::1] as private (bracketed)", () => {
    expect(isPrivateIp("[::1]")).toBe(true);
  });

  // Zone ID stripping
  it("strips IPv6 zone ID before checking", () => {
    expect(isPrivateIp("fe80::1%eth0")).toBe(true);
  });

  it("strips zone ID with %25 encoding", () => {
    expect(isPrivateIp("fe80::1%25eth0")).toBe(true);
  });

  // IPv4-compatible IPv6
  it("detects ::127.0.0.1 as private (IPv4-compatible)", () => {
    expect(isPrivateIp("::127.0.0.1")).toBe(true);
  });

  // Teredo tunneling
  it("detects 2001:0000::1 as private (Teredo)", () => {
    expect(isPrivateIp("2001:0000::1")).toBe(true);
  });

  // 6to4 tunneling
  it("detects 2002::1 as private (6to4)", () => {
    expect(isPrivateIp("2002::1")).toBe(true);
  });
});

// =========================================================================
// SSRF Protection — normalizeIpv4
// =========================================================================

describe("normalizeIpv4", () => {
  it("normalizes decimal integer to dotted-decimal", () => {
    expect(normalizeIpv4("2130706433")).toBe("127.0.0.1");
  });

  it("normalizes hex to dotted-decimal", () => {
    expect(normalizeIpv4("0x7f000001")).toBe("127.0.0.1");
  });

  it("normalizes octal octets to dotted-decimal", () => {
    expect(normalizeIpv4("0177.0.0.1")).toBe("127.0.0.1");
  });

  it("normalizes mixed-radix octets", () => {
    expect(normalizeIpv4("0xC0.0xA8.0x01.0x01")).toBe("192.168.1.1");
  });

  it("returns null for non-IP strings", () => {
    expect(normalizeIpv4("example.com")).toBeNull();
  });

  it("returns null for out-of-range hex", () => {
    expect(normalizeIpv4("0xFFFFFFFFFF")).toBeNull();
  });

  it("handles zero correctly", () => {
    expect(normalizeIpv4("0")).toBe("0.0.0.0");
  });

  it("handles max uint32", () => {
    expect(normalizeIpv4("4294967295")).toBe("255.255.255.255");
  });
});

// =========================================================================
// SSRF Protection — validateTargetUrl
// =========================================================================

describe("validateTargetUrl", () => {
  it("accepts valid https URL", () => {
    const url = validateTargetUrl("https://httpbin.org/ip");
    expect(url.hostname).toBe("httpbin.org");
  });

  it("accepts valid http URL", () => {
    const url = validateTargetUrl("http://example.com/path?q=1");
    expect(url.hostname).toBe("example.com");
  });

  it("rejects invalid URL", () => {
    expect(() => validateTargetUrl("not-a-url")).toThrow(/Invalid URL/);
  });

  it("rejects file:// protocol", () => {
    expect(() => validateTargetUrl("file:///etc/passwd")).toThrow(/protocols/);
  });

  it("rejects ftp:// protocol", () => {
    expect(() => validateTargetUrl("ftp://ftp.example.com")).toThrow(/protocols/);
  });

  it("rejects embedded credentials", () => {
    expect(() => validateTargetUrl("http://user:pass@example.com/")).toThrow(
      /credentials/,
    );
  });

  it("rejects localhost", () => {
    expect(() => validateTargetUrl("http://localhost/secret")).toThrow(
      /localhost/,
    );
  });

  it("rejects 0.0.0.0", () => {
    expect(() => validateTargetUrl("http://0.0.0.0/")).toThrow(/localhost/);
  });

  it("rejects private IPs", () => {
    expect(() => validateTargetUrl("http://192.168.1.1/admin")).toThrow(
      /private/i,
    );
  });

  it("rejects .localhost TLD", () => {
    expect(() => validateTargetUrl("http://evil.localhost/")).toThrow(
      /localhost/,
    );
  });

  it("rejects .local hostname", () => {
    expect(() => validateTargetUrl("http://printer.local/")).toThrow(
      /internal/,
    );
  });

  it("rejects .internal hostname", () => {
    expect(() => validateTargetUrl("http://db.internal/")).toThrow(/internal/);
  });

  it("rejects .arpa hostname", () => {
    expect(() => validateTargetUrl("http://1.168.192.in-addr.arpa/")).toThrow(
      /internal/,
    );
  });

  it("rejects cloud metadata (169.254.169.254)", () => {
    expect(() =>
      validateTargetUrl("http://169.254.169.254/latest/meta-data/"),
    ).toThrow(/private/i);
  });

  it("rejects hex-encoded loopback", () => {
    expect(() => validateTargetUrl("http://0x7f000001/")).toThrow(/private/i);
  });

  it("rejects decimal-encoded loopback", () => {
    expect(() => validateTargetUrl("http://2130706433/")).toThrow(/private/i);
  });
});

// =========================================================================
// Input Validation — validateCountry
// =========================================================================

describe("validateCountry", () => {
  it("returns undefined for undefined/empty", () => {
    expect(validateCountry(undefined)).toBeUndefined();
    expect(validateCountry("")).toBeUndefined();
  });

  it("accepts valid country code", () => {
    expect(validateCountry("US")).toBe("US");
  });

  it("uppercases country code", () => {
    expect(validateCountry("gb")).toBe("GB");
  });

  it("trims whitespace", () => {
    expect(validateCountry(" DE ")).toBe("DE");
  });

  it("rejects invalid format (3 letters)", () => {
    expect(() => validateCountry("USA")).toThrow(/2-letter/);
  });

  it("rejects invalid format (numbers)", () => {
    expect(() => validateCountry("12")).toThrow(/2-letter/);
  });

  it("blocks Cuba (OFAC)", () => {
    expect(() => validateCountry("CU")).toThrow(/OFAC/);
  });

  it("blocks Iran (OFAC)", () => {
    expect(() => validateCountry("IR")).toThrow(/OFAC/);
  });

  it("blocks North Korea (OFAC)", () => {
    expect(() => validateCountry("KP")).toThrow(/OFAC/);
  });

  it("blocks Russia (OFAC)", () => {
    expect(() => validateCountry("RU")).toThrow(/OFAC/);
  });

  it("blocks Syria (OFAC)", () => {
    expect(() => validateCountry("SY")).toThrow(/OFAC/);
  });
});

// =========================================================================
// Input Validation — validateUuid
// =========================================================================

describe("validateUuid", () => {
  it("accepts valid UUID", () => {
    expect(
      validateUuid("550e8400-e29b-41d4-a716-446655440000", "wallet_id"),
    ).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("trims whitespace", () => {
    expect(
      validateUuid("  550e8400-e29b-41d4-a716-446655440000  ", "wallet_id"),
    ).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("rejects invalid UUID", () => {
    expect(() => validateUuid("not-a-uuid", "wallet_id")).toThrow(
      /Invalid wallet_id/,
    );
  });

  it("rejects empty string", () => {
    expect(() => validateUuid("", "team_id")).toThrow(/Invalid team_id/);
  });

  it("uses the label in error message", () => {
    expect(() => validateUuid("bad", "my_field")).toThrow(/Invalid my_field/);
  });
});

// =========================================================================
// Security Helpers — scrubCredentials
// =========================================================================

describe("scrubCredentials", () => {
  it("redacts dn_live_ tokens", () => {
    expect(scrubCredentials("key is dn_live_abc123xyz")).toBe(
      "key is dn_live_***REDACTED***",
    );
  });

  it("redacts dn_test_ tokens", () => {
    expect(scrubCredentials("dn_test_key456")).toBe(
      "dn_test_***REDACTED***",
    );
  });

  it("redacts multiple tokens", () => {
    const msg = "keys: dn_live_a and dn_test_b";
    const result = scrubCredentials(msg);
    expect(result).not.toContain("dn_live_a");
    expect(result).not.toContain("dn_test_b");
    expect(result).toContain("***REDACTED***");
  });

  it("leaves non-credential strings unchanged", () => {
    expect(scrubCredentials("no secrets here")).toBe("no secrets here");
  });
});

// =========================================================================
// Security Helpers — stripDangerousKeys
// =========================================================================

describe("stripDangerousKeys", () => {
  it("removes __proto__ key", () => {
    const obj = { a: 1, __proto__: { evil: true } } as any;
    Object.defineProperty(obj, "__proto__", {
      value: { evil: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    stripDangerousKeys(obj);
    expect(Object.keys(obj)).not.toContain("__proto__");
  });

  it("removes constructor key", () => {
    const obj: any = { constructor: "evil", a: 1 };
    stripDangerousKeys(obj);
    expect(Object.prototype.hasOwnProperty.call(obj, "constructor")).toBe(false);
  });

  it("removes prototype key", () => {
    const obj: any = { prototype: "evil", b: 2 };
    stripDangerousKeys(obj);
    expect(obj.prototype).toBeUndefined();
  });

  it("handles nested objects recursively", () => {
    const obj: any = { nested: { constructor: "bad", ok: true } };
    stripDangerousKeys(obj);
    expect(Object.prototype.hasOwnProperty.call(obj.nested, "constructor")).toBe(false);
    expect(obj.nested.ok).toBe(true);
  });

  it("handles arrays", () => {
    const arr: any[] = [{ constructor: "bad" }, { safe: true }];
    stripDangerousKeys(arr);
    expect(Object.prototype.hasOwnProperty.call(arr[0], "constructor")).toBe(false);
    expect(arr[1].safe).toBe(true);
  });

  it("handles null/undefined gracefully", () => {
    expect(() => stripDangerousKeys(null)).not.toThrow();
    expect(() => stripDangerousKeys(undefined)).not.toThrow();
  });

  it("handles primitives gracefully", () => {
    expect(() => stripDangerousKeys(42)).not.toThrow();
    expect(() => stripDangerousKeys("string")).not.toThrow();
  });

  it("stops at depth 50 to prevent stack overflow", () => {
    let obj: any = { safe: true };
    for (let i = 0; i < 60; i++) {
      obj = { child: obj };
    }
    expect(() => stripDangerousKeys(obj)).not.toThrow();
  });
});

// =========================================================================
// Response Truncation
// =========================================================================

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello")).toBe("hello");
  });

  it("returns exactly max-length strings unchanged", () => {
    const exact = "x".repeat(4000);
    expect(truncate(exact)).toBe(exact);
  });

  it("truncates strings exceeding max", () => {
    const long = "x".repeat(5000);
    const result = truncate(long);
    expect(result.length).toBeLessThan(5000);
    expect(result).toContain("truncated");
    expect(result).toContain("1000 chars omitted");
  });

  it("supports custom max length", () => {
    const result = truncate("hello world", 5);
    expect(result).toContain("hello");
    expect(result).toContain("truncated");
  });
});

// =========================================================================
// Formatting Helpers
// =========================================================================

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1048576)).toBe("1.00 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1073741824)).toBe("1.000 GB");
  });

  it("formats zero bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });
});

describe("formatCents", () => {
  it("formats cents to dollars", () => {
    expect(formatCents(500)).toBe("$5.00");
  });

  it("formats zero", () => {
    expect(formatCents(0)).toBe("$0.00");
  });

  it("formats sub-dollar amounts", () => {
    expect(formatCents(99)).toBe("$0.99");
  });

  it("formats large amounts", () => {
    expect(formatCents(1000000)).toBe("$10000.00");
  });
});

// =========================================================================
// Toolkit Structure
// =========================================================================

describe("DominusNodeToolkit structure", () => {
  const toolkit = new DominusNodeToolkit({ apiKey: "dn_test_abc123" });
  const tools = toolkit.getTools();

  it("exports exactly 26 tools", () => {
    expect(tools).toHaveLength(26);
  });

  it("all tools have id, description, and execute", () => {
    for (const tool of tools) {
      expect((tool as any).id).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("tool ids are unique", () => {
    const ids = tools.map((t: any) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("contains expected tool ids", () => {
    const ids = tools.map((t: any) => t.id);
    expect(ids).toContain("dominusnode_proxied_fetch");
    expect(ids).toContain("dominusnode_check_balance");
    expect(ids).toContain("dominusnode_check_usage");
    expect(ids).toContain("dominusnode_get_proxy_config");
    expect(ids).toContain("dominusnode_list_sessions");
    expect(ids).toContain("dominusnode_create_agentic_wallet");
    expect(ids).toContain("dominusnode_fund_agentic_wallet");
    expect(ids).toContain("dominusnode_agentic_wallet_balance");
    expect(ids).toContain("dominusnode_list_agentic_wallets");
    expect(ids).toContain("dominusnode_agentic_transactions");
    expect(ids).toContain("dominusnode_freeze_agentic_wallet");
    expect(ids).toContain("dominusnode_unfreeze_agentic_wallet");
    expect(ids).toContain("dominusnode_delete_agentic_wallet");
    expect(ids).toContain("dominusnode_update_wallet_policy");
    expect(ids).toContain("dominusnode_create_team");
    expect(ids).toContain("dominusnode_list_teams");
    expect(ids).toContain("dominusnode_team_details");
    expect(ids).toContain("dominusnode_team_fund");
    expect(ids).toContain("dominusnode_team_create_key");
    expect(ids).toContain("dominusnode_team_usage");
    expect(ids).toContain("dominusnode_update_team");
    expect(ids).toContain("dominusnode_update_team_member_role");
    expect(ids).toContain("dominusnode_topup_paypal");
    expect(ids).toContain("dominusnode_topup_stripe");
    expect(ids).toContain("dominusnode_topup_crypto");
    expect(ids).toContain("dominusnode_x402_info");
  });

  it("all tool ids start with dominusnode_", () => {
    for (const tool of tools) {
      expect((tool as any).id).toMatch(/^dominusnode_/);
    }
  });
});

// =========================================================================
// Tool Execution — proxied_fetch
// =========================================================================

describe("proxied_fetch tool", () => {
  const toolkit = new DominusNodeToolkit({ apiKey: "dn_test_abc123" });
  const tools = toolkit.getTools();
  const fetchTool = tools.find((t: any) => t.id === "dominusnode_proxied_fetch")!;

  it("rejects localhost URLs", async () => {
    const result = await fetchTool.execute({ context: { url: "http://localhost:3000/api" } });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("localhost");
  });

  it("rejects private IP URLs", async () => {
    const result = await fetchTool.execute({ context: { url: "http://192.168.1.1/admin" } });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/private/i);
  });

  it("rejects file:// protocol", async () => {
    const result = await fetchTool.execute({ context: { url: "file:///etc/passwd" } });
    expect(result.error).toBeDefined();
  });

  it("blocks POST method", async () => {
    const result = await fetchTool.execute({
      context: { url: "https://example.com", method: "POST" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("not allowed");
  });

  it("blocks PUT method", async () => {
    const result = await fetchTool.execute({
      context: { url: "https://example.com", method: "PUT" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("not allowed");
  });

  it("blocks DELETE method", async () => {
    const result = await fetchTool.execute({
      context: { url: "https://example.com", method: "DELETE" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("not allowed");
  });

  it("blocks OFAC sanctioned country", async () => {
    const result = await fetchTool.execute({
      context: { url: "https://example.com", country: "RU" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("OFAC");
  });

  it("rejects cloud metadata URL", async () => {
    const result = await fetchTool.execute({
      context: { url: "http://169.254.169.254/latest/meta-data/" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/private/i);
  });

  it("rejects embedded credentials in URL", async () => {
    const result = await fetchTool.execute({
      context: { url: "http://user:pass@example.com/" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("credentials");
  });

  it("rejects .localhost TLD", async () => {
    const result = await fetchTool.execute({
      context: { url: "http://evil.localhost/" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("localhost");
  });

  it("rejects hex-encoded loopback", async () => {
    const result = await fetchTool.execute({
      context: { url: "http://0x7f000001/" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/private/i);
  });
});

// =========================================================================
// Tool Execution — create_agentic_wallet
// =========================================================================

describe("create_agentic_wallet tool", () => {
  const toolkit = new DominusNodeToolkit({ apiKey: "dn_test_abc123" });
  const tools = toolkit.getTools();
  const tool = tools.find((t: any) => t.id === "dominusnode_create_agentic_wallet")!;

  it("rejects empty label", async () => {
    const result = await tool.execute({ context: { label: "", spendingLimitCents: 100 } });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("label");
  });

  it("rejects label with control characters", async () => {
    const result = await tool.execute({
      context: { label: "test\x00wallet", spendingLimitCents: 100 },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("control characters");
  });

  it("rejects label exceeding 100 characters", async () => {
    const result = await tool.execute({
      context: { label: "a".repeat(101), spendingLimitCents: 100 },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("1-100");
  });

  it("rejects dailyLimitCents below 1", async () => {
    const result = await tool.execute({
      context: { label: "test-bot", spendingLimitCents: 1000, dailyLimitCents: 0 },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("daily_limit_cents");
  });

  it("rejects dailyLimitCents above 1000000", async () => {
    const result = await tool.execute({
      context: { label: "test-bot", spendingLimitCents: 1000, dailyLimitCents: 1000001 },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("daily_limit_cents");
  });

  it("rejects non-integer dailyLimitCents", async () => {
    const result = await tool.execute({
      context: { label: "test-bot", spendingLimitCents: 1000, dailyLimitCents: 100.5 },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("daily_limit_cents");
  });

  it("rejects allowedDomains that is not an array", async () => {
    const result = await tool.execute({
      context: { label: "test-bot", spendingLimitCents: 1000, allowedDomains: "example.com" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("allowed_domains");
  });

  it("rejects allowedDomains with more than 100 entries", async () => {
    const domains = Array.from({ length: 101 }, (_, i) => `d${i}.example.com`);
    const result = await tool.execute({
      context: { label: "test-bot", spendingLimitCents: 1000, allowedDomains: domains },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("100");
  });

  it("rejects allowedDomains entry exceeding 253 chars", async () => {
    const result = await tool.execute({
      context: { label: "test-bot", spendingLimitCents: 1000, allowedDomains: ["a".repeat(254) + ".com"] },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("253");
  });
});

// =========================================================================
// Tool Execution — fund_agentic_wallet
// =========================================================================

describe("fund_agentic_wallet tool", () => {
  const toolkit = new DominusNodeToolkit({ apiKey: "dn_test_abc123" });
  const tools = toolkit.getTools();
  const tool = tools.find((t: any) => t.id === "dominusnode_fund_agentic_wallet")!;

  it("rejects invalid UUID", async () => {
    const result = await tool.execute({
      context: { walletId: "not-a-uuid", amountCents: 100 },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("wallet_id");
  });

  it("rejects amount below 100 cents", async () => {
    const result = await tool.execute({
      context: { walletId: "550e8400-e29b-41d4-a716-446655440000", amountCents: 50 },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("100");
  });

  it("rejects amount above 1000000 cents", async () => {
    const result = await tool.execute({
      context: { walletId: "550e8400-e29b-41d4-a716-446655440000", amountCents: 1000001 },
    });
    expect(result.error).toBeDefined();
  });

  it("rejects non-integer amount", async () => {
    const result = await tool.execute({
      context: { walletId: "550e8400-e29b-41d4-a716-446655440000", amountCents: 100.5 },
    });
    expect(result.error).toBeDefined();
  });
});

// =========================================================================
// Tool Execution — create_team
// =========================================================================

describe("create_team tool", () => {
  const toolkit = new DominusNodeToolkit({ apiKey: "dn_test_abc123" });
  const tools = toolkit.getTools();
  const tool = tools.find((t: any) => t.id === "dominusnode_create_team")!;

  it("rejects empty name", async () => {
    const result = await tool.execute({ context: { name: "" } });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("name");
  });

  it("rejects name with control characters", async () => {
    const result = await tool.execute({ context: { name: "team\x07name" } });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("control characters");
  });

  it("rejects maxMembers below 1", async () => {
    const result = await tool.execute({ context: { name: "test", maxMembers: 0 } });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("max_members");
  });

  it("rejects maxMembers above 100", async () => {
    const result = await tool.execute({ context: { name: "test", maxMembers: 101 } });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("max_members");
  });

  it("rejects non-integer maxMembers", async () => {
    const result = await tool.execute({ context: { name: "test", maxMembers: 5.5 } });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("max_members");
  });
});

// =========================================================================
// Tool Execution — team_create_key
// =========================================================================

describe("team_create_key tool", () => {
  const toolkit = new DominusNodeToolkit({ apiKey: "dn_test_abc123" });
  const tools = toolkit.getTools();
  const tool = tools.find((t: any) => t.id === "dominusnode_team_create_key")!;

  it("rejects invalid UUID team_id", async () => {
    const result = await tool.execute({
      context: { teamId: "bad", label: "production" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("team_id");
  });

  it("rejects empty label", async () => {
    const result = await tool.execute({
      context: { teamId: "550e8400-e29b-41d4-a716-446655440000", label: "" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("label");
  });

  it("rejects label with control characters", async () => {
    const result = await tool.execute({
      context: { teamId: "550e8400-e29b-41d4-a716-446655440000", label: "test\x01key" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("control characters");
  });
});

// =========================================================================
// Tool Execution — team_fund
// =========================================================================

describe("team_fund tool", () => {
  const toolkit = new DominusNodeToolkit({ apiKey: "dn_test_abc123" });
  const tools = toolkit.getTools();
  const tool = tools.find((t: any) => t.id === "dominusnode_team_fund")!;

  it("rejects invalid UUID team_id", async () => {
    const result = await tool.execute({
      context: { teamId: "bad", amountCents: 500 },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("team_id");
  });

  it("rejects amount below 100", async () => {
    const result = await tool.execute({
      context: { teamId: "550e8400-e29b-41d4-a716-446655440000", amountCents: 50 },
    });
    expect(result.error).toBeDefined();
  });

  it("rejects amount above 1000000", async () => {
    const result = await tool.execute({
      context: { teamId: "550e8400-e29b-41d4-a716-446655440000", amountCents: 1000001 },
    });
    expect(result.error).toBeDefined();
  });
});

// =========================================================================
// Tool Execution — update_wallet_policy
// =========================================================================

describe("update_wallet_policy tool", () => {
  const toolkit = new DominusNodeToolkit({ apiKey: "dn_test_abc123" });
  const tools = toolkit.getTools();
  const tool = tools.find((t: any) => t.id === "dominusnode_update_wallet_policy")!;

  it("rejects invalid wallet_id", async () => {
    const result = await tool.execute({
      context: { walletId: "not-a-uuid", dailyLimitCents: 5000 },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("wallet_id");
  });

  it("requires at least one policy field", async () => {
    const result = await tool.execute({
      context: { walletId: "550e8400-e29b-41d4-a716-446655440000" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("At least one");
  });

  it("rejects dailyLimitCents below 1", async () => {
    const result = await tool.execute({
      context: { walletId: "550e8400-e29b-41d4-a716-446655440000", dailyLimitCents: 0 },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("daily_limit_cents");
  });

  it("rejects dailyLimitCents above 1000000", async () => {
    const result = await tool.execute({
      context: { walletId: "550e8400-e29b-41d4-a716-446655440000", dailyLimitCents: 1000001 },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("daily_limit_cents");
  });

  it("rejects non-integer dailyLimitCents", async () => {
    const result = await tool.execute({
      context: { walletId: "550e8400-e29b-41d4-a716-446655440000", dailyLimitCents: 500.5 },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("daily_limit_cents");
  });

  it("rejects allowedDomains that is not an array", async () => {
    const result = await tool.execute({
      context: { walletId: "550e8400-e29b-41d4-a716-446655440000", allowedDomains: "example.com" },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("allowed_domains");
  });

  it("rejects allowedDomains with more than 100 entries", async () => {
    const domains = Array.from({ length: 101 }, (_, i) => `d${i}.example.com`);
    const result = await tool.execute({
      context: { walletId: "550e8400-e29b-41d4-a716-446655440000", allowedDomains: domains },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("100");
  });

  it("rejects allowedDomains entry exceeding 253 chars", async () => {
    const result = await tool.execute({
      context: { walletId: "550e8400-e29b-41d4-a716-446655440000", allowedDomains: ["a".repeat(254) + ".com"] },
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("253");
  });
});

// =========================================================================
// Tool Execution — topup_stripe
// =========================================================================

describe("topup_stripe tool", () => {
  const toolkit = new DominusNodeToolkit({ apiKey: "dn_test_abc123" });
  const tools = toolkit.getTools();
  const tool = tools.find((t: any) => t.id === "dominusnode_topup_stripe")!;

  it("rejects amount below 500 cents", async () => {
    const result = await tool.execute({ context: { amountCents: 100 } });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("500");
  });

  it("rejects amount above 100000 cents", async () => {
    const result = await tool.execute({ context: { amountCents: 100001 } });
    expect(result.error).toBeDefined();
  });

  it("rejects non-integer amount", async () => {
    const result = await tool.execute({ context: { amountCents: 500.5 } });
    expect(result.error).toBeDefined();
  });
});

// =========================================================================
// Tool Execution — topup_paypal
// =========================================================================

describe("topup_paypal tool", () => {
  const toolkit = new DominusNodeToolkit({ apiKey: "dn_test_abc123" });
  const tools = toolkit.getTools();
  const tool = tools.find((t: any) => t.id === "dominusnode_topup_paypal")!;

  it("rejects amount below 500 cents", async () => {
    const result = await tool.execute({ context: { amountCents: 100 } });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("500");
  });

  it("rejects amount above 100000 cents", async () => {
    const result = await tool.execute({ context: { amountCents: 100001 } });
    expect(result.error).toBeDefined();
  });
});

// =========================================================================
// Tool Execution — topup_crypto
// =========================================================================

describe("topup_crypto tool", () => {
  const toolkit = new DominusNodeToolkit({ apiKey: "dn_test_abc123" });
  const tools = toolkit.getTools();
  const tool = tools.find((t: any) => t.id === "dominusnode_topup_crypto")!;

  it("rejects amount below $5", async () => {
    const result = await tool.execute({ context: { amountUsd: 1, currency: "btc" } });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("5");
  });

  it("rejects amount above $1000", async () => {
    const result = await tool.execute({ context: { amountUsd: 1001, currency: "btc" } });
    expect(result.error).toBeDefined();
  });

  it("rejects NaN amount", async () => {
    const result = await tool.execute({ context: { amountUsd: NaN, currency: "btc" } });
    expect(result.error).toBeDefined();
  });

  it("rejects invalid currency", async () => {
    const result = await tool.execute({ context: { amountUsd: 10, currency: "doge" } });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("currency");
  });

  it("accepts valid crypto currencies", async () => {
    // Valid currencies pass validation; the tool then fails at API call level (no server)
    for (const cur of ["btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb", "link"]) {
      const result = await tool.execute({ context: { amountUsd: 10, currency: cur } });
      // Must fail at network/auth level (not at currency validation)
      expect(result.error).toBeDefined();
      expect(result.error).not.toContain("currency must be one of");
    }
  });
});

// =========================================================================
// Constants
// =========================================================================

describe("SANCTIONED_COUNTRIES", () => {
  it("contains all OFAC countries", () => {
    expect(SANCTIONED_COUNTRIES.has("CU")).toBe(true);
    expect(SANCTIONED_COUNTRIES.has("IR")).toBe(true);
    expect(SANCTIONED_COUNTRIES.has("KP")).toBe(true);
    expect(SANCTIONED_COUNTRIES.has("RU")).toBe(true);
    expect(SANCTIONED_COUNTRIES.has("SY")).toBe(true);
  });

  it("has exactly 5 entries", () => {
    expect(SANCTIONED_COUNTRIES.size).toBe(5);
  });
});

describe("BLOCKED_HOSTNAMES", () => {
  it("contains localhost", () => {
    expect(BLOCKED_HOSTNAMES.has("localhost")).toBe(true);
  });

  it("is a non-empty Set", () => {
    expect(BLOCKED_HOSTNAMES.size).toBeGreaterThan(0);
  });
});

// =========================================================================
// SSRF Protection — checkDnsRebinding
// =========================================================================

describe("checkDnsRebinding", () => {
  beforeEach(() => {
    vi.mocked(dnsPromises.resolve4).mockReset();
    vi.mocked(dnsPromises.resolve6).mockReset();
  });

  it("throws when hostname resolves to private IPv4 (10.x)", async () => {
    vi.mocked(dnsPromises.resolve4).mockResolvedValueOnce(["10.0.0.1"]);
    vi.mocked(dnsPromises.resolve6).mockRejectedValueOnce(new Error("NODATA"));
    await expect(checkDnsRebinding("evil.internal.example")).rejects.toThrow(/private|internal/i);
  });

  it("throws when hostname resolves to loopback (127.0.0.1)", async () => {
    vi.mocked(dnsPromises.resolve4).mockResolvedValueOnce(["127.0.0.1"]);
    vi.mocked(dnsPromises.resolve6).mockRejectedValueOnce(new Error("NODATA"));
    await expect(checkDnsRebinding("rebind.attacker.com")).rejects.toThrow();
  });

  it("throws when hostname resolves to link-local (169.254.x)", async () => {
    vi.mocked(dnsPromises.resolve4).mockResolvedValueOnce(["169.254.169.254"]);
    vi.mocked(dnsPromises.resolve6).mockRejectedValueOnce(new Error("NODATA"));
    await expect(checkDnsRebinding("metadata.attacker.com")).rejects.toThrow(/private/i);
  });

  it("resolves for hostname returning a public IP", async () => {
    vi.mocked(dnsPromises.resolve4).mockResolvedValueOnce(["93.184.216.34"]);
    vi.mocked(dnsPromises.resolve6).mockRejectedValueOnce(new Error("NODATA"));
    await expect(checkDnsRebinding("example.com")).resolves.toBeUndefined();
  });

  it("skips DNS lookup for IPv4 literals", async () => {
    await expect(checkDnsRebinding("93.184.216.34")).resolves.toBeUndefined();
    expect(dnsPromises.resolve4).not.toHaveBeenCalled();
  });

  it("skips DNS lookup for IPv6 literals", async () => {
    await expect(checkDnsRebinding("[2001:db8::1]")).resolves.toBeUndefined();
    expect(dnsPromises.resolve4).not.toHaveBeenCalled();
  });
});
