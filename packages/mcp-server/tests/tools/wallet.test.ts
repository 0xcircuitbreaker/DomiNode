import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpClient } from "../../src/http-client.js";
import { TokenManager } from "../../src/token-manager.js";
import { registerWalletTools } from "../../src/tools/wallet.js";

function makeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, sub: "u1" })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("wallet tools", () => {
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
    registerWalletTools(server, httpClient);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("dominusnode_get_balance returns formatted balance", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ balance_cents: 1250, balance_usd: "12.50", currency: "USD" })),
      headers: new Headers(),
    } as unknown as Response);

    // Access the tool handler directly via the server's internal tool list
    const tools = (server as any)._registeredTools;
    const balanceTool = tools["dominusnode_get_balance"];
    expect(balanceTool).toBeDefined();

    const result = await balanceTool.handler({}, { sessionId: "" } as never);
    expect(result.content).toEqual([
      { type: "text", text: "Balance: $12.50 (1250 cents)" },
    ]);
  });

  it("dominusnode_get_balance returns error on failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("timeout"));

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_get_balance"].handler({}, { sessionId: "" } as never);
    expect(result.isError).toBe(true);
  });
});
