import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isPrivateIp,
  validateUrl,
  normalizeIpv4,
  sanitizeError,
  stripDangerousKeys,
  safeJsonParse,
  createDominusNodeFunctionHandler,
  type DominusNodeFunctionConfig,
} from "./handler.js";

// =========================================================================
// SSRF Protection -- isPrivateIp
// =========================================================================

describe("isPrivateIp", () => {
  // IPv4 private ranges
  it("detects 127.0.0.1 as private", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
  });

  it("detects 10.0.0.1 as private", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
  });

  it("detects 172.16.0.1 as private", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
  });

  it("detects 192.168.1.1 as private", () => {
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });

  it("detects 0.0.0.0 as private", () => {
    expect(isPrivateIp("0.0.0.0")).toBe(true);
  });

  it("detects 169.254.169.254 (link-local) as private", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });

  it("detects 100.64.0.1 (CGNAT) as private", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
  });

  it("detects 224.0.0.1 (multicast) as private", () => {
    expect(isPrivateIp("224.0.0.1")).toBe(true);
  });

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

  it("detects ::ffff:127.0.0.1 as private", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
  });

  it("detects ::ffff:7f00:0001 as private (hex form)", () => {
    expect(isPrivateIp("::ffff:7f00:0001")).toBe(true);
  });

  it("detects fe80::1 as private (link-local)", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
  });

  it("handles [::1] bracketed form", () => {
    expect(isPrivateIp("[::1]")).toBe(true);
  });

  it("strips IPv6 zone ID", () => {
    expect(isPrivateIp("fe80::1%eth0")).toBe(true);
  });
});

// =========================================================================
// SSRF Protection -- normalizeIpv4
// =========================================================================

describe("normalizeIpv4", () => {
  it("normalizes decimal integer to dotted-decimal (2130706433)", () => {
    expect(normalizeIpv4("2130706433")).toBe("127.0.0.1");
  });

  it("normalizes hex to dotted-decimal (0x7f000001)", () => {
    expect(normalizeIpv4("0x7f000001")).toBe("127.0.0.1");
  });

  it("normalizes octal octets (0177.0.0.1)", () => {
    expect(normalizeIpv4("0177.0.0.1")).toBe("127.0.0.1");
  });

  it("normalizes mixed-radix hex octets", () => {
    expect(normalizeIpv4("0xC0.0xA8.0x01.0x01")).toBe("192.168.1.1");
  });

  it("returns null for hostnames", () => {
    expect(normalizeIpv4("example.com")).toBeNull();
  });

  it("handles 0", () => {
    expect(normalizeIpv4("0")).toBe("0.0.0.0");
  });

  it("handles max uint32", () => {
    expect(normalizeIpv4("4294967295")).toBe("255.255.255.255");
  });

  it("returns null for out-of-range", () => {
    expect(normalizeIpv4("4294967296")).toBeNull();
  });
});

// =========================================================================
// SSRF Protection -- validateUrl
// =========================================================================

describe("validateUrl", () => {
  it("accepts valid https URL", () => {
    const parsed = validateUrl("https://httpbin.org/ip");
    expect(parsed.hostname).toBe("httpbin.org");
  });

  it("accepts valid http URL", () => {
    const parsed = validateUrl("http://example.com/path");
    expect(parsed.hostname).toBe("example.com");
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
    expect(() => validateUrl("http://1.168.192.in-addr.arpa/")).toThrow(
      /internal/,
    );
  });

  it("rejects embedded credentials", () => {
    expect(() => validateUrl("http://user:pass@example.com/")).toThrow(
      /credentials/,
    );
  });

  it("rejects cloud metadata endpoint", () => {
    expect(() =>
      validateUrl("http://169.254.169.254/latest/meta-data/"),
    ).toThrow(/blocked/i);
    expect(() =>
      validateUrl("http://metadata.google.internal/computeMetadata/v1/"),
    ).toThrow(/blocked/i);
  });

  it("rejects hex-encoded loopback", () => {
    expect(() => validateUrl("http://0x7f000001/")).toThrow(/private/i);
  });

  it("rejects decimal-encoded loopback", () => {
    expect(() => validateUrl("http://2130706433/")).toThrow(/private/i);
  });
});

