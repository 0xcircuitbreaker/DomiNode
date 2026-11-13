import { describe, it, expect, vi } from "vitest";
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
    expect(config.fetchMaxResponseBytes).toBe(10 * 1024 * 1024);
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

  it("reads DOMINUSNODE_AGENT_SECRET, with MCP_AGENT_SECRET as alias", () => {
    const a = "a".repeat(32), b = "b".repeat(32);
    expect(parseConfig({ ...validEnv, DOMINUSNODE_AGENT_SECRET: a }).mcpAgentSecret).toBe(a);
    expect(parseConfig({ ...validEnv, MCP_AGENT_SECRET: b }).mcpAgentSecret).toBe(b);
    expect(parseConfig({ ...validEnv, DOMINUSNODE_AGENT_SECRET: a, MCP_AGENT_SECRET: b }).mcpAgentSecret).toBe(a);
    expect(() => parseConfig({ ...validEnv, DOMINUSNODE_AGENT_SECRET: "short" })).toThrow(ConfigError);
  });

  describe("local / self-hosted gateway (DOMINUSNODE_ALLOW_LOCAL_GATEWAY)", () => {
    it("refuses localhost and private proxy hosts by default", () => {
      expect(() => parseConfig({ DOMINUSNODE_PROXY_HOST: "localhost" })).toThrow(ConfigError);
      expect(() => parseConfig({ DOMINUSNODE_PROXY_URL: "https://192.168.1.20:8444" })).toThrow(/ALLOW_LOCAL_GATEWAY/);
    });

    it("accepts them with the explicit opt-in and warns", () => {
      const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const c = parseConfig({ DOMINUSNODE_PROXY_URL: "https://localhost:8444", DOMINUSNODE_ALLOW_LOCAL_GATEWAY: "1" });
        expect(c.proxyHost).toBe("localhost");
        expect(c.proxyTls?.port).toBe(8444);
        expect(write.mock.calls.map((x) => String(x[0])).join("")).toContain("DOMINUSNODE_ALLOW_LOCAL_GATEWAY");
      } finally {
        write.mockRestore();
      }
    });
  });
});
