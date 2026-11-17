import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerFetchTools,
  resolveUserAgent,
  shapeBody,
  USER_AGENT_PRESETS,
  DEFAULT_MAX_LENGTH,
  MAX_MAX_LENGTH,
} from "../src/tools/fetch.js";
import { htmlToMarkdown, isHtmlContentType, decodeEntities } from "../src/html-to-markdown.js";
import type { McpConfig } from "../src/config.js";
import { PACKAGE_VERSION } from "../src/version.js";

const API_KEY = "dn_live_" + "b".repeat(32);

const PAGE = `<!doctype html><html><head><title>Demo &amp; Test</title>
<style>body{color:red}</style><script>alert("x")</script></head>
<body><!-- hidden comment --><h1>Hello</h1><p>Some <strong>bold</strong> and <em>soft</em> text with a
<a href="https://example.org/a">link</a> and <a href="javascript:alert(1)">bad</a>.</p>
<ul><li>one</li><li>two</li></ul><pre>  keep   spacing</pre><noscript>no js</noscript></body></html>`;

let gateway: http.Server;
let port = 0;
const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];

beforeAll(async () => {
  gateway = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/html") {
      const body = Buffer.from(PAGE, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length });
      res.end(body);
    } else if (path === "/long") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("0123456789".repeat(5));
    } else if (path === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"a":"<b>x</b>"}');
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
  port = (gateway.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => gateway.close(() => r())));
afterEach(() => {
  seen.length = 0;
});

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
  const call = (args: Record<string, unknown>) => {
    const parsed = tool.inputSchema.parse({ allow_http: true, timeout_ms: 5000, ...args });
    return tool.handler(parsed, {} as never) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  };
  return { call, schema: tool.inputSchema };
}

const BASE = "http://93.184.216.34";