// =========================================================================
// Credential Sanitization
// =========================================================================

describe("sanitizeError", () => {
  it("redacts dn_live_ tokens", () => {
    expect(sanitizeError("failed with dn_live_abc123key")).toBe(
      "failed with ***",
    );
  });

  it("redacts dn_test_ tokens", () => {
    expect(sanitizeError("error at dn_test_xyz789")).toBe("error at ***");
  });

  it("redacts multiple tokens", () => {
    const result = sanitizeError("keys: dn_live_a and dn_test_b");
    expect(result).not.toContain("dn_live_a");
    expect(result).not.toContain("dn_test_b");
  });

  it("leaves non-credential strings unchanged", () => {
    expect(sanitizeError("no secrets here")).toBe("no secrets here");
  });

  it("handles empty string", () => {
    expect(sanitizeError("")).toBe("");
  });
});

// =========================================================================
// Prototype Pollution Prevention
// =========================================================================

describe("stripDangerousKeys", () => {
  it("removes constructor key", () => {
    const obj: any = { constructor: "evil", a: 1 };
    stripDangerousKeys(obj);
    expect(Object.prototype.hasOwnProperty.call(obj, "constructor")).toBe(false);
    expect(obj.a).toBe(1);
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

  it("handles null/undefined", () => {
    expect(() => stripDangerousKeys(null)).not.toThrow();
    expect(() => stripDangerousKeys(undefined)).not.toThrow();
  });

  it("handles primitives", () => {
    expect(() => stripDangerousKeys(42)).not.toThrow();
    expect(() => stripDangerousKeys("string")).not.toThrow();
  });

  it("stops at depth 50", () => {
    let obj: any = { safe: true };
    for (let i = 0; i < 60; i++) {
      obj = { child: obj };
    }
    expect(() => stripDangerousKeys(obj)).not.toThrow();
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    const result = safeJsonParse<{ a: number }>('{"a": 1}');
    expect(result.a).toBe(1);
  });

  it("strips dangerous keys from parsed JSON", () => {
    const result = safeJsonParse<any>('{"constructor": "evil", "a": 1}');
    expect(Object.prototype.hasOwnProperty.call(result, "constructor")).toBe(false);
    expect(result.a).toBe(1);
  });

  it("throws on invalid JSON", () => {
    expect(() => safeJsonParse("not json")).toThrow();
  });
});

// =========================================================================
// Handler Factory
// =========================================================================

describe("createDominusNodeFunctionHandler", () => {
  it("throws on missing apiKey", () => {
    expect(() =>
      createDominusNodeFunctionHandler({ apiKey: "" }),
    ).toThrow(/apiKey is required/);
  });

  it("throws on non-string apiKey", () => {
    expect(() =>
      createDominusNodeFunctionHandler({ apiKey: null as any }),
    ).toThrow(/apiKey is required/);
  });

  it("returns a function", () => {
    const handler = createDominusNodeFunctionHandler({
      apiKey: "dn_test_abc123",
    });
    expect(typeof handler).toBe("function");
  });

  it("accepts custom baseUrl and timeoutMs", () => {
    const handler = createDominusNodeFunctionHandler({
      apiKey: "dn_test_abc123",
      baseUrl: "http://localhost:3000",
      timeoutMs: 5000,
    });
    expect(typeof handler).toBe("function");
  });
});

// =========================================================================
// Dispatch Table -- handler dispatching
// =========================================================================

describe("handler dispatching", () => {
  let handler: (name: string, args: Record<string, unknown>) => Promise<string>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Mock fetch for auth
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: any) => {
      if (typeof url === "string" && url.includes("/api/auth/verify-key")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('{"token": "jwt-mock-token"}'),
          headers: new Headers({ "content-length": "30" }),
        });
      }
      // Default: mock API call success
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"success": true}'),
        headers: new Headers({ "content-length": "20" }),
      });
    });

    handler = createDominusNodeFunctionHandler({
      apiKey: "dn_test_abc123",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns error for unknown function", async () => {
    const result = JSON.parse(await handler("unknown_function", {}));
    expect(result.error).toContain("Unknown function");
    expect(result.available).toBeDefined();
    expect(Array.isArray(result.available)).toBe(true);
  });

  it("dispatches dominusnode_check_balance", async () => {
    const result = await handler("dominusnode_check_balance", {});
    expect(JSON.parse(result)).toHaveProperty("success");
  });

  it("dispatches dominusnode_list_teams", async () => {
    const result = await handler("dominusnode_list_teams", {});
    expect(JSON.parse(result)).toHaveProperty("success");
  });

  it("dispatches dominusnode_list_agentic_wallets", async () => {
    const result = await handler("dominusnode_list_agentic_wallets", {});
    expect(JSON.parse(result)).toHaveProperty("success");
  });

  it("dispatches dominusnode_get_proxy_config", async () => {
    const result = await handler("dominusnode_get_proxy_config", {});
    expect(JSON.parse(result)).toHaveProperty("success");
  });

  it("dispatches dominusnode_list_sessions", async () => {
    const result = await handler("dominusnode_list_sessions", {});
    expect(JSON.parse(result)).toHaveProperty("success");
  });

  it("handler has all 26 functions", async () => {
    const result = JSON.parse(await handler("nonexistent", {}));
    expect(result.available).toHaveLength(26);
  });

  it("handler available list includes all expected names", async () => {
    const result = JSON.parse(await handler("nonexistent", {}));
    const expected = [
      "dominusnode_proxied_fetch",
      "dominusnode_check_balance",
      "dominusnode_check_usage",
      "dominusnode_get_proxy_config",
      "dominusnode_list_sessions",
      "dominusnode_create_agentic_wallet",
      "dominusnode_fund_agentic_wallet",
      "dominusnode_agentic_wallet_balance",
      "dominusnode_list_agentic_wallets",
      "dominusnode_agentic_transactions",
      "dominusnode_freeze_agentic_wallet",
      "dominusnode_unfreeze_agentic_wallet",
      "dominusnode_delete_agentic_wallet",
      "dominusnode_create_team",
      "dominusnode_list_teams",
      "dominusnode_team_details",
      "dominusnode_team_fund",
      "dominusnode_team_create_key",
      "dominusnode_team_usage",
      "dominusnode_update_team",
      "dominusnode_update_team_member_role",
      "dominusnode_topup_paypal",
      "dominusnode_topup_stripe",
      "dominusnode_topup_crypto",
      "dominusnode_update_wallet_policy",
    ];
    for (const name of expected) {
      expect(result.available).toContain(name);
    }
  });
});

