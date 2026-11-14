import { describe, it, expect, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createRemoteMcpServer,
  bearerKey,
  KeyRateLimiter,
  type RemoteMcpServer,
  type SessionFactory,
} from "./http-server.js";
import { parseHttpConfig, ConfigError, type McpHttpConfig } from "./config.js";

const KEY_A = "dn_live_aaaaaaaaaaaaaaaaaaaa";
const KEY_B = "dn_live_bbbbbbbbbbbbbbbbbbbb";

const baseConfig: McpHttpConfig = {
  port: 0,
  host: "127.0.0.1",
  allowedOrigins: ["https://agents.example.com"],
  sessionIdleMs: 60_000,
  maxSessions: 10,
  rateLimitPerMinute: 1000,
  maxBodyBytes: 64 * 1024,
};

/** Test factory: one "whoami" tool that reports which key the session was built for. */
function makeFactory(opts: { reject?: string } = {}) {
  const disposed: string[] = [];
  const factory: SessionFactory = async (apiKey) => {
    if (opts.reject && apiKey === opts.reject) throw new Error(`API error 401: bad key ${apiKey}`);
    const server = new McpServer({ name: "test", version: "0.0.0" });
    server.tool("whoami", "who", { n: z.number().optional() }, async () => ({
      content: [{ type: "text", text: `owner-${apiKey.slice(-4)}` }],
    }));
    server.tool("boom", "fails", {}, async () => {
      throw new Error(`upstream said Bearer ${apiKey} is wrong`);
    });
    return { server, dispose: () => disposed.push(apiKey.slice(0, 10)) };
  };
  return { factory, disposed };
}

let remote: RemoteMcpServer | null = null;
let base = "";

async function start(factory: SessionFactory, cfg: Partial<McpHttpConfig> = {}): Promise<RemoteMcpServer> {
  remote = createRemoteMcpServer({ ...baseConfig, ...cfg }, factory, () => undefined);
  await new Promise<void>((r) => remote!.httpServer.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(remote.httpServer.address() as AddressInfo).port}/mcp`;
  return remote;
}

afterEach(async () => {
  if (remote) await remote.close();
  remote = null;
});

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

async function openSession(key: string): Promise<string> {
  const res = await post(initBody, { Authorization: `Bearer ${key}` });
  expect(res.status).toBe(200);
  const sid = res.headers.get("mcp-session-id");
  expect(sid).toBeTruthy();
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { Authorization: `Bearer ${key}`, "Mcp-Session-Id": sid! });
  return sid!;
}

function callTool(key: string, sid: string, name: string): Promise<Response> {
  return post(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } },
    { Authorization: `Bearer ${key}`, "Mcp-Session-Id": sid, "Mcp-Protocol-Version": "2025-03-26" },
  );
}

describe("remote MCP endpoint: auth", () => {
  it("requires a Bearer dn_live_ key", async () => {
    await start(makeFactory().factory);
    const none = await post(initBody);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    const wrong = await post(initBody, { Authorization: "Bearer dn_test_xxxxxxxxxxxx" });
    expect(wrong.status).toBe(401);
    expect(remote!.sessionCount()).toBe(0);
  });

  it("rejects a key the API refuses, without echoing it", async () => {
    await start(makeFactory({ reject: KEY_A }).factory);
    const res = await post(initBody, { Authorization: `Bearer ${KEY_A}` });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(KEY_A);
    expect(text).toContain("API key rejected");
  });

  it("opens a session and serves tools for a valid key", async () => {
    await start(makeFactory().factory);
    const sid = await openSession(KEY_A);
    const res = await callTool(KEY_A, sid, "whoami");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("owner-aaaa");
  });

  it("requires initialize before a session exists", async () => {
    await start(makeFactory().factory);
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Authorization: `Bearer ${KEY_A}` });
    expect(res.status).toBe(400);
  });
});

describe("remote MCP endpoint: isolation", () => {
  it("never lets another key use a session", async () => {
    await start(makeFactory().factory);
    const sidA = await openSession(KEY_A);
    const sidB = await openSession(KEY_B);
    expect(sidA).not.toBe(sidB);

    const hijack = await callTool(KEY_B, sidA, "whoami");
    expect(hijack.status).toBe(404);
    expect(await hijack.text()).not.toContain("owner-aaaa");

    const getHijack = await fetch(base, { method: "GET", headers: { Authorization: `Bearer ${KEY_B}`, "Mcp-Session-Id": sidA } });
    expect(getHijack.status).toBe(404);
    const delHijack = await fetch(base, { method: "DELETE", headers: { Authorization: `Bearer ${KEY_B}`, "Mcp-Session-Id": sidA } });
    expect(delHijack.status).toBe(404);
    expect(remote!.sessionCount()).toBe(2);

    expect(await (await callTool(KEY_B, sidB, "whoami")).text()).toContain("owner-bbbb");
    expect(await (await callTool(KEY_A, sidA, "whoami")).text()).toContain("owner-aaaa");
  });

  it("DELETE by the owner closes the session and disposes credentials", async () => {
    const f = makeFactory();
    await start(f.factory);
    const sid = await openSession(KEY_A);
    const del = await fetch(base, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${KEY_A}`, "Mcp-Session-Id": sid, "Mcp-Protocol-Version": "2025-03-26" },
    });
    expect(del.status).toBe(200);
    expect(remote!.sessionCount()).toBe(0);
    expect(f.disposed).toContain(KEY_A.slice(0, 10));
    expect((await callTool(KEY_A, sid, "whoami")).status).toBe(404);
  });

  it("expires idle sessions", async () => {
    const f = makeFactory();
    await start(f.factory);
    await openSession(KEY_A);
    expect(remote!.sweepIdle(Date.now() + 10_000)).toBe(0);
    expect(remote!.sweepIdle(Date.now() + 61_000)).toBe(1);
    expect(remote!.sessionCount()).toBe(0);
    expect(f.disposed).toHaveLength(1);
  });

  it("caps concurrent sessions", async () => {
    await start(makeFactory().factory, { maxSessions: 1 });
    await openSession(KEY_A);
    const res = await post(initBody, { Authorization: `Bearer ${KEY_B}` });
    expect(res.status).toBe(503);
  });
});

