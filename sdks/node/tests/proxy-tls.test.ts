import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";
import * as tls from "node:tls";
import type { AddressInfo, Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import { DominusNodeClient } from "../src/client.js";
import { ProxyError, ValidationError } from "../src/errors.js";
import { API_KEY } from "./helpers.js";

const fx = path.join(__dirname, "fixtures");
const cert = fs.readFileSync(path.join(fx, "test-proxy-tls.crt"));
const key = fs.readFileSync(path.join(fx, "test-proxy-tls.key"));

describe("gatewayTls (HTTPS proxy)", () => {
  let server: https.Server | undefined;
  afterEach(() => new Promise<void>((r) => { if (!server) return r(); server.closeAllConnections(); for (const s of sockets) s.destroy(); sockets.length = 0; server.close(() => r()); }));
  const sockets: Socket[] = [];

  async function tlsGateway(onConnect: (req: IncomingMessage, sock: Socket) => void, onRequest?: (req: IncomingMessage, res: import("node:http").ServerResponse) => void) {
    server = https.createServer({ cert, key }, onRequest ?? ((_q, s) => { s.writeHead(500); s.end(); }));
    server.on("connect", (q: IncomingMessage, s: Socket) => { sockets.push(s); onConnect(q, s); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return (server.address() as AddressInfo).port;
  }

  it("sends CONNECT inside TLS to the gateway with Proxy-Authorization, then TLS to the target", async () => {
    let auth = "";
    let line = "";
    const port = await tlsGateway((req, sock) => {
      auth = String(req.headers["proxy-authorization"]);
      line = String(req.url);
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // Act as the target: terminate the inner TLS and answer one request.
      const inner = new tls.TLSSocket(sock, { isServer: true, cert, key });
      let buf = "";
      inner.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\r\n\r\n")) inner.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
      });
    });
    const c = new DominusNodeClient({ proxyHost: "localhost", gatewayTls: { port, ca: cert } });
    c.proxy.setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    // Inner TLS verifies the target's cert against system roots; the test cert is self-signed,
    // so this is expected to fail AFTER the gateway accepted the TLS CONNECT.
    const err = await c.proxy.fetch("https://example.com/x", { apiKey: API_KEY }).catch((e) => e);
    expect(line).toBe("example.com:443");
    expect(Buffer.from(auth.slice(6), "base64").toString()).toBe(`relay:${API_KEY}`);
    expect(err).toBeInstanceOf(ProxyError);
    expect(err.message).not.toContain(API_KEY);
  });

  it("http:// absolute-URI requests also go over TLS to the gateway", async () => {
    let seen = "";
    const port = await tlsGateway(() => undefined, (req, res) => { seen = String(req.url); res.writeHead(200); res.end("hi"); });
    const c = new DominusNodeClient({ proxyHost: "localhost", gatewayTls: { port, ca: cert } });
    c.proxy.setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    const r = await c.proxy.fetch("http://example.com/p", { apiKey: API_KEY, allowHttp: true });
    expect(r.text()).toBe("hi");
    expect(seen).toBe("http://example.com/p");
  });

  it("refuses an unverified gateway certificate (no ca)", async () => {
    let hit = false;
    const port = await tlsGateway((_r, s) => { hit = true; s.destroy(); });
    const c = new DominusNodeClient({ proxyHost: "localhost", gatewayTls: { port } });
    c.proxy.setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    const err = await c.proxy.fetch("https://example.com/", { apiKey: API_KEY }).catch((e) => e);
    expect(err).toBeInstanceOf(ProxyError);
    expect(hit).toBe(false);
  });

  it("buildUrl prefers https:// on the TLS port when configured", () => {
    const c = new DominusNodeClient({ proxyHost: "proxy.example.com", gatewayTls: true });
    expect(c.proxy.buildUrl({ apiKey: API_KEY })).toMatch(/^https:\/\/relay:dn_live_[^@]+@proxy\.example\.com:8443$/);
    expect(c.proxy.buildUrl({ apiKey: API_KEY, protocol: "http" })).toMatch(/:8080$/);
    const plain = new DominusNodeClient({ proxyHost: "proxy.example.com" });
    expect(plain.proxy.buildUrl({ apiKey: API_KEY })).toMatch(/^http:\/\/.*:8080$/);
    expect(() => plain.proxy.buildUrl({ apiKey: API_KEY, protocol: "https" })).toThrow(ValidationError);
  });

  it("validates gatewayTls config", () => {
    expect(() => new DominusNodeClient({ gatewayTls: { port: 0 } })).toThrow(ValidationError);
    expect(() => new DominusNodeClient({ gatewayTls: { servername: "bad name" } })).toThrow(ValidationError);
    expect(() => new DominusNodeClient({ gatewayTls: "yes" as unknown as boolean })).toThrow(ValidationError);
  });
});
