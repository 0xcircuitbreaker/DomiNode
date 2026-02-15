import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpClient } from "../../src/http-client.js";
import { TokenManager } from "../../src/token-manager.js";
import { registerUsageTools } from "../../src/tools/usage.js";

function makeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, sub: "u1" })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("usage tools", () => {
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
    registerUsageTools(server, httpClient);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("dominusnode_get_usage returns formatted summary", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        total_bytes: 1073741824,
        total_cost_cents: 500,
        total_requests: 1000,
        period_start: "2026-01-01",
        period_end: "2026-01-31",
      })),
      headers: new Headers(),
    } as unknown as Response);

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_get_usage"].handler({ days: 30 }, { sessionId: "" } as never);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("1.000 GB");
    expect(text).toContain("$5.00");
    expect(text).toContain("1000");
  });

  it("dominusnode_get_top_hosts handles empty data", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ hosts: [] })),
      headers: new Headers(),
    } as unknown as Response);

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_get_top_hosts"].handler({ limit: 10, days: 30 }, { sessionId: "" } as never);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("No host data");
  });
});
