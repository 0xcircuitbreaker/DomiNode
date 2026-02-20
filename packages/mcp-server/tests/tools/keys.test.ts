import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient } from "../../src/http-client.js";
import { TokenManager } from "../../src/token-manager.js";
import { registerKeysTools } from "../../src/tools/keys.js";

function makeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, sub: "u1" })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("keys tools", () => {
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
    registerKeysTools(server, httpClient);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("dominusnode_create_key returns new key", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ id: "uuid1", key: "dn_live_abc", prefix: "dn_live_ab", label: "test" })),
      headers: new Headers(),
    } as unknown as Response);

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_create_key"].handler({ label: "test" }, { sessionId: "" } as never);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("dn_live_abc");
    expect(text).toContain("Save this key now");
  });

  it("dominusnode_revoke_key schema rejects invalid UUID", () => {
    const tools = (server as any)._registeredTools;
    const tool = tools["dominusnode_revoke_key"];
    const schema = tool.inputSchema as z.ZodObject<{ key_id: z.ZodString }>;
    const result = schema.safeParse({ key_id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("dominusnode_revoke_key schema accepts valid UUID", () => {
    const tools = (server as any)._registeredTools;
    const tool = tools["dominusnode_revoke_key"];
    const schema = tool.inputSchema as z.ZodObject<{ key_id: z.ZodString }>;
    const result = schema.safeParse({ key_id: "550e8400-e29b-41d4-a716-446655440000" });
    expect(result.success).toBe(true);
  });

  it("dominusnode_revoke_key accepts valid UUID", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve("{}"),
      headers: new Headers(),
    } as unknown as Response);

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_revoke_key"].handler(
      { key_id: "550e8400-e29b-41d4-a716-446655440000" },
      { sessionId: "" } as never,
    );
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("revoked");
  });

  it("dominusnode_list_keys handles empty list", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ keys: [] })),
      headers: new Headers(),
    } as unknown as Response);

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_list_keys"].handler({}, { sessionId: "" } as never);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("No API keys");
  });
});
