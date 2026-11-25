import { describe, it, expect, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerProxyTokenTools } from "../../src/tools/proxy-tokens.js";
import type { McpConfig } from "../../src/config.js";
import { callTool, jsonResponse, makeHttpClient } from "../helpers/mock.js";

const API_KEY = "dn_live_" + "k".repeat(40);
const TID = "22222222-2222-4222-8222-222222222222";
const SECRET = "dn_proxy_" + "Z".repeat(43);
const config = {
  apiKey: API_KEY, apiUrl: "http://localhost:3000", proxyHost: "p", httpProxyPort: 8080, socks5ProxyPort: 1080,
  fetchTimeoutMs: 30000, fetchMaxResponseBytes: 1024, mcpAgentSecret: "", walletKeyFile: null, payoutWalletKeyFile: null, nodeKeyFile: "/nonexistent",
} as unknown as McpConfig;
const view = {
  id: TID, label: "ci", status: "active", expiresAt: "2027-01-01T00:00:00.000Z", maxBytes: "1000", maxSpendMusd: null,
  bytesUsed: "10", spendUsedMusd: "0", revokedAt: null, createdAt: "2026-11-25T00:00:00.000Z",
};

async function setup(cfg: Partial<McpConfig> = {}) {
  const http = await makeHttpClient();
  const server = new McpServer({ name: "t", version: "1" });
  registerProxyTokenTools(server, http, { ...config, ...cfg });
  return server;
}
function route(h: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return h(url, init); }) as unknown as typeof fetch;
  return calls;
}
afterEach(() => vi.restoreAllMocks());

describe("proxy token tools", () => {
  it("create posts the caps with the API key and shows the token once", async () => {
    const s = await setup();
    const calls = route(() => jsonResponse({ ...view, token: SECRET }, 201));
    const r = await callTool(s, "dominusnode_proxy_token_create", { label: "ci", ttl_seconds: 3600, max_bytes: "1000", max_spend_musd: "5000" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain(SECRET);
    expect(r.content[0].text).not.toContain(API_KEY);
    expect(calls[0].url).toBe("http://localhost:3000/v1/proxy-tokens");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ label: "ci", ttlSeconds: 3600, maxBytes: "1000", maxSpendMusd: "5000" });
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
  });
  it("create refuses a malformed server token", async () => {
    const s = await setup();
    route(() => jsonResponse({ ...view, token: "nope" }, 201));
    expect((await callTool(s, "dominusnode_proxy_token_create", {})).isError).toBe(true);
  });
  it("list shows metadata only", async () => {
    const s = await setup();
    route(() => jsonResponse({ tokens: [view], maxActive: 25 }));
    const r = await callTool(s, "dominusnode_proxy_token_list");
    expect(r.content[0].text).toContain(TID);
    expect(r.content[0].text).toContain("bytes 10/1000");
    expect(r.content[0].text).not.toMatch(/dn_proxy_/);
  });
  it("revoke sends DELETE to the encoded id", async () => {
    const s = await setup();
    const calls = route(() => jsonResponse({ id: TID, revoked: true }));
    const r = await callTool(s, "dominusnode_proxy_token_revoke", { id: TID });
    expect(r.isError).toBeFalsy();
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url).toBe(`http://localhost:3000/v1/proxy-tokens/${TID}`);
  });
  it("scrubs dn_proxy_ and dn_live_ from errors", async () => {
    const s = await setup();
    route(() => jsonResponse({ error: `bad ${SECRET} ${API_KEY}` }, 400));
    const r = await callTool(s, "dominusnode_proxy_token_list");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toContain(SECRET);
    expect(r.content[0].text).not.toContain(API_KEY);
  });
  it("requires an API key", async () => {
    const s = await setup({ apiKey: "" } as Partial<McpConfig>);
    const r = await callTool(s, "dominusnode_proxy_token_list");
    expect(r.isError).toBe(true);
  });
  it("does not accept the API key as an argument", async () => {
    const s = await setup();
    const shape = JSON.stringify((s as any)._registeredTools["dominusnode_proxy_token_create"].inputSchema ?? {});
    expect(shape).not.toMatch(/api_?key/i);
  });
});
