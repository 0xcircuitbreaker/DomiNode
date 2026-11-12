import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { DominusNodeClient } from "../src/client.js";
import { buildProxyUsername } from "../src/proxy-fetch.js";
import { isPrivateIp, validateTargetUrl, assertPublicResolution, normalizeIpv4 } from "../src/ssrf.js";
import { ValidationError, ProxyError, AuthenticationError } from "../src/errors.js";
import { connected, API_KEY, UUID } from "./helpers.js";

describe("buildProxyUsername", () => {
  it("encodes gateway flags with hyphens", () => {
    expect(buildProxyUsername()).toBe("relay");
    expect(buildProxyUsername({ country: "us" })).toBe("country-US");
    expect(buildProxyUsername({ country: "DE", ipClass: "residential", sessionId: "abc123", allowHttp: true }))
      .toBe("country-DE-class-residential-session-abc123-allowhttp-1");
    expect(buildProxyUsername({ ipClass: "mobile", agenticWalletId: UUID.toUpperCase() })).toBe(`class-mobile-wallet-${UUID}`);
    expect(buildProxyUsername({ allowHttp: false })).toBe("relay");
  });
  it("rejects bad flags", () => {
    expect(() => buildProxyUsername({ country: "USA" })).toThrow(ValidationError);
    expect(() => buildProxyUsername({ country: "IR" })).toThrow(/OFAC/);
    expect(() => buildProxyUsername({ ipClass: "isp" as "dc" })).toThrow(ValidationError);
    expect(() => buildProxyUsername({ sessionId: "a-b" })).toThrow(ValidationError);
    expect(() => buildProxyUsername({ sessionId: "a".repeat(65) })).toThrow(ValidationError);
    expect(() => buildProxyUsername({ agenticWalletId: "w1" })).toThrow(ValidationError);
  });
});

describe("proxy.buildUrl", () => {
  it("puts flags in the username and the key in the password", async () => {
    const { client } = await connected();
    expect(client.proxy.buildUrl()).toBe(`http://relay:${API_KEY}@proxy.dominusnode.com:8080`);
    expect(client.proxy.buildUrl({ protocol: "socks5", country: "US", ipClass: "dc" }))
      .toBe(`socks5://country-US-class-dc:${API_KEY}@proxy.dominusnode.com:1080`);
    expect(client.proxy.buildUsername({ sessionId: "s1" })).toBe("session-s1");
  });
  it("needs a key; validates config", () => {
    const c = new DominusNodeClient({ proxyHost: "gw.example", httpProxyPort: 9000 });
    expect(() => c.proxy.buildUrl()).toThrow(AuthenticationError);
    expect(c.proxy.buildUrl({ apiKey: API_KEY })).toBe(`http://relay:${API_KEY}@gw.example:9000`);
    expect(() => c.proxy.buildUrl({ apiKey: "nope" })).toThrow(ValidationError);
    expect(() => new DominusNodeClient({ proxyHost: "evil@host" })).toThrow(ValidationError);
    expect(() => new DominusNodeClient({ httpProxyPort: 70000 })).toThrow(ValidationError);
  });
});

describe("SSRF guard", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "fec0::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "::7f00:1", "0:0:0:0:0:0:0:1", "2001:0:4136::1", "2002:c0a8:101::1",
    "64:ff9b::a00:1", "[::1]", "fe80::1%eth0", "2130706433", "0x7f000001", "0177.0.0.1", "127.1",
  ])("blocks %s", (ip) => expect(isPrivateIp(ip)).toBe(true));

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "example.com"])(
    "allows %s", (ip) => expect(isPrivateIp(ip)).toBe(false));

  it("normalizes odd IPv4 forms", () => {
    expect(normalizeIpv4("0x7f.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIpv4("10.1")).toBe("10.0.0.1");
    expect(normalizeIpv4("example")).toBeNull();
  });

  it.each([
    ["ftp://example.com/", /http/], ["https://u:p@example.com/", /credentials/], ["https://example.com:8443/", /80 and 443/],
    ["https://localhost/", /local/], ["https://foo.localhost/", /local/], ["https://printer.local/", /local/],
    ["https://db.internal/", /local/], ["https://1.0.0.127.in-addr.arpa/", /local/], ["http://127.0.0.1/", /private/],
    ["http://[::1]/", /private/], ["http://0x7f000001/", /private/], ["not a url", /Invalid/],
  ])("validateTargetUrl refuses %s", (url, re) => {
    expect(() => validateTargetUrl(url as string)).toThrow(re as RegExp);
  });

  it("DNS rebinding: any private address in the answer blocks", async () => {
    await expect(assertPublicResolution("x.test", async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]))
      .rejects.toThrow(/private/);
    await expect(assertPublicResolution("x.test", async () => [{ address: "::ffff:169.254.169.254", family: 6 }])).rejects.toThrow(ProxyError);
    await expect(assertPublicResolution("x.test", async () => [])).rejects.toThrow(/no addresses/);
    await expect(assertPublicResolution("x.test", async () => { throw new Error("NXDOMAIN"); })).rejects.toThrow(/DNS/);
    await expect(assertPublicResolution("x.test", async () => [{ address: "93.184.216.34", family: 4 }])).resolves.toBeUndefined();
  });
});