describe("remote MCP endpoint: scrubbing and limits", () => {
  it("scrubs the key from tool errors", async () => {
    await start(makeFactory().factory);
    const sid = await openSession(KEY_A);
    const text = await (await callTool(KEY_A, sid, "boom")).text();
    expect(text).not.toContain(KEY_A);
  });

  it("refuses foreign Origins", async () => {
    await start(makeFactory().factory);
    const bad = await post(initBody, { Authorization: `Bearer ${KEY_A}`, Origin: "https://evil.example" });
    expect(bad.status).toBe(403);
    const ok = await post(initBody, { Authorization: `Bearer ${KEY_A}`, Origin: "https://agents.example.com" });
    expect(ok.status).toBe(200);
  });

  it("enforces the body size limit and JSON content type", async () => {
    await start(makeFactory().factory, { maxBodyBytes: 1024 });
    const big = await post({ ...initBody, pad: "x".repeat(4096) }, { Authorization: `Bearer ${KEY_A}` });
    expect(big.status).toBe(413);
    const txt = await fetch(base, { method: "POST", headers: { Authorization: `Bearer ${KEY_A}`, "Content-Type": "text/plain" }, body: "{}" });
    expect(txt.status).toBe(415);
    const bad = await post("{not json", { Authorization: `Bearer ${KEY_A}` });
    expect(bad.status).toBe(400);
  });

  it("rate limits per key", async () => {
    await start(makeFactory().factory, { rateLimitPerMinute: 2 });
    await post({}, { Authorization: `Bearer ${KEY_A}` });
    await post({}, { Authorization: `Bearer ${KEY_A}` });
    expect((await post({}, { Authorization: `Bearer ${KEY_A}` })).status).toBe(429);
    expect((await post({}, { Authorization: `Bearer ${KEY_B}` })).status).toBe(400);
  });

  it("returns 404 off the MCP path and serves /healthz", async () => {
    await start(makeFactory().factory);
    expect((await fetch(base.replace("/mcp", "/other"))).status).toBe(404);
    expect((await fetch(base.replace("/mcp", "/healthz"))).status).toBe(200);
  });
});

