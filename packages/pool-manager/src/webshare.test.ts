import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildUpstreamProxy,
  validateConfig,
  generateStickySession,
  getConfig,
  getBandwidthUsage,
  fetchProxyList,
  StaticProxyPool,
} from "./webshare.js";

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("webshare", () => {
  // ─── getConfig ─────────────────────────────────────────────────────

  describe("getConfig", () => {
    it("should return config from env vars", () => {
      const config = getConfig();
      expect(config.proxyHost).toBe("p.test.io");
      expect(config.httpPort).toBe(80);
      expect(config.dc.username).toBe("testdcuser");
      expect(config.dc.password).toBe("testdcpass");
      expect(config.residential.username).toBe("testresuser");
      expect(config.residential.password).toBe("testrespass");
    });
  });

  // ─── validateConfig ────────────────────────────────────────────────

  describe("validateConfig", () => {
    it("should not throw when at least one pool is configured", () => {
      expect(() => validateConfig()).not.toThrow();
    });

    it("should throw when no pools are configured", () => {
      const origDCU = process.env["WEBSHARE_DC_USERNAME"];
      const origDCP = process.env["WEBSHARE_DC_PASSWORD"];
      const origRU = process.env["WEBSHARE_RES_USERNAME"];
      const origRP = process.env["WEBSHARE_RES_PASSWORD"];
      process.env["WEBSHARE_DC_USERNAME"] = "";
      process.env["WEBSHARE_DC_PASSWORD"] = "";
      process.env["WEBSHARE_RES_USERNAME"] = "";
      process.env["WEBSHARE_RES_PASSWORD"] = "";
      try {
        expect(() => validateConfig()).toThrow(
          "At least one Webshare pool must be configured",
        );
      } finally {
        process.env["WEBSHARE_DC_USERNAME"] = origDCU;
        process.env["WEBSHARE_DC_PASSWORD"] = origDCP;
        process.env["WEBSHARE_RES_USERNAME"] = origRU;
        process.env["WEBSHARE_RES_PASSWORD"] = origRP;
      }
    });

    it("should pass when only DC pool is configured", () => {
      const origRU = process.env["WEBSHARE_RES_USERNAME"];
      const origRP = process.env["WEBSHARE_RES_PASSWORD"];
      process.env["WEBSHARE_RES_USERNAME"] = "";
      process.env["WEBSHARE_RES_PASSWORD"] = "";
      try {
        expect(() => validateConfig()).not.toThrow();
      } finally {
        process.env["WEBSHARE_RES_USERNAME"] = origRU;
        process.env["WEBSHARE_RES_PASSWORD"] = origRP;
      }
    });
  });

  // ─── generateStickySession ─────────────────────────────────────────

  describe("generateStickySession", () => {
    it("should return an 8-character hex string", () => {
      const session = generateStickySession();
      expect(session).toMatch(/^[0-9a-f]{8}$/);
    });

    it("should generate unique sessions", () => {
      const s1 = generateStickySession();
      const s2 = generateStickySession();
      expect(s1).not.toBe(s2);
    });
  });

  // ─── buildUpstreamProxy ────────────────────────────────────────────

  describe("buildUpstreamProxy", () => {
    it("should return DC proxy with -rotate suffix by default", () => {
      const proxy = buildUpstreamProxy("dc");
      expect(proxy.host).toBe("p.test.io");
      expect(proxy.port).toBe(80);
      expect(proxy.username).toBe("testdcuser-rotate");
      expect(Object.getOwnPropertyDescriptor(proxy, "password")?.value).toBe("testdcpass");
    });

    it("should return residential proxy with -rotate suffix by default", () => {
      const proxy = buildUpstreamProxy("residential");
      expect(proxy.host).toBe("p.test.io");
      expect(proxy.port).toBe(80);
      expect(proxy.username).toBe("testresuser-rotate");
      expect(Object.getOwnPropertyDescriptor(proxy, "password")?.value).toBe("testrespass");
    });

    it("should append country to username", () => {
      const proxy = buildUpstreamProxy("dc", { country: "US" });
      expect(proxy.username).toBe("testdcuser-country-US-rotate");
    });

    it("should accept lowercase country and uppercase it", () => {
      const proxy = buildUpstreamProxy("dc", { country: "de" });
      expect(proxy.username).toBe("testdcuser-country-DE-rotate");
    });

    it("should use session suffix instead of rotate when sticky is true", () => {
      const proxy = buildUpstreamProxy("dc", { sticky: true });
      expect(proxy.username).toMatch(/^testdcuser-session-[a-f0-9]{8}$/);
    });

    it("should use provided sessionId", () => {
      const proxy = buildUpstreamProxy("dc", { sessionId: "abc123" });
      expect(proxy.username).toBe("testdcuser-session-abc123");
    });

    it("should combine country and session", () => {
      const proxy = buildUpstreamProxy("residential", { country: "US", sessionId: "xyz789" });
      expect(proxy.username).toBe("testresuser-country-US-session-xyz789");
    });

    it("should set proxyAuth correctly for combined options", () => {
      const proxy = buildUpstreamProxy("dc", { country: "GB", sessionId: "sess1" });
      const expectedAuth = Buffer.from(
        "testdcuser-country-GB-session-sess1:testdcpass",
      ).toString("base64");
      expect(proxy.proxyAuth).toBe(expectedAuth);
    });

    it("should throw for invalid country code (3 letters)", () => {
      expect(() => buildUpstreamProxy("dc", { country: "USA" })).toThrow(
        "Invalid country code: must be exactly 2 ASCII letters",
      );
    });

    it("should throw for invalid country code (1 letter)", () => {
      expect(() => buildUpstreamProxy("dc", { country: "U" })).toThrow(
        "Invalid country code",
      );
    });

    it("should throw for country code with numbers", () => {
      expect(() => buildUpstreamProxy("dc", { country: "U1" })).toThrow(
        "Invalid country code",
      );
    });

    it("should throw for invalid sessionId (non-alphanumeric)", () => {
      expect(() => buildUpstreamProxy("dc", { sessionId: "abc-123" })).toThrow(
        "Invalid sessionId: must be alphanumeric only",
      );
    });

    it("should throw for sessionId with spaces", () => {
      expect(() => buildUpstreamProxy("dc", { sessionId: "abc 123" })).toThrow(
        "Invalid sessionId",
      );
    });

    it("should throw for sessionId with special chars", () => {
      expect(() => buildUpstreamProxy("dc", { sessionId: "abc@123" })).toThrow(
        "Invalid sessionId",
      );
    });

    it("should silently ignore state/city/asn options", () => {
      const proxy = buildUpstreamProxy("dc", { country: "US", state: "california", city: "losangeles", asn: 12345 });
      // Only country should appear in username, not state/city/asn
      expect(proxy.username).toBe("testdcuser-country-US-rotate");
    });

    it("should throw when pool credentials are missing", () => {
      const origU = process.env["WEBSHARE_DC_USERNAME"];
      const origP = process.env["WEBSHARE_DC_PASSWORD"];
      process.env["WEBSHARE_DC_USERNAME"] = "";
      process.env["WEBSHARE_DC_PASSWORD"] = "";
      try {
        expect(() => buildUpstreamProxy("dc")).toThrow(
          "Webshare dc pool credentials not configured",
        );
      } finally {
        process.env["WEBSHARE_DC_USERNAME"] = origU;
        process.env["WEBSHARE_DC_PASSWORD"] = origP;
      }
    });

    it("should make password non-enumerable", () => {
      const proxy = buildUpstreamProxy("dc");
      expect(Object.keys(proxy)).not.toContain("password");
    });

    it("should make proxyAuth non-enumerable", () => {
      const proxy = buildUpstreamProxy("dc");
      expect(Object.keys(proxy)).not.toContain("proxyAuth");
    });
  });

  // ─── getBandwidthUsage ────────────────────────────────────────────

  describe("getBandwidthUsage", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      process.env["WEBSHARE_API_KEY"] = "test-api-key";
    });

    it("should return bandwidth usage from the API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          bandwidth_used: 5_000_000_000,
          bandwidth_limit: 10_000_000_000,
        })),
      });

      const result = await getBandwidthUsage();
      expect(result.usedBytes).toBe(5_000_000_000);
      expect(result.totalBytes).toBe(10_000_000_000);
      expect(result.remainingBytes).toBe(5_000_000_000);
    });

    it("should call the correct API endpoint with Token auth", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ bandwidth_used: 0, bandwidth_limit: 0 })),
      });

      await getBandwidthUsage();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/subscription/plan/"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Token test-api-key",
          }),
          redirect: "error",
        }),
      );
    });

    it("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      });

      // Error no longer includes response body
      await expect(getBandwidthUsage()).rejects.toThrow(
        "Webshare bandwidth API failed: 401",
      );
    });

    it("should throw when API key is not configured", async () => {
      const origKey = process.env["WEBSHARE_API_KEY"];
      process.env["WEBSHARE_API_KEY"] = "";
      try {
        await expect(getBandwidthUsage()).rejects.toThrow(
          "WEBSHARE_API_KEY is required",
        );
      } finally {
        process.env["WEBSHARE_API_KEY"] = origKey;
      }
    });

    it("should clamp remaining bytes to 0 when used > total", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          bandwidth_used: 15_000_000_000,
          bandwidth_limit: 10_000_000_000,
        })),
      });

      const result = await getBandwidthUsage();
      expect(result.remainingBytes).toBe(0);
    });
  });

  // ─── fetchProxyList ─────────────────────────────────────────────────

  describe("fetchProxyList", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      process.env["WEBSHARE_API_KEY"] = "test-api-key";
    });

    it("should fetch and parse proxy list from API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          count: 2,
          next: null,
          results: [
            { proxy_address: "1.2.3.4", port: 8080, username: "u1", password: "p1", country_code: "US", valid: true },
            { proxy_address: "5.6.7.8", port: 3128, username: "u2", password: "p2", country_code: "DE", valid: true },
          ],
        })),
      });

      const list = await fetchProxyList();
      expect(list).toHaveLength(2);
      expect(list[0].address).toBe("1.2.3.4");
      expect(list[0].port).toBe(8080);
      expect(list[0].username).toBe("u1");
      expect(list[0].countryCode).toBe("US");
      expect(list[1].address).toBe("5.6.7.8");
      expect(list[1].countryCode).toBe("DE");
    });

    it("should skip invalid proxies", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          count: 2,
          next: null,
          results: [
            { proxy_address: "1.2.3.4", port: 8080, username: "u1", password: "p1", country_code: "US", valid: true },
            { proxy_address: "9.9.9.9", port: 8080, username: "u2", password: "p2", country_code: "CN", valid: false },
          ],
        })),
      });

      const list = await fetchProxyList();
      expect(list).toHaveLength(1);
      expect(list[0].address).toBe("1.2.3.4");
    });

    it("should throw when API key is missing", async () => {
      process.env["WEBSHARE_API_KEY"] = "";
      await expect(fetchProxyList()).rejects.toThrow("WEBSHARE_API_KEY is required");
    });

    it("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
      await expect(fetchProxyList()).rejects.toThrow("Webshare proxy list API failed: 403");
    });

    it("should call with Token auth header", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ count: 0, next: null, results: [] })),
      });

      await fetchProxyList();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/proxy/list/?mode=direct"),
        expect.objectContaining({
          headers: { Authorization: "Token test-api-key" },
        }),
      );
    });

    it("should handle pagination", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({
            count: 2,
            next: "https://example.com/page2",
            results: Array.from({ length: 250 }, (_, i) => ({
              proxy_address: `44.0.${Math.floor(i / 256)}.${i % 256}`, port: 8080, username: "u", password: "p", country_code: "US", valid: true,
            })),
          })),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({
            count: 2,
            next: null,
            results: [
              { proxy_address: "44.1.0.1", port: 8080, username: "u", password: "p", country_code: "GB", valid: true },
            ],
          })),
        });

      const list = await fetchProxyList();
      expect(list).toHaveLength(251);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ─── StaticProxyPool ────────────────────────────────────────────────

  describe("StaticProxyPool", () => {
    let pool: StaticProxyPool;

    afterEach(() => {
      pool?.destroy();
    });

    it("should initialize and become ready", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          count: 2,
          next: null,
          results: [
            { proxy_address: "1.1.1.1", port: 80, username: "u1", password: "p1", country_code: "US", valid: true },
            { proxy_address: "2.2.2.2", port: 80, username: "u2", password: "p2", country_code: "DE", valid: true },
          ],
        })),
      });

      pool = new StaticProxyPool();
      await pool.init();
      expect(pool.ready).toBe(true);
      expect(pool.count).toBe(2);
    });

    it("should round-robin through proxies", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          count: 3,
          next: null,
          results: [
            { proxy_address: "1.1.1.1", port: 80, username: "u", password: "p", country_code: "US", valid: true },
            { proxy_address: "2.2.2.2", port: 80, username: "u", password: "p", country_code: "US", valid: true },
            { proxy_address: "3.3.3.3", port: 80, username: "u", password: "p", country_code: "US", valid: true },
          ],
        })),
      });

      pool = new StaticProxyPool();
      await pool.init();

      const p1 = pool.getProxy();
      const p2 = pool.getProxy();
      const p3 = pool.getProxy();
      const p4 = pool.getProxy(); // wraps around

      expect(p1.host).toBe("1.1.1.1");
      expect(p2.host).toBe("2.2.2.2");
      expect(p3.host).toBe("3.3.3.3");
      expect(p4.host).toBe("1.1.1.1");
    });

    it("should filter by country", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          count: 3,
          next: null,
          results: [
            { proxy_address: "1.1.1.1", port: 80, username: "u", password: "p", country_code: "US", valid: true },
            { proxy_address: "2.2.2.2", port: 80, username: "u", password: "p", country_code: "DE", valid: true },
            { proxy_address: "3.3.3.3", port: 80, username: "u", password: "p", country_code: "US", valid: true },
          ],
        })),
      });

      pool = new StaticProxyPool();
      await pool.init();

      const proxy = pool.getProxy({ country: "DE" });
      expect(proxy.host).toBe("2.2.2.2");
    });

    it("should reject sanctioned countries", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          count: 1,
          next: null,
          results: [
            { proxy_address: "1.1.1.1", port: 80, username: "u", password: "p", country_code: "US", valid: true },
          ],
        })),
      });

      pool = new StaticProxyPool();
      await pool.init();

      expect(() => pool.getProxy({ country: "KP" })).toThrow("sanctioned");
    });

    it("should throw when no proxies loaded", () => {
      pool = new StaticProxyPool();
      expect(() => pool.getProxy()).toThrow("No DC proxies available");
    });

    it("should make password non-enumerable in returned proxy", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          count: 1,
          next: null,
          results: [
            { proxy_address: "1.1.1.1", port: 80, username: "u1", password: "secret", country_code: "US", valid: true },
          ],
        })),
      });

      pool = new StaticProxyPool();
      await pool.init();

      const proxy = pool.getProxy();
      expect(Object.keys(proxy)).not.toContain("password");
      expect(Object.keys(proxy)).not.toContain("proxyAuth");
    });

    it("should return consistent proxy for sticky sessions", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          count: 3,
          next: null,
          results: [
            { proxy_address: "1.1.1.1", port: 80, username: "u", password: "p", country_code: "US", valid: true },
            { proxy_address: "2.2.2.2", port: 80, username: "u", password: "p", country_code: "US", valid: true },
            { proxy_address: "3.3.3.3", port: 80, username: "u", password: "p", country_code: "US", valid: true },
          ],
        })),
      });

      pool = new StaticProxyPool();
      await pool.init();

      const p1 = pool.getProxy({ sessionId: "mysession" });
      const p2 = pool.getProxy({ sessionId: "mysession" });
      expect(p1.host).toBe(p2.host);
    });
  });
});