describe("proxy.fetch (local fake gateway)", () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function gateway(handler: http.RequestListener, onConnect?: (req: http.IncomingMessage, sock: import("node:net").Socket) => void) {
    server = http.createServer(handler);
    if (onConnect) server.on("connect", onConnect);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const c2 = new DominusNodeClient({ proxyHost: "127.0.0.1", httpProxyPort: port });
    c2.proxy.setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    return c2;
  }

  it("http:// (allowHttp): absolute-URI request with Basic proxy auth; redirect returned, not followed", async () => {
    const seen: Array<{ url?: string; auth?: string; host?: string; extra?: string }> = [];
    const c = await gateway((req, res) => {
      seen.push({ url: req.url, auth: req.headers["proxy-authorization"], host: req.headers.host, extra: req.headers["x-test"] as string });
      res.writeHead(302, { Location: "http://127.0.0.1/admin" });
      res.end("moved");
    });
    const r = await c.proxy.fetch("http://example.com/path?q=1", {
      apiKey: API_KEY, allowHttp: true, country: "US", headers: { "X-Test": "1", Authorization: "drop-me" },
    });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("http://127.0.0.1/admin");
    expect(r.text()).toBe("moved");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://example.com/path?q=1");
    expect(seen[0].host).toBe("example.com");
    expect(seen[0].extra).toBe("1");
    expect(Buffer.from(seen[0].auth!.slice(6), "base64").toString()).toBe(`country-US-allowhttp-1:${API_KEY}`);
  });

  it("truncates bodies at maxBytes", async () => {
    const c = await gateway((_req, res) => { res.writeHead(200); res.end(Buffer.alloc(5000, 0x61)); });
    const r = await c.proxy.fetch("http://example.com/", { apiKey: API_KEY, allowHttp: true, maxBytes: 1000 });
    expect(r.body.length).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it("HEAD returns no body", async () => {
    const c = await gateway((_req, res) => { res.writeHead(200, { "content-length": "10" }); res.end(); });
    const r = await c.proxy.fetch("http://example.com/", { apiKey: API_KEY, allowHttp: true, method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
  });

  it("https:// uses CONNECT host:443 and reports a refused tunnel", async () => {
    let connectLine = "";
    let auth = "";
    const c = await gateway(() => undefined, (req, sock) => {
      connectLine = String(req.url);
      auth = String(req.headers["proxy-authorization"]);
      sock.end("HTTP/1.1 402 Payment Required\r\nContent-Length: 0\r\n\r\n");
    });
    const err = await c.proxy.fetch("https://example.com/x", { apiKey: API_KEY, ipClass: "dc" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProxyError);
    expect(err.statusCode).toBe(402);
    expect(connectLine).toBe("example.com:443");
    expect(Buffer.from(auth.slice(6), "base64").toString()).toBe(`class-dc:${API_KEY}`);
  });

  it("refuses before any network I/O", async () => {
    let hits = 0;
    const c = await gateway(() => { hits++; });
    await expect(c.proxy.fetch("http://example.com/", { apiKey: API_KEY })).rejects.toThrow(/allowHttp/);
    await expect(c.proxy.fetch("https://example.com/", { apiKey: API_KEY, method: "POST" as "GET" })).rejects.toThrow(/GET and HEAD/);
    await expect(c.proxy.fetch("https://example.com/", { apiKey: API_KEY, headers: { "X-A": "b\r\nInjected: 1" } })).rejects.toThrow(/invalid/);
    await expect(c.proxy.fetch("https://169.254.169.254/", { apiKey: API_KEY })).rejects.toThrow(/private/);
    c.proxy.setLookup(async () => [{ address: "127.0.0.1", family: 4 }]);
    await expect(c.proxy.fetch("https://rebind.example/", { apiKey: API_KEY })).rejects.toThrow(/private/);
    expect(hits).toBe(0);
  });

  it("error messages never contain the key", async () => {
    const c = new DominusNodeClient({ proxyHost: "127.0.0.1", httpProxyPort: 1 });
    c.proxy.setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    const err = await c.proxy.fetch("https://example.com/", { apiKey: API_KEY }).catch((e) => e);
    expect(err).toBeInstanceOf(ProxyError);
    expect(err.message).not.toContain(API_KEY);
  });
});

describe("default hosts", () => {
  it("point at the Daedalus Development Group deployment", async () => {
    const { DEFAULT_BASE_URL, DEFAULT_PROXY_HOST } = await import("../src/index.js");
    expect(DEFAULT_BASE_URL).toBe("https://api.dominusnode.com");
    expect(DEFAULT_PROXY_HOST).toBe("proxy.dominusnode.com");
  });
});
