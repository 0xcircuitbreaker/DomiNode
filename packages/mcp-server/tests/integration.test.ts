import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TokenManager } from "../src/token-manager.js";
import { HttpClient } from "../src/http-client.js";
import type { McpConfig } from "../src/config.js";
import { registerAuthenticatedTools, registerBootstrapTools, countTools } from "../src/register.js";
import { registerWalletTools } from "../src/tools/wallet.js";
import { AUTHENTICATED_TOOLS, BOOTSTRAP_TOOLS, REMOVED_TOOLS } from "./tool-list.js";

function makeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, sub: "u1" })).toString("base64url");
  return `${header}.${payload}.sig`;
}

async function makeClient(): Promise<HttpClient> {
  const token = makeJwt(Math.floor(Date.now() / 1000) + 600);
  const tm = new TokenManager("http://localhost:3000");
  globalThis.fetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    text: () => Promise.resolve(JSON.stringify({ accessToken: token, refreshToken: "rt" })),
  } as unknown as Response);
  await tm.initialize("dn_live_test");
  return new HttpClient("http://localhost:3000", tm);
}

const baseConfig: McpConfig = {
  apiKey: "dn_live_test",
  apiUrl: "http://localhost:3000",
  proxyHost: "proxy.example.com",
  httpProxyPort: 8080,
  socks5ProxyPort: 1080,
  fetchTimeoutMs: 30000,
  fetchMaxResponseBytes: 5 * 1024 * 1024,
  mcpAgentSecret: "",
  walletKeyFile: null,
  nodeKeyFile: "/tmp/dn-test-node.json",
};

describe("MCP Server Integration", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("registers exactly the authenticated-mode tool set", async () => {
    const httpClient = await makeClient();
    const server = new McpServer({ name: "dominusnode", version: "1.0.0" });
    registerAuthenticatedTools(server, httpClient, baseConfig);
    const names = Object.keys((server as any)._registeredTools).sort();
    expect(names).toEqual([...AUTHENTICATED_TOOLS].sort());
    expect(countTools(server)).toBe(AUTHENTICATED_TOOLS.length);
    for (const removed of REMOVED_TOOLS) expect(names).not.toContain(removed);
  });

  it("registers exactly the bootstrap tool set when no API key", async () => {
    const httpClient = await makeClient();
    const server = new McpServer({ name: "dominusnode", version: "1.0.0" });
    registerBootstrapTools(server, httpClient);
    const names = Object.keys((server as any)._registeredTools).sort();
    expect(names).toEqual([...BOOTSTRAP_TOOLS].sort());
    expect(names).not.toContain("dominusnode_agent_wallet_create");
    expect(names).not.toContain("dominusnode_fetch");
    for (const removed of REMOVED_TOOLS) expect(names).not.toContain(removed);
  });

  it.skip("every tool description is non-empty and free of legacy pool pricing", async () => {
    const httpClient = await makeClient();
    const server = new McpServer({ name: "dominusnode", version: "1.0.0" });
    registerAuthenticatedTools(server, httpClient, baseConfig);
    for (const [name, tool] of Object.entries((server as any)._registeredTools as Record<string, { description?: string }>)) {
      expect(tool.description, name).toBeTruthy();
      expect(tool.description, name).not.toMatch(/\$3(\.00)?\/GB|\$5(\.00)?\/GB|Webshare|Stripe|PayPal/i);
    }
  });

  it("bootstrap help explains wallet auth and network info", async () => {
    const httpClient = await makeClient();
    const server = new McpServer({ name: "dominusnode", version: "1.0.0" });
    registerBootstrapTools(server, httpClient);
    const result = await (server as any)._registeredTools["dominusnode_bootstrap_help"].handler({}, {} as never);
    const text = result.content[0].text as string;
    expect(text).toContain("dominusnode_wallet_setup");
    expect(text).toContain("dominusnode_network_pricing");
    expect(text).not.toMatch(/stripe|paypal|slots/i);
  });

  it("tool error handling returns isError without throwing", async () => {
    const httpClient = await makeClient();
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerWalletTools(server, httpClient);
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await (server as any)._registeredTools["dominusnode_get_balance"].handler({}, { sessionId: "" } as never);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ECONNREFUSED");
  });
});
