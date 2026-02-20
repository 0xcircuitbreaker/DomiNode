import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  tools,
  plugin,
} from "./plugin.js";

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
    // Manually set it since literal __proto__ assignment doesn't create own property
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
    // Build deeply nested object
    let obj: any = { safe: true };
    for (let i = 0; i < 60; i++) {
      obj = { child: obj };
    }
    // Should not throw
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
// Plugin Structure
// =========================================================================

describe("plugin structure", () => {
  it("exports exactly 21 tools", () => {
    expect(tools).toHaveLength(21);
  });

  it("has correct plugin metadata", () => {
    expect(plugin.name).toBe("dominusnode-proxy");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.description).toBeTruthy();
    expect(plugin.tools).toBe(tools);
  });

  it("all tools have name, description, parameters, execute", () => {
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("tool names are unique", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("contains expected tool names", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("proxied_fetch");
    expect(names).toContain("check_balance");
    expect(names).toContain("check_usage");
    expect(names).toContain("get_proxy_config");
    expect(names).toContain("list_sessions");
    expect(names).toContain("create_agentic_wallet");
    expect(names).toContain("fund_agentic_wallet");
    expect(names).toContain("check_agentic_balance");
    expect(names).toContain("list_agentic_wallets");
    expect(names).toContain("agentic_transactions");
    expect(names).toContain("freeze_agentic_wallet");
    expect(names).toContain("unfreeze_agentic_wallet");
    expect(names).toContain("delete_agentic_wallet");
    expect(names).toContain("create_team");
    expect(names).toContain("list_teams");
    expect(names).toContain("team_details");
    expect(names).toContain("team_fund");
    expect(names).toContain("team_create_key");
    expect(names).toContain("team_usage");
  });
});

// =========================================================================
// Tool Execution — proxied_fetch
// =========================================================================

describe("proxied_fetch tool", () => {
  const fetchTool = tools.find((t) => t.name === "proxied_fetch")!;
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = process.env.DOMINUSNODE_API_KEY;
    process.env.DOMINUSNODE_API_KEY = "dn_test_abc123";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.DOMINUSNODE_API_KEY = originalEnv;
    } else {
      delete process.env.DOMINUSNODE_API_KEY;
    }
  });

  it("rejects missing url", async () => {
    const result = await fetchTool.execute({});
    expect(result).toContain("Error");
    expect(result).toContain("url");
  });

  it("rejects localhost URLs", async () => {
    const result = await fetchTool.execute({ url: "http://localhost:3000/api" });
    expect(result).toContain("Error");
    expect(result).toContain("localhost");
  });

  it("rejects private IP URLs", async () => {
    const result = await fetchTool.execute({ url: "http://192.168.1.1/admin" });
    expect(result).toContain("Error");
    expect(result).toMatch(/private/i);
  });

  it("rejects file:// protocol", async () => {
    const result = await fetchTool.execute({ url: "file:///etc/passwd" });
    expect(result).toContain("Error");
  });

  it("blocks POST method", async () => {
    const result = await fetchTool.execute({
      url: "https://example.com",
      method: "POST",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not allowed");
  });

  it("blocks PUT method", async () => {
    const result = await fetchTool.execute({
      url: "https://example.com",
      method: "PUT",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not allowed");
  });

  it("blocks DELETE method", async () => {
    const result = await fetchTool.execute({
      url: "https://example.com",
      method: "DELETE",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not allowed");
  });

  it("ignores unknown body parameter on GET requests", async () => {
    // body parameter was removed (H-7: dead param since only GET/HEAD/OPTIONS allowed)
    // Passing it should be harmlessly ignored, triggering proxy connect (not a body-rejection error)
    const result = await fetchTool.execute({
      url: "https://example.com",
      method: "GET",
      body: "some data",
    });
    // Should NOT contain "not allowed" — body is simply ignored
    expect(result).not.toContain("not allowed");
  });

  it("ignores unknown body parameter on HEAD requests", async () => {
    const result = await fetchTool.execute({
      url: "https://example.com",
      method: "HEAD",
      body: "data",
    });
    expect(result).not.toContain("not allowed");
  });

  it("ignores unknown body parameter on OPTIONS requests", async () => {
    const result = await fetchTool.execute({
      url: "https://example.com",
      method: "OPTIONS",
      body: "data",
    });
    expect(result).not.toContain("not allowed");
  });

  it("blocks OFAC sanctioned country", async () => {
    const result = await fetchTool.execute({
      url: "https://example.com",
      country: "RU",
    });
    expect(result).toContain("Error");
    expect(result).toContain("OFAC");
  });

  it("rejects CRLF injection in headers", async () => {
    const result = await fetchTool.execute({
      url: "https://example.com",
      headers: { "X-Evil\r\n": "bad" },
    });
    expect(result).toContain("Error");
    expect(result).toContain("invalid characters");
  });

  it("rejects cloud metadata URL", async () => {
    const result = await fetchTool.execute({
      url: "http://169.254.169.254/latest/meta-data/",
    });
    expect(result).toContain("Error");
    expect(result).toMatch(/private/i);
  });
});

// =========================================================================
// Tool Execution — create_agentic_wallet
// =========================================================================

describe("create_agentic_wallet tool", () => {
  const tool = tools.find((t) => t.name === "create_agentic_wallet")!;

  it("rejects empty label", async () => {
    const result = await tool.execute({ label: "" });
    expect(result).toContain("Error");
    expect(result).toContain("label");
  });

  it("rejects label with control characters", async () => {
    const result = await tool.execute({
      label: "test\x00wallet",
      spending_limit_cents: 100,
    });
    expect(result).toContain("Error");
    expect(result).toContain("control characters");
  });

  it("rejects label exceeding 100 characters", async () => {
    const result = await tool.execute({
      label: "a".repeat(101),
      spending_limit_cents: 100,
    });
    expect(result).toContain("Error");
    expect(result).toContain("1-100");
  });
});

// =========================================================================
// Tool Execution — fund_agentic_wallet
// =========================================================================

describe("fund_agentic_wallet tool", () => {
  const tool = tools.find((t) => t.name === "fund_agentic_wallet")!;

  it("rejects invalid UUID", async () => {
    const result = await tool.execute({
      wallet_id: "not-a-uuid",
      amount_cents: 100,
    });
    expect(result).toContain("Error");
    expect(result).toContain("wallet_id");
  });

  it("rejects amount below 100 cents", async () => {
    const result = await tool.execute({
      wallet_id: "550e8400-e29b-41d4-a716-446655440000",
      amount_cents: 50,
    });
    expect(result).toContain("Error");
    expect(result).toContain("100");
  });

  it("rejects amount above 1000000 cents", async () => {
    const result = await tool.execute({
      wallet_id: "550e8400-e29b-41d4-a716-446655440000",
      amount_cents: 1000001,
    });
    expect(result).toContain("Error");
  });

  it("rejects non-integer amount", async () => {
    const result = await tool.execute({
      wallet_id: "550e8400-e29b-41d4-a716-446655440000",
      amount_cents: 100.5,
    });
    expect(result).toContain("Error");
  });
});

// =========================================================================
// Tool Execution — create_team
// =========================================================================

describe("create_team tool", () => {
  const tool = tools.find((t) => t.name === "create_team")!;

  it("rejects empty name", async () => {
    const result = await tool.execute({ name: "" });
    expect(result).toContain("Error");
    expect(result).toContain("name");
  });

  it("rejects name with control characters", async () => {
    const result = await tool.execute({ name: "team\x07name" });
    expect(result).toContain("Error");
    expect(result).toContain("control characters");
  });

  it("rejects max_members below 1", async () => {
    const result = await tool.execute({ name: "test", max_members: 0 });
    expect(result).toContain("Error");
    expect(result).toContain("max_members");
  });

  it("rejects max_members above 100", async () => {
    const result = await tool.execute({ name: "test", max_members: 101 });
    expect(result).toContain("Error");
    expect(result).toContain("max_members");
  });

  it("rejects non-integer max_members", async () => {
    const result = await tool.execute({ name: "test", max_members: 5.5 });
    expect(result).toContain("Error");
    expect(result).toContain("max_members");
  });
});

// =========================================================================
// Tool Execution — team_create_key
// =========================================================================

describe("team_create_key tool", () => {
  const tool = tools.find((t) => t.name === "team_create_key")!;

  it("rejects missing team_id", async () => {
    const result = await tool.execute({
      label: "production",
    });
    expect(result).toContain("Error");
  });

  it("rejects invalid UUID team_id", async () => {
    const result = await tool.execute({
      team_id: "bad",
      label: "production",
    });
    expect(result).toContain("Error");
    expect(result).toContain("team_id");
  });

  it("rejects empty label", async () => {
    const result = await tool.execute({
      team_id: "550e8400-e29b-41d4-a716-446655440000",
      label: "",
    });
    expect(result).toContain("Error");
    expect(result).toContain("label");
  });

  it("rejects label with control characters", async () => {
    const result = await tool.execute({
      team_id: "550e8400-e29b-41d4-a716-446655440000",
      label: "test\x01key",
    });
    expect(result).toContain("Error");
    expect(result).toContain("control characters");
  });
});

// =========================================================================
// Tool Execution — team_fund
// =========================================================================

describe("team_fund tool", () => {
  const tool = tools.find((t) => t.name === "team_fund")!;

  it("rejects invalid UUID team_id", async () => {
    const result = await tool.execute({
      team_id: "bad",
      amount_cents: 500,
    });
    expect(result).toContain("Error");
    expect(result).toContain("team_id");
  });

  it("rejects amount below 100", async () => {
    const result = await tool.execute({
      team_id: "550e8400-e29b-41d4-a716-446655440000",
      amount_cents: 50,
    });
    expect(result).toContain("Error");
  });

  it("rejects amount above 1000000", async () => {
    const result = await tool.execute({
      team_id: "550e8400-e29b-41d4-a716-446655440000",
      amount_cents: 1000001,
    });
    expect(result).toContain("Error");
  });
});
