import { vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpClient } from "../../src/http-client.js";
import { TokenManager } from "../../src/token-manager.js";

export function makeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, sub: "u1" })).toString("base64url");
  return `${header}.${payload}.sig`;
}

/** Response mock following the safeJson pattern (text(), not json()). */
export function jsonResponse(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(text),
    body: { cancel: () => Promise.resolve() },
  } as unknown as Response;
}

export async function makeHttpClient(): Promise<HttpClient> {
  const tm = new TokenManager("http://localhost:3000");
  globalThis.fetch = vi.fn().mockResolvedValueOnce(
    jsonResponse({ accessToken: makeJwt(Math.floor(Date.now() / 1000) + 600), refreshToken: "rt" }),
  );
  await tm.initialize("dn_live_test");
  return new HttpClient("http://localhost:3000", tm);
}

export type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };

export function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.handler(args, {} as never);
}

export function mockFetchSequence(...responses: Response[]) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
