import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpClient } from "../../src/http-client.js";
import { TokenManager } from "../../src/token-manager.js";
import { registerProxyTools } from "../../src/tools/proxy.js";

function makeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, sub: "u1" })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("proxy tools", () => {
  let server: McpServer;
  let httpClient: HttpClient;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    const token = makeJwt(Math.floor(Date.now() / 1000) + 600);
    const tm = new TokenManager("http://localhost:3000");
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ accessToken: token, refreshToken: "rt" })),
    } as unknown as Response);
    await tm.initialize("dn_live_test");

    httpClient = new HttpClient("http://localhost:3000", tm);
    server = new McpServer({ name: "test", version: "1.0.0" });
    registerProxyTools(server, httpClient);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("dominusnode_get_proxy_config returns formatted config", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        httpProxy: { host: "proxy.dominusnode.com", port: 8080 },
        socks5Proxy: { host: "proxy.dominusnode.com", port: 1080 },
        supportedCountries: ["US", "GB", "DE"],
        blockedCountries: ["CU", "IR", "KP", "RU", "SY"],
        geoTargeting: { stateSupport: false, citySupport: false, asnSupport: false },
      })),
      headers: new Headers(),
    } as unknown as Response);

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_get_proxy_config"].handler({}, { sessionId: "" } as never);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("proxy.dominusnode.com:8080");
    expect(text).toContain("US, GB, DE");
    expect(text).toContain("$3.00/GB");
    expect(text).toContain("$5.00/GB");
  });

  it("dominusnode_get_proxy_status returns status info", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        status: "healthy",
        avgLatencyMs: 42,
        activeSessions: 5,
        uptimeSeconds: 3600,
        endpoints: { http: "proxy.dominusnode.com:8080", socks5: "proxy.dominusnode.com:1080" },
        supportedCountries: ["US", "GB", "DE"],
      })),
      headers: new Headers(),
    } as unknown as Response);

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_get_proxy_status"].handler({}, { sessionId: "" } as never);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("healthy");
    expect(text).toContain("42ms");
    expect(text).toContain("3600s");
  });
});
