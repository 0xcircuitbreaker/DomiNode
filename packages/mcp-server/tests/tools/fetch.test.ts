import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFetchTools } from "../../src/tools/fetch.js";
import type { McpConfig } from "../../src/config.js";
import { PACKAGE_VERSION } from "../../src/version.js";

const API_KEY = "dn_live_" + "a".repeat(32);

/** Fake proxy gateway: records requests, answers plain HTTP proxying and rejects CONNECT with 407. */
let gateway: http.Server;
let port = 0;
const seen: Array<{ method: string; url: string; auth: string; headers?: http.IncomingHttpHeaders }> = [];

beforeAll(async () => {
  gateway = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: String(req.headers["proxy-authorization"] ?? ""), headers: req.headers });
    res.writeHead(200, { "content-type": "text/plain", "x-dominusnode-exit-visible": "1" });
    res.end("hello from exit");
  });
  gateway.on("connect", (req, socket) => {
    seen.push({ method: "CONNECT", url: req.url ?? "", auth: String(req.headers["proxy-authorization"] ?? "") });
    socket.end(`HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\nleak ${API_KEY}`);
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
  port = (gateway.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => gateway.close(() => r())));

function decodeAuth(h: string): string {
  return Buffer.from(h.replace(/^Basic /, ""), "base64").toString("utf8");
}

function setup() {
  const config: McpConfig = {
    apiKey: API_KEY,
    apiUrl: "http://localhost:3000",
    proxyHost: "127.0.0.1",
    httpProxyPort: port,
    socks5ProxyPort: 1080,
    fetchTimeoutMs: 5000,
    fetchMaxResponseBytes: 10 * 1024 * 1024,
    mcpAgentSecret: "",
    walletKeyFile: null,
    nodeKeyFile: "/nonexistent/node.json",
  };
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerFetchTools(server, config);
  const tool = (server as any)._registeredTools["dominusnode_fetch"];
  return (args: Record<string, unknown>) =>
    tool.handler({ method: "GET", timeout_ms: 5000, allow_http: false, ...args }, {} as never) as Promise<{
      isError?: boolean;
      content: Array<{ text: string }>;
    }>;
}

describe("dominusnode_fetch (relay)", () => {
  afterEach(() => {
    seen.length = 0;
    vi.restoreAllMocks();
  });

  it("rejects non-http(s) URLs", async () => {
    const r = await setup()({ url: "file:///etc/passwd" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Only http: and https:");
  });

  it("refuses plaintext http without allow_http and explains exit visibility", async () => {
    const r = await setup()({ url: "http://93.184.216.34/" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/allow_http/);
    expect(r.content[0].text).toMatch(/exit node can read/);
    expect(seen).toHaveLength(0);
  });

  it("sends full-URL HTTP request with allowhttp-1 + routing flags in username, key in password", async () => {
    const r = await setup()({
      url: "http://93.184.216.34/path?q=1",
      allow_http: true,
      country: "de",
      ip_class: "residential",
      session_id: "abc123",
    });
    expect(r.isError).toBeFalsy();
    expect(seen[0].url).toBe("http://93.184.216.34/path?q=1");
    expect(decodeAuth(seen[0].auth)).toBe(`country-DE-class-residential-session-abc123-allowhttp-1:${API_KEY}`);
    expect(r.content[0].text).toContain("EXIT-VISIBLE PLAINTEXT");
    expect(r.content[0].text).toContain("hello from exit");
  });

  it("uses a CONNECT tunnel for https and scrubs credentials from errors", async () => {
    const r = await setup()({ url: "https://93.184.216.34/", ip_class: "dc" });
    expect(seen[0].method).toBe("CONNECT");
    expect(seen[0].url).toBe("93.184.216.34:443");
    expect(decodeAuth(seen[0].auth)).toBe(`class-dc:${API_KEY}`);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toContain(API_KEY);
  });

  it("drops blocked headers, says so, and sends the package User-Agent", async () => {
    const r = await setup()({
      url: "http://93.184.216.34/",
      allow_http: true,
      headers: { Authorization: "Bearer secret", "User-Agent": "spoof", Accept: "text/html" },
    });
    expect(r.isError).toBeFalsy();
    const h = seen[0].headers!;
    expect(h["authorization"]).toBeUndefined();
    expect(h["user-agent"]).toBe(`dominusnode-mcp-server/${PACKAGE_VERSION}`);
    expect(h["accept"]).toBe("text/html");
    expect(r.content[0].text).toContain("request headers not sent (blocked): Authorization, User-Agent");
  });

  it("documents the blocked headers in the tool description", () => {
    const server = new McpServer({ name: "t", version: "1" });
    registerFetchTools(server, { proxyHost: "x" } as McpConfig);
    const d = (server as any)._registeredTools["dominusnode_fetch"].description as string;
    expect(d).toMatch(/Authorization/);
    expect(d).toMatch(/User-Agent/);
  });

  it("sends only allowhttp-1 when no routing flags are set", async () => {
    await setup()({ url: "http://93.184.216.34/", allow_http: true });
    expect(decodeAuth(seen[0].auth)).toBe(`allowhttp-1:${API_KEY}`);
  });

  it.each([
    "http://127.0.0.1/",
    "https://10.0.0.5/",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://0x7f000001/",
    "https://2130706433/",
    "https://foo.localhost/",
    "https://svc.internal/",
    "https://93.184.216.34:8443/",
    "https://user:pass@example.com/",
  ])("blocks SSRF / disallowed target %s before contacting the gateway", async (url) => {
    const r = await setup()({ url, allow_http: true });
    expect(r.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("schema rejects POST", () => {
    const server = new McpServer({ name: "t", version: "1" });
    registerFetchTools(server, { apiKey: API_KEY } as McpConfig);
    const schema = (server as any)._registeredTools["dominusnode_fetch"].inputSchema;
    expect(schema.safeParse({ url: "https://example.com", method: "POST" }).success).toBe(false);
    expect(schema.safeParse({ url: "https://example.com", session_id: "bad-id!" }).success).toBe(false);
    expect(schema.safeParse({ url: "https://example.com", ip_class: "satellite" }).success).toBe(false);
  });
});
