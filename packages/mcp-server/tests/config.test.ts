import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "../src/config.js";

describe("parseConfig", () => {
  const validEnv = {
    DOMINUSNODE_API_KEY: "dn_live_test123",
  };

  it("parses minimal valid config", () => {
    const config = parseConfig(validEnv);
    expect(config.apiKey).toBe("dn_live_test123");
    expect(config.apiUrl).toBe("https://api.dominusnode.com");
    expect(config.proxyHost).toBe("proxy.dominusnode.com");
    expect(config.httpProxyPort).toBe(8080);
    expect(config.socks5ProxyPort).toBe(1080);
    expect(config.fetchTimeoutMs).toBe(30000);
    expect(config.fetchMaxResponseBytes).toBe(5 * 1024 * 1024);
  });

  it("allows missing DOMINUSNODE_API_KEY for bootstrap mode", () => {
    const config = parseConfig({});
    expect(config.apiKey).toBeNull();
    expect(config.apiUrl).toBe("https://api.dominusnode.com");
  });

  it("throws when DOMINUSNODE_API_KEY does not start with dn_live_", () => {
    expect(() => parseConfig({ DOMINUSNODE_API_KEY: "bad_key" })).toThrow("must start with 'dn_live_'");
  });

  it("parses custom API URL and strips trailing slash", () => {
    const config = parseConfig({
      ...validEnv,
      DOMINUSNODE_API_URL: "http://localhost:3000///",
    });
    expect(config.apiUrl).toBe("http://localhost:3000");
  });

  it("parses custom proxy host and ports", () => {
    const config = parseConfig({
      ...validEnv,
      DOMINUSNODE_PROXY_HOST: "proxy.example.com",
      DOMINUSNODE_HTTP_PROXY_PORT: "9090",
      DOMINUSNODE_SOCKS5_PROXY_PORT: "2080",
    });
    expect(config.proxyHost).toBe("proxy.example.com");
    expect(config.httpProxyPort).toBe(9090);
    expect(config.socks5ProxyPort).toBe(2080);
  });

  it("throws on invalid port", () => {
    expect(() =>
      parseConfig({ ...validEnv, DOMINUSNODE_HTTP_PROXY_PORT: "0" }),
    ).toThrow("valid port number");
    expect(() =>
      parseConfig({ ...validEnv, DOMINUSNODE_HTTP_PROXY_PORT: "99999" }),
    ).toThrow("valid port number");
    expect(() =>
      parseConfig({ ...validEnv, DOMINUSNODE_HTTP_PROXY_PORT: "abc" }),
    ).toThrow("valid port number");
  });

  it("throws when timeout exceeds 120000", () => {
    expect(() =>
      parseConfig({ ...validEnv, DOMINUSNODE_FETCH_TIMEOUT_MS: "200000" }),
    ).toThrow("must not exceed 120000");
  });

  it("throws on non-positive timeout", () => {
    expect(() =>
      parseConfig({ ...validEnv, DOMINUSNODE_FETCH_TIMEOUT_MS: "-1" }),
    ).toThrow("must be a positive integer");
  });

  it("parses custom max response bytes", () => {
    const config = parseConfig({
      ...validEnv,
      DOMINUSNODE_FETCH_MAX_RESPONSE_BYTES: "1048576",
    });
    expect(config.fetchMaxResponseBytes).toBe(1048576);
  });
});
