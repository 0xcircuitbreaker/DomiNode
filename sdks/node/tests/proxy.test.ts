import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProxyResource } from "../src/proxy.js";
import { HttpClient } from "../src/http.js";
import { TokenManager } from "../src/token-manager.js";
import {
  DEFAULT_PROXY_HOST,
  DEFAULT_HTTP_PROXY_PORT,
  DEFAULT_SOCKS5_PROXY_PORT,
} from "../src/constants.js";

function makeJwt(expSeconds: number = 900): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      userId: "test-user",
      exp: Math.floor(Date.now() / 1000) + expSeconds,
      iat: Math.floor(Date.now() / 1000),
    }),
  ).toString("base64url");
  const sig = Buffer.from("fake-sig").toString("base64url");
  return `${header}.${payload}.${sig}`;
}

describe("ProxyResource", () => {
  let proxy: ProxyResource;

  beforeEach(() => {
    vi.restoreAllMocks();
    const tm = new TokenManager();
    tm.setTokens(makeJwt(900), makeJwt(7 * 86400));
    const http = new HttpClient("http://localhost:3000", tm);
    proxy = new ProxyResource(http, {});
  });

  describe("buildUrl", () => {
    it("builds a basic HTTP proxy URL with default settings", () => {
      const url = proxy.buildUrl("dn_live_abc123");
      expect(url).toBe(`http://user:dn_live_abc123@${DEFAULT_PROXY_HOST}:${DEFAULT_HTTP_PROXY_PORT}`);
    });

    it("builds a SOCKS5 proxy URL", () => {
      const url = proxy.buildUrl("dn_live_abc123", { protocol: "socks5" });
      expect(url).toBe(`socks5://user:dn_live_abc123@${DEFAULT_PROXY_HOST}:${DEFAULT_SOCKS5_PROXY_PORT}`);
    });

    it("includes country geo-targeting in the username", () => {
      const url = proxy.buildUrl("dn_live_key", { country: "US" });
      expect(url).toContain("user-country-US:");
    });

    it("includes state and city geo-targeting", () => {
      const url = proxy.buildUrl("dn_live_key", {
        country: "US",
        state: "CA",
        city: "Los Angeles",
      });
      expect(url).toContain("country-US");
      expect(url).toContain("state-CA");
      expect(url).toContain("city-Los%20Angeles");
    });

    it("includes session ID for sticky sessions", () => {
      const url = proxy.buildUrl("dn_live_key", { sessionId: "sticky-123" });
      expect(url).toContain("session-sticky-123");
    });

    it("URL-encodes special characters in the API key", () => {
      const url = proxy.buildUrl("dn_live_key+with/special=chars");
      expect(url).toContain("dn_live_key%2Bwith%2Fspecial%3Dchars");
    });

    it("uses custom proxy host and ports from config", () => {
      const tm = new TokenManager();
      tm.setTokens(makeJwt(900), makeJwt(7 * 86400));
      const http = new HttpClient("http://localhost:3000", tm);
      const customProxy = new ProxyResource(http, {
        proxyHost: "custom.proxy.io",
        httpProxyPort: 9090,
        socks5ProxyPort: 2080,
      });
      const url = customProxy.buildUrl("dn_live_key");
      expect(url).toBe("http://user:dn_live_key@custom.proxy.io:9090");

      const socksUrl = customProxy.buildUrl("dn_live_key", { protocol: "socks5" });
      expect(socksUrl).toBe("socks5://user:dn_live_key@custom.proxy.io:2080");
    });

    it("includes ASN targeting in the username", () => {
      const url = proxy.buildUrl("dn_live_key", { asn: 12345 });
      expect(url).toContain("asn-12345");
    });
  });
});
