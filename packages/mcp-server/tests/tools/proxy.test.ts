import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpClient } from "../../src/http-client.js";
import { TokenManager } from "../../src/token-manager.js";
import { registerProxyTools } from "../../src/tools/proxy.js";
import type { McpConfig } from "../../src/config.js";
import { PRICING, POLICY } from "../helpers/fixtures.js";

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
    registerProxyTools(server, httpClient, { proxyHost: "proxy.dominusnode.com", httpProxyPort: 8080, socks5ProxyPort: 1080 } as McpConfig);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("dominusnode_get_proxy_config lists relay flags with live pricing and policy", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), text: () => Promise.resolve(JSON.stringify(PRICING)) })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), text: () => Promise.resolve(JSON.stringify(POLICY)) }) as never;
    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_get_proxy_config"].handler({}, { sessionId: "" } as never);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("proxy.dominusnode.com:8080");
    expect(text).toContain("country-XX");
    expect(text).toContain("class-residential");
    expect(text).toContain("session-<id>");
    expect(text).toContain("allowhttp-1");
    expect(text).toContain("class-residential: $0.50/GB");
    expect(text).toContain("plaintext=opt_in");
    expect(text).not.toContain("$3.00");
    expect(text).not.toMatch(/dn_live_test/);
  });

  it("dominusnode_get_proxy_config degrades gracefully when pricing is down", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("down")) as never;
    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_get_proxy_config"].handler({}, { sessionId: "" } as never);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Pricing unavailable");
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
