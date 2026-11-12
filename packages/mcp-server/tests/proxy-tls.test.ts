import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo, Socket } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseConfig, ConfigError, type McpConfig } from "../src/config.js";
import { proxyFetch, gatewayDescription } from "../src/proxy-fetch.js";

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const certPath = path.join(fx, "test-proxy-tls.crt");
const cert = fs.readFileSync(certPath);
const key = fs.readFileSync(path.join(fx, "test-proxy-tls.key"));
const API_KEY = "dn_live_tlstest0123456789";
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("DOMINUSNODE_PROXY_URL config", () => {
  it("defaults to the TLS gateway on 8443", () => {
    const c = parseConfig({});
    expect(c.proxyTls).toEqual({ port: 8443, ca: undefined });
    expect(gatewayDescription(c)).toBe("https://proxy.dominusnode.com:8443 (TLS)");
  });

  it("uses plaintext only with DOMINUSNODE_PROXY_INSECURE=1 and warns", () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (s: string) => { writes.push(String(s)); return true; };
    try {
      const c = parseConfig({ DOMINUSNODE_PROXY_INSECURE: "1" });
      expect(c.proxyTls).toBeNull();
      expect(gatewayDescription(c)).toBe("http://proxy.dominusnode.com:8080");
    } finally {
      (process.stderr as { write: unknown }).write = orig;
    }
    expect(writes.join("")).toMatch(/INSECURE/);
    expect(parseConfig({ DOMINUSNODE_PROXY_INSECURE: "true" }).proxyTls).not.toBeNull();
    expect(() => parseConfig({ DOMINUSNODE_PROXY_INSECURE: "1", DOMINUSNODE_PROXY_URL: "https://relay.example.com" })).toThrow(ConfigError);
  });

  it("parses https://host[:port] and sets the proxy host", () => {
    const c = parseConfig({ DOMINUSNODE_PROXY_URL: "https://Relay.Example.com:9443" });
    expect(c.proxyHost).toBe("relay.example.com");
    expect(c.proxyTls).toEqual({ port: 9443, ca: undefined });
    expect(parseConfig({ DOMINUSNODE_PROXY_URL: "https://relay.example.com" }).proxyTls?.port).toBe(8443);
    expect(gatewayDescription(c)).toBe("https://relay.example.com:9443 (TLS)");
  });

  it("loads an optional CA file", () => {
    const c = parseConfig({ DOMINUSNODE_PROXY_URL: "https://relay.example.com", DOMINUSNODE_PROXY_CA_FILE: certPath });
    expect(c.proxyTls?.ca?.equals(cert)).toBe(true);
    expect(() => parseConfig({ DOMINUSNODE_PROXY_URL: "https://relay.example.com", DOMINUSNODE_PROXY_CA_FILE: "/nonexistent/ca.pem" })).toThrow(ConfigError);
  });

  it.each([
    ["http://relay.example.com", /https/],
    ["https://user:dn_live_x@relay.example.com", /credentials/],
    ["https://relay.example.com/path", /path/],
    ["https://relay.example.com:0", /port|valid URL/],
    ["https://localhost:8443", /localhost/],
    ["https://10.0.0.1", /private/],
    ["not a url", /valid URL/],
  ])("rejects %s", (url, re) => {
    expect(() => parseConfig({ DOMINUSNODE_PROXY_URL: url })).toThrow(re);
  });

  it("rejects a conflicting DOMINUSNODE_PROXY_HOST", () => {
    expect(() => parseConfig({ DOMINUSNODE_PROXY_URL: "https://a.example.com", DOMINUSNODE_PROXY_HOST: "b.example.com" })).toThrow(/different hosts/);
  });
});

describe("proxyFetch over a TLS gateway", () => {
  let server: https.Server | undefined;
  const sockets: Socket[] = [];
  afterEach(() => new Promise<void>((r) => {
    if (!server) return r();
    server.closeAllConnections();
    for (const s of sockets) s.destroy();
    sockets.length = 0;
    server.close(() => r());
  }));

  async function gateway(onRequest: (q: IncomingMessage, s: ServerResponse) => void, onConnect?: (q: IncomingMessage, s: Socket) => void): Promise<number> {
    server = https.createServer({ cert, key }, onRequest);
    server.on("connect", (q: IncomingMessage, s: Socket) => { sockets.push(s); (onConnect ?? ((_q, so) => so.destroy()))(q, s); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return (server.address() as AddressInfo).port;
  }

  function cfg(port: number, ca?: Buffer): McpConfig {
    return {
      apiKey: API_KEY, apiUrl: "https://api.example.com", proxyHost: "localhost", httpProxyPort: 1, socks5ProxyPort: 1,
      proxyTls: { port, ca }, fetchTimeoutMs: 5000, fetchMaxResponseBytes: 1024 * 1024, mcpAgentSecret: "",
      walletKeyFile: null, nodeKeyFile: "/tmp/x",
    };
  }

  it("sends absolute-URI requests with Proxy-Authorization inside TLS", async () => {
    let seen = { url: "", auth: "" };
    const port = await gateway((q, s) => { seen = { url: String(q.url), auth: String(q.headers["proxy-authorization"]) }; s.writeHead(200, { "content-type": "text/plain" }); s.end("hello"); });
    const r = await proxyFetch(cfg(port, cert), { url: "http://example.com/a", allowHttp: true }, publicLookup);
    expect(r.status).toBe(200);
    expect(r.body).toBe("hello");
    expect(seen.url).toBe("http://example.com/a");
    expect(Buffer.from(seen.auth.slice(6), "base64").toString()).toBe(`allowhttp-1:${API_KEY}`);
  });

  it("sends CONNECT inside TLS for https targets", async () => {
    let line = "";
    const port = await gateway(() => undefined, (q, s) => { line = String(q.url); s.end("HTTP/1.1 402 Payment Required\r\n\r\n"); });
    await expect(proxyFetch(cfg(port, cert), { url: "https://example.com/" }, publicLookup)).rejects.toThrow(/402/);
    expect(line).toBe("example.com:443");
  });

  it("refuses a gateway certificate it cannot verify", async () => {
    let hits = 0;
    const port = await gateway(() => { hits++; }, () => { hits++; });
    const err = await proxyFetch(cfg(port), { url: "https://example.com/" }, publicLookup).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain(API_KEY);
    expect(hits).toBe(0);
  });
});