describe("KeyRateLimiter", () => {
  it("caps the map size and resets windows", () => {
    const l = new KeyRateLimiter(1, 3);
    for (const k of ["a", "b", "c", "d", "e"]) l.allow(k, 0);
    expect(l.size).toBe(3);
    expect(l.allow("e", 0)).toBe(false);
    expect(l.allow("e", 60_000)).toBe(true);
    l.cleanup(200_000);
    expect(l.size).toBe(0);
  });
});

describe("bearerKey", () => {
  it("accepts only well-formed dn_live_ bearer keys", () => {
    expect(bearerKey(`Bearer ${KEY_A}`)).toBe(KEY_A);
    expect(bearerKey(`bearer ${KEY_A}`)).toBe(KEY_A);
    expect(bearerKey(undefined)).toBeNull();
    expect(bearerKey(KEY_A)).toBeNull();
    expect(bearerKey("Bearer dn_live_short")).toBeNull();
    expect(bearerKey("Basic abc")).toBeNull();
  });
});

describe("parseHttpConfig", () => {
  it("returns null in stdio mode", () => {
    expect(parseHttpConfig({}, [])).toBeNull();
  });

  it("enables via env or --http with safe defaults", () => {
    const c = parseHttpConfig({ DOMINUSNODE_MCP_HTTP_PORT: "4000" }, [])!;
    expect(c.port).toBe(4000);
    expect(c.host).toBe("127.0.0.1");
    expect(c.allowedOrigins).toEqual([]);
    expect(parseHttpConfig({}, ["--http"])!.port).toBe(3333);
  });

  it("refuses an operator API key in remote mode", () => {
    expect(() => parseHttpConfig({ DOMINUSNODE_MCP_HTTP_PORT: "4000", DOMINUSNODE_API_KEY: KEY_A }, [])).toThrow(ConfigError);
  });

  it("validates numbers and origins", () => {
    const env = { DOMINUSNODE_MCP_HTTP_PORT: "4000" };
    expect(() => parseHttpConfig({ ...env, DOMINUSNODE_MCP_HTTP_PORT: "abc" }, [])).toThrow(ConfigError);
    expect(() => parseHttpConfig({ ...env, DOMINUSNODE_MCP_SESSION_IDLE_MS: "NaN" }, [])).toThrow(ConfigError);
    expect(() => parseHttpConfig({ ...env, DOMINUSNODE_MCP_SESSION_IDLE_MS: "5" }, [])).toThrow(ConfigError);
    expect(() => parseHttpConfig({ ...env, DOMINUSNODE_MCP_RATE_LIMIT_PER_MIN: "0" }, [])).toThrow(ConfigError);
    expect(() => parseHttpConfig({ ...env, DOMINUSNODE_MCP_MAX_BODY_BYTES: "99999999" }, [])).toThrow(ConfigError);
    expect(() => parseHttpConfig({ ...env, DOMINUSNODE_MCP_ALLOWED_ORIGINS: "https://a.example/path" }, [])).toThrow(ConfigError);
    expect(() => parseHttpConfig({ ...env, DOMINUSNODE_MCP_HTTP_HOST: "bad host" }, [])).toThrow(ConfigError);
    const ok = parseHttpConfig({ ...env, DOMINUSNODE_MCP_ALLOWED_ORIGINS: "https://a.example, https://b.example:8443" }, [])!;
    expect(ok.allowedOrigins).toEqual(["https://a.example", "https://b.example:8443"]);
  });
});

describe("defaultSessionFactory", () => {
  it("registers the standard authenticated tool set on a per-key config copy", async () => {
    const { TokenManager } = await import("./token-manager.js");
    const init = vi.spyOn(TokenManager.prototype, "initialize").mockResolvedValue(undefined);
    const { defaultSessionFactory } = await import("./http-server.js");
    const { parseConfig } = await import("./config.js");
    const { countTools } = await import("./register.js");
    const { AUTHENTICATED_TOOLS } = await import("../tests/tool-list.js");
    const base = parseConfig({});
    const s = await defaultSessionFactory(base)(KEY_A);
    expect(init).toHaveBeenCalledWith(KEY_A);
    expect(countTools(s.server)).toBe(AUTHENTICATED_TOOLS.length);
    expect(base.apiKey).toBeNull();
    s.dispose();
    init.mockRestore();
  });
});
