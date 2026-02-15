import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFetchTools } from "../../src/tools/fetch.js";
import type { McpConfig } from "../../src/config.js";

describe("fetch tool", () => {
  const config: McpConfig = {
    apiKey: "dn_live_test123",
    apiUrl: "http://localhost:3000",
    proxyHost: "localhost",
    httpProxyPort: 8080,
    socks5ProxyPort: 1080,
    fetchTimeoutMs: 30000,
    fetchMaxResponseBytes: 5 * 1024 * 1024,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers dominusnode_fetch tool", () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerFetchTools(server, config);
    const tools = (server as any)._registeredTools;
    expect(tools["dominusnode_fetch"]).toBeDefined();
  });

  it("rejects invalid URLs", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerFetchTools(server, config);
    const tools = (server as any)._registeredTools;

    const result = await tools["dominusnode_fetch"].handler(
      { url: "file:///etc/passwd", method: "GET", timeout_ms: 30000 },
      { sessionId: "" } as never,
    );
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Only http: and https:");
  });

  it("rejects ftp: URLs", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerFetchTools(server, config);
    const tools = (server as any)._registeredTools;

    const result = await tools["dominusnode_fetch"].handler(
      { url: "ftp://ftp.example.com", method: "GET", timeout_ms: 30000 },
      { sessionId: "" } as never,
    );
    expect(result.isError).toBe(true);
  });
});