// =========================================================================
// Input Validation -- per-handler
// =========================================================================

describe("handler input validation", () => {
  let handler: (name: string, args: Record<string, unknown>) => Promise<string>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/api/auth/verify-key")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('{"token": "jwt-mock-token"}'),
          headers: new Headers({ "content-length": "30" }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"success": true}'),
        headers: new Headers({ "content-length": "20" }),
      });
    });

    handler = createDominusNodeFunctionHandler({
      apiKey: "dn_test_abc123",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // proxied_fetch
  it("proxied_fetch rejects missing url", async () => {
    const result = JSON.parse(
      await handler("dominusnode_proxied_fetch", {}),
    );
    expect(result.error).toContain("url");
  });

  it("proxied_fetch rejects localhost", async () => {
    const result = JSON.parse(
      await handler("dominusnode_proxied_fetch", {
        url: "http://localhost/secret",
      }),
    );
    expect(result.error).toContain("localhost");
  });

  it("proxied_fetch rejects private IP", async () => {
    const result = JSON.parse(
      await handler("dominusnode_proxied_fetch", {
        url: "http://192.168.1.1/admin",
      }),
    );
    expect(result.error).toMatch(/private/i);
  });

  it("proxied_fetch rejects OFAC country (CU)", async () => {
    const result = JSON.parse(
      await handler("dominusnode_proxied_fetch", {
        url: "https://example.com",
        country: "CU",
      }),
    );
    expect(result.error).toContain("OFAC");
  });

  it("proxied_fetch rejects OFAC country (IR)", async () => {
    const result = JSON.parse(
      await handler("dominusnode_proxied_fetch", {
        url: "https://example.com",
        country: "IR",
      }),
    );
    expect(result.error).toContain("OFAC");
  });

  it("proxied_fetch rejects OFAC country (KP)", async () => {
    const result = JSON.parse(
      await handler("dominusnode_proxied_fetch", {
        url: "https://example.com",
        country: "KP",
      }),
    );
    expect(result.error).toContain("OFAC");
  });

  it("proxied_fetch rejects OFAC country (RU)", async () => {
    const result = JSON.parse(
      await handler("dominusnode_proxied_fetch", {
        url: "https://example.com",
        country: "RU",
      }),
    );
    expect(result.error).toContain("OFAC");
  });

  it("proxied_fetch rejects OFAC country (SY)", async () => {
    const result = JSON.parse(
      await handler("dominusnode_proxied_fetch", {
        url: "https://example.com",
        country: "SY",
      }),
    );
    expect(result.error).toContain("OFAC");
  });

  it("proxied_fetch rejects POST method", async () => {
    const result = JSON.parse(
      await handler("dominusnode_proxied_fetch", {
        url: "https://example.com",
        method: "POST",
      }),
    );
    expect(result.error).toContain("not allowed");
  });

  it("proxied_fetch rejects PUT method", async () => {
    const result = JSON.parse(
      await handler("dominusnode_proxied_fetch", {
        url: "https://example.com",
        method: "PUT",
      }),
    );
    expect(result.error).toContain("not allowed");
  });

  it("proxied_fetch rejects DELETE method", async () => {
    const result = JSON.parse(
      await handler("dominusnode_proxied_fetch", {
        url: "https://example.com",
        method: "DELETE",
      }),
    );
    expect(result.error).toContain("not allowed");
  });

  // create_agentic_wallet
  it("create_agentic_wallet rejects missing label", async () => {
    const result = JSON.parse(
      await handler("dominusnode_create_agentic_wallet", {
        spending_limit_cents: 100,
      }),
    );
    expect(result.error).toContain("label");
  });

  it("create_agentic_wallet rejects long label", async () => {
    const result = JSON.parse(
      await handler("dominusnode_create_agentic_wallet", {
        label: "a".repeat(101),
        spending_limit_cents: 100,
      }),
    );
    expect(result.error).toContain("100");
  });

  it("create_agentic_wallet rejects control chars in label", async () => {
    const result = JSON.parse(
      await handler("dominusnode_create_agentic_wallet", {
        label: "test\x00label",
        spending_limit_cents: 100,
      }),
    );
    expect(result.error).toContain("control characters");
  });

  // team validation
  it("create_team rejects missing name", async () => {
    const result = JSON.parse(
      await handler("dominusnode_create_team", {}),
    );
    expect(result.error).toContain("name");
  });

  it("create_team rejects invalid max_members", async () => {
    const result = JSON.parse(
      await handler("dominusnode_create_team", {
        name: "test",
        max_members: 101,
      }),
    );
    expect(result.error).toContain("max_members");
  });

  // topup_paypal
  it("topup_paypal rejects missing amount_cents", async () => {
    const result = JSON.parse(
      await handler("dominusnode_topup_paypal", {}),
    );
    expect(result.error).toContain("amount_cents");
  });

  it("topup_paypal rejects negative amount", async () => {
    const result = JSON.parse(
      await handler("dominusnode_topup_paypal", { amount_cents: -5 }),
    );
    expect(result.error).toContain("amount_cents");
  });

  it("topup_paypal rejects zero amount", async () => {
    const result = JSON.parse(
      await handler("dominusnode_topup_paypal", { amount_cents: 0 }),
    );
    expect(result.error).toContain("amount_cents");
  });

  it("topup_paypal dispatches valid amount", async () => {
    const result = JSON.parse(
      await handler("dominusnode_topup_paypal", { amount_cents: 1000 }),
    );
    expect(result).toHaveProperty("success");
  });

  // team_fund
  it("team_fund rejects amount below 100", async () => {
    const result = JSON.parse(
      await handler("dominusnode_team_fund", {
        team_id: "550e8400-e29b-41d4-a716-446655440000",
        amount_cents: 50,
      }),
    );
    expect(result.error).toContain("amount_cents");
  });

  it("team_fund rejects amount above 1000000", async () => {
    const result = JSON.parse(
      await handler("dominusnode_team_fund", {
        team_id: "550e8400-e29b-41d4-a716-446655440000",
        amount_cents: 1000001,
      }),
    );
    expect(result.error).toContain("amount_cents");
  });

  // create_agentic_wallet -- wallet policy fields
  it("create_agentic_wallet rejects daily_limit_cents below 1", async () => {
    const result = JSON.parse(
      await handler("dominusnode_create_agentic_wallet", {
        label: "test-bot",
        spending_limit_cents: 100,
        daily_limit_cents: 0,
      }),
    );
    expect(result.error).toContain("daily_limit_cents");
  });

  it("create_agentic_wallet rejects daily_limit_cents above 1000000", async () => {
    const result = JSON.parse(
      await handler("dominusnode_create_agentic_wallet", {
        label: "test-bot",
        spending_limit_cents: 100,
        daily_limit_cents: 1000001,
      }),
    );
    expect(result.error).toContain("daily_limit_cents");
  });

  it("create_agentic_wallet rejects non-integer daily_limit_cents", async () => {
    const result = JSON.parse(
      await handler("dominusnode_create_agentic_wallet", {
        label: "test-bot",
        spending_limit_cents: 100,
        daily_limit_cents: 100.5,
      }),
    );
    expect(result.error).toContain("daily_limit_cents");
  });

  it("create_agentic_wallet rejects non-array allowed_domains", async () => {
    const result = JSON.parse(
      await handler("dominusnode_create_agentic_wallet", {
        label: "test-bot",
        spending_limit_cents: 100,
        allowed_domains: "example.com",
      }),
    );
    expect(result.error).toContain("allowed_domains");
  });

  it("create_agentic_wallet rejects allowed_domains with >100 entries", async () => {
    const domains = Array.from({ length: 101 }, (_, i) => `d${i}.example.com`);
    const result = JSON.parse(
      await handler("dominusnode_create_agentic_wallet", {
        label: "test-bot",
        spending_limit_cents: 100,
        allowed_domains: domains,
      }),
    );
    expect(result.error).toContain("100");
  });

  it("create_agentic_wallet rejects allowed_domains entry >253 chars", async () => {
    const result = JSON.parse(
      await handler("dominusnode_create_agentic_wallet", {
        label: "test-bot",
        spending_limit_cents: 100,
        allowed_domains: ["a".repeat(254) + ".com"],
      }),
    );
    expect(result.error).toContain("253");
  });

  it("create_agentic_wallet rejects invalid domain format", async () => {
    const result = JSON.parse(
      await handler("dominusnode_create_agentic_wallet", {
        label: "test-bot",
        spending_limit_cents: 100,
        allowed_domains: ["not a domain!!"],
      }),
    );
    expect(result.error).toContain("not a valid domain");
  });

  it("create_agentic_wallet accepts valid daily_limit_cents and allowed_domains", async () => {
    const result = JSON.parse(
      await handler("dominusnode_create_agentic_wallet", {
        label: "test-bot",
        spending_limit_cents: 100,
        daily_limit_cents: 5000,
        allowed_domains: ["example.com", "api.example.org"],
      }),
    );
    expect(result).toHaveProperty("success");
  });

  // update_wallet_policy
  it("update_wallet_policy rejects missing wallet_id", async () => {
    const result = JSON.parse(
      await handler("dominusnode_update_wallet_policy", {
        daily_limit_cents: 5000,
      }),
    );
    expect(result.error).toContain("wallet_id");
  });

  it("update_wallet_policy rejects invalid UUID", async () => {
    const result = JSON.parse(
      await handler("dominusnode_update_wallet_policy", {
        wallet_id: "bad",
        daily_limit_cents: 5000,
      }),
    );
    expect(result.error).toContain("wallet_id");
  });

  it("update_wallet_policy requires at least one policy field", async () => {
    const result = JSON.parse(
      await handler("dominusnode_update_wallet_policy", {
        wallet_id: "550e8400-e29b-41d4-a716-446655440000",
      }),
    );
    expect(result.error).toContain("At least one");
  });

  it("update_wallet_policy rejects daily_limit_cents below 1", async () => {
    const result = JSON.parse(
      await handler("dominusnode_update_wallet_policy", {
        wallet_id: "550e8400-e29b-41d4-a716-446655440000",
        daily_limit_cents: 0,
      }),
    );
    expect(result.error).toContain("daily_limit_cents");
  });

  it("update_wallet_policy rejects daily_limit_cents above 1000000", async () => {
    const result = JSON.parse(
      await handler("dominusnode_update_wallet_policy", {
        wallet_id: "550e8400-e29b-41d4-a716-446655440000",
        daily_limit_cents: 1000001,
      }),
    );
    expect(result.error).toContain("daily_limit_cents");
  });

  it("update_wallet_policy rejects non-array allowed_domains", async () => {
    const result = JSON.parse(
      await handler("dominusnode_update_wallet_policy", {
        wallet_id: "550e8400-e29b-41d4-a716-446655440000",
        allowed_domains: "example.com",
      }),
    );
    expect(result.error).toContain("allowed_domains");
  });

  it("update_wallet_policy rejects allowed_domains with >100 entries", async () => {
    const domains = Array.from({ length: 101 }, (_, i) => `d${i}.example.com`);
    const result = JSON.parse(
      await handler("dominusnode_update_wallet_policy", {
        wallet_id: "550e8400-e29b-41d4-a716-446655440000",
        allowed_domains: domains,
      }),
    );
    expect(result.error).toContain("100");
  });

  it("update_wallet_policy rejects invalid domain format", async () => {
    const result = JSON.parse(
      await handler("dominusnode_update_wallet_policy", {
        wallet_id: "550e8400-e29b-41d4-a716-446655440000",
        allowed_domains: ["-bad.com"],
      }),
    );
    expect(result.error).toContain("not a valid domain");
  });

  it("update_wallet_policy dispatches with valid daily_limit_cents", async () => {
    const result = JSON.parse(
      await handler("dominusnode_update_wallet_policy", {
        wallet_id: "550e8400-e29b-41d4-a716-446655440000",
        daily_limit_cents: 5000,
      }),
    );
    expect(result).toHaveProperty("success");
  });

  it("update_wallet_policy dispatches with valid allowed_domains", async () => {
    const result = JSON.parse(
      await handler("dominusnode_update_wallet_policy", {
        wallet_id: "550e8400-e29b-41d4-a716-446655440000",
        allowed_domains: ["example.com"],
      }),
    );
    expect(result).toHaveProperty("success");
  });
});

// =========================================================================
// Error handling in dispatch
// =========================================================================

describe("handler error handling", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("scrubs credentials from API errors", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/api/auth/verify-key")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('{"token": "jwt-mock-token"}'),
          headers: new Headers({ "content-length": "30" }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        text: () =>
          Promise.resolve(
            '{"error": "dn_live_secret123 failed"}',
          ),
        headers: new Headers({ "content-length": "50" }),
      });
    });

    const handler = createDominusNodeFunctionHandler({
      apiKey: "dn_test_abc123",
    });

    const result = JSON.parse(
      await handler("dominusnode_check_balance", {}),
    );
    expect(result.error).not.toContain("dn_live_secret123");
    expect(result.error).toContain("***");
  });
});