describe("htmlToMarkdown", () => {
  it("converts structure to markdown and strips script/style/noscript/comments", () => {
    const md = htmlToMarkdown(PAGE);
    expect(md).toContain("# Hello");
    expect(md).toContain("**bold**");
    expect(md).toContain("_soft_");
    expect(md).toContain("[link](https://example.org/a)");
    expect(md).toContain("- one");
    expect(md).toContain("- two");
    expect(md).toContain("```\n  keep   spacing\n```");
    expect(md).not.toMatch(/alert|color:red|no js|hidden comment|javascript:/);
    expect(md).not.toContain("<");
    // unsafe link keeps text only
    expect(md).toContain("bad");
  });

  it("produces plain text without markup in text mode", () => {
    const t = htmlToMarkdown(PAGE, "text");
    expect(t.startsWith("Demo & Test")).toBe(true);
    expect(t).toContain("Hello");
    expect(t).not.toMatch(/\*\*|\[link\]|#|alert/);
  });

  it("uses the title as heading when the body has no leading h1", () => {
    expect(htmlToMarkdown("<title>T</title><p>x</p>")).toBe("# T\n\nx");
  });

  it("decodes entities and escapes markdown in text", () => {
    expect(decodeEntities("&lt;&#65;&#x42;&bogus;&#0;")).toBe("<AB&bogus;�");
    expect(htmlToMarkdown("<p>a*b_c</p>")).toBe("a\\*b\\_c");
  });

  it("is deterministic and handles malformed input", () => {
    const bad = "<div><p>unclosed <a href='x'>t <script>never closed";
    expect(htmlToMarkdown(bad)).toBe(htmlToMarkdown(bad));
    expect(htmlToMarkdown(bad)).not.toContain("never closed");
    expect(htmlToMarkdown("a < b > c")).toBe("a < b > c");
  });

  it("converts a large adversarial document in bounded time", () => {
    const big = "<div a='".repeat(2000) + "<p>x</p>".repeat(200_000) + "<".repeat(100_000);
    const t0 = Date.now();
    htmlToMarkdown(big);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("detects HTML content types only", () => {
    expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlContentType("application/xhtml+xml")).toBe(true);
    expect(isHtmlContentType("application/json")).toBe(false);
    expect(isHtmlContentType(undefined)).toBe(false);
  });
});

describe("shapeBody pagination", () => {
  const body = "abcdefghij";
  it("returns the first window and the next start index", () => {
    expect(shapeBody(body, "text/plain", "markdown", 0, 4)).toMatchObject({ text: "abcd", nextStart: 4, totalChars: 10 });
  });
  it("returns the last partial window without a next index", () => {
    expect(shapeBody(body, "text/plain", "markdown", 8, 4)).toMatchObject({ text: "ij", nextStart: null });
  });
  it("exact fit has no next index", () => {
    expect(shapeBody(body, "text/plain", "raw", 0, 10)).toMatchObject({ text: body, nextStart: null });
  });
  it("start past the end returns empty", () => {
    expect(shapeBody(body, "text/plain", "raw", 10, 5)).toMatchObject({ text: "", returnedChars: 0, nextStart: null });
  });
  it("does not split a surrogate pair", () => {
    const r = shapeBody("a\u{1F600}b", "text/plain", "raw", 0, 2);
    expect(r.text).toBe("a");
    expect(r.nextStart).toBe(1);
  });
  it("leaves non-HTML untouched in every format", () => {
    expect(shapeBody("<b>x</b>", "application/json", "markdown", 0, 100).text).toBe("<b>x</b>");
  });
});

describe("resolveUserAgent", () => {
  it("maps presets and default", () => {
    expect(resolveUserAgent(undefined)).toBeUndefined();
    expect(resolveUserAgent("default")).toBeUndefined();
    for (const [k, v] of Object.entries(USER_AGENT_PRESETS)) expect(resolveUserAgent(k)).toBe(v);
  });
  it("accepts bounded free-form strings", () => {
    expect(resolveUserAgent("MyAgent/1.0 (+https://example.org)")).toBe("MyAgent/1.0 (+https://example.org)");
  });
  it.each(["a\r\nX-Injected: 1", "a\nb", "tab\there", "x".repeat(257), "", "café"])("rejects %j", (ua) => {
    expect(() => resolveUserAgent(ua)).toThrow(/user_agent/);
  });
});

describe("dominusnode_fetch formats", () => {
  it("defaults to markdown for HTML and reports billed bytes vs returned chars", async () => {
    const { call } = setup();
    const r = await call({ url: `${BASE}/html` });
    expect(r.isError).toBeFalsy();
    const text = r.content[0].text;
    expect(text).toContain("# Hello");
    expect(text).not.toContain("<script>");
    const bytes = Buffer.byteLength(PAGE, "utf8");
    expect(text).toContain(`Billed bytes: ${bytes}`);
    const md = htmlToMarkdown(PAGE);
    expect(text).toContain(`Returned chars: ${md.length} of ${md.length} (markdown, start_index=0)`);
  });

  it("format=text and format=raw", async () => {
    const { call } = setup();
    const t = (await call({ url: `${BASE}/html`, format: "text" })).content[0].text;
    expect(t).toContain("(text, start_index=0)");
    expect(t).not.toContain("**bold**");
    const raw = (await call({ url: `${BASE}/html`, format: "raw" })).content[0].text;
    expect(raw).toContain("<script>alert");
    expect(raw).toContain(`Returned chars: ${PAGE.length} of ${PAGE.length} (raw`);
  });

  it("does not convert JSON", async () => {
    const { call } = setup();
    const t = (await call({ url: `${BASE}/json` })).content[0].text;
    expect(t).toContain('{"a":"<b>x</b>"}');
    expect(t).toContain("(raw, start_index=0)");
  });

  it("paginates with a next start_index footer, billing the full transfer each time", async () => {
    const { call } = setup();
    const p1 = (await call({ url: `${BASE}/long`, max_length: 20 })).content[0].text;
    expect(p1).toContain("Billed bytes: 50");
    expect(p1).toContain("Returned chars: 20 of 50");
    expect(p1).toContain("[truncated, next start_index=20]");
    const p3 = (await call({ url: `${BASE}/long`, max_length: 20, start_index: 40 })).content[0].text;
    expect(p3).toContain("Returned chars: 10 of 50");
    expect(p3).not.toContain("truncated, next");
    const past = (await call({ url: `${BASE}/long`, start_index: 60 })).content[0].text;
    expect(past).toContain("past the end");
  });

  it("schema bounds max_length/start_index/format/user_agent", () => {
    const { schema } = setup();
    const u = { url: "https://example.org" };
    expect(schema.parse(u).max_length).toBe(DEFAULT_MAX_LENGTH);
    expect(schema.parse(u).format).toBe("markdown");
    expect(schema.safeParse({ ...u, max_length: MAX_MAX_LENGTH + 1 }).success).toBe(false);
    expect(schema.safeParse({ ...u, max_length: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...u, start_index: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...u, format: "html" }).success).toBe(false);
    expect(schema.safeParse({ ...u, user_agent: "x".repeat(257) }).success).toBe(false);
  });

  it("sends the chosen preset User-Agent and still strips header overrides", async () => {
    const { call } = setup();
    const r = await call({
      url: `${BASE}/`,
      user_agent: "firefox-desktop",
      headers: { Authorization: "Bearer s", "Proxy-Authorization": "Basic x", "User-Agent": "spoof" },
    });
    expect(r.isError).toBeFalsy();
    const h = seen[0].headers;
    expect(h["user-agent"]).toBe(USER_AGENT_PRESETS["firefox-desktop"]);
    expect(h["authorization"]).toBeUndefined();
    // Proxy-Authorization is the gateway credential, never the caller's value
    expect(String(h["proxy-authorization"])).not.toBe("Basic x");
    expect(r.content[0].text).toContain("Authorization, Proxy-Authorization, User-Agent");
  });

  it("default user agent is the package UA; free-form is passed through", async () => {
    const { call } = setup();
    await call({ url: `${BASE}/` });
    expect(seen[0].headers["user-agent"]).toBe(`dominusnode-mcp-server/${PACKAGE_VERSION}`);
    await call({ url: `${BASE}/`, user_agent: "ResearchBot/2.0" });
    expect(seen[1].headers["user-agent"]).toBe("ResearchBot/2.0");
  });

  it("rejects a CR/LF user agent before contacting the gateway", async () => {
    const { call } = setup();
    const r = await call({ url: `${BASE}/`, user_agent: "a\r\nX-Evil: 1" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("user_agent");
    expect(seen).toHaveLength(0);
  });

  it("keeps SSRF checks", async () => {
    const { call } = setup();
    const r = await call({ url: "http://127.0.0.1/", format: "text" });
    expect(r.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });
});
