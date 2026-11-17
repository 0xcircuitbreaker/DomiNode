import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as path from "node:path";
import type { AddressInfo, Socket } from "node:net";
import { DominusNodeClient } from "../src/client.js";
import { ValidationError } from "../src/errors.js";
import { isLoopbackHost, type Forwarder } from "../src/forwarder.js";
import { API_KEY } from "./helpers.js";

const fx = path.join(__dirname, "fixtures");
const cert = fs.readFileSync(path.join(fx, "test-proxy-tls.crt"));
const key = fs.readFileSync(path.join(fx, "test-proxy-tls.key"));

let gateway: https.Server | undefined;
let fwd: Forwarder | undefined;
const gwSockets: Socket[] = [];

afterEach(async () => {
  await fwd?.close();
  fwd = undefined;
  if (gateway) {
    for (const s of gwSockets) s.destroy();
    gwSockets.length = 0;
    gateway.closeAllConnections();
    await new Promise<void>((r) => gateway!.close(() => r()));
    gateway = undefined;
  }
});

interface Seen { auth: string; line: string; tlsVersion: string }

async function fakeGateway(seen: Seen, connectStatus = 200): Promise<number> {
  gateway = https.createServer({ cert, key }, (req, res) => {
    seen.auth = String(req.headers["proxy-authorization"]);
    seen.line = String(req.url);
    seen.tlsVersion = String((req.socket as import("node:tls").TLSSocket).getProtocol());
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("plain-ok");
  });
  gateway.on("connect", (req: http.IncomingMessage, sock: Socket) => {
    gwSockets.push(sock);
    seen.auth = String(req.headers["proxy-authorization"]);
    seen.line = String(req.url);
    seen.tlsVersion = String((sock as import("node:tls").TLSSocket).getProtocol());
    if (connectStatus !== 200) { sock.end(`HTTP/1.1 ${connectStatus} No\r\nContent-Length: 0\r\n\r\n`); return; }
    sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    sock.on("data", (d) => sock.write(Buffer.concat([Buffer.from("echo:"), d])));
  });
  await new Promise<void>((r) => gateway!.listen(0, "127.0.0.1", () => r()));
  return (gateway.address() as AddressInfo).port;
}

function client(port: number): DominusNodeClient {
  return new DominusNodeClient({ proxyHost: "localhost", gatewayTls: { port, ca: cert } });
}

function basic(user: string): string {
  return "Basic " + Buffer.from(`${user}:x`).toString("base64");
}

/** Send a CONNECT through the forwarder; resolves with everything read until `until` matches or close. */
function rawConnect(f: Forwarder, auth: string | null, payload?: string, until = /\r\n\r\n/): Promise<string> {
  const u = new URL(f.server);
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(u.port), u.hostname);
    let buf = "";
    let sent = false;
    s.on("data", (d) => {
      buf += d.toString();
      if (payload && !sent && buf.includes("200 Connection Established")) { sent = true; s.write(payload); return; }
      if ((!payload || sent) && until.test(buf.slice(buf.indexOf("\r\n\r\n") + 4)) ) { s.destroy(); resolve(buf); }
    });
    s.on("close", () => resolve(buf));
    s.on("error", reject);
    s.write(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`);
  });
}

describe("proxy.startForwarder", () => {
  it("binds to loopback only", async () => {
    const port = await fakeGateway({ auth: "", line: "", tlsVersion: "" });
    const c = client(port);
    for (const host of ["0.0.0.0", "192.168.1.10", "::", "example.org"]) {
      await expect(c.proxy.startForwarder({ host, apiKey: API_KEY })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    fwd = await c.proxy.startForwarder({ apiKey: API_KEY });
    expect(fwd.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(fwd.url).not.toContain(API_KEY);
  });

  it("refuses bad flags and gatewayTls:false", async () => {
    const c = client(8443);
    await expect(c.proxy.startForwarder({ apiKey: API_KEY, flags: "a b\r\nX: y" })).rejects.toBeInstanceOf(ValidationError);
    const plain = new DominusNodeClient({ proxyHost: "localhost", gatewayTls: false });
    await expect(plain.proxy.startForwarder({ apiKey: API_KEY })).rejects.toBeInstanceOf(ValidationError);
  });

  it("requires the per-start token", async () => {
    const seen = { auth: "", line: "", tlsVersion: "" };
    const port = await fakeGateway(seen);
    fwd = await client(port).proxy.startForwarder({ apiKey: API_KEY });
    expect(fwd.username).toMatch(/^[0-9a-f]{32}$/);
    expect(await rawConnect(fwd, null)).toMatch(/^HTTP\/1\.1 407/);
    expect(await rawConnect(fwd, basic("wrong-token"))).toMatch(/^HTTP\/1\.1 407/);
    const r = await new Promise<number>((resolve) => {
      const u = new URL(fwd!.server);
      http.get({ host: u.hostname, port: u.port, path: "http://example.com/" }, (res) => { res.resume(); resolve(res.statusCode!); });
    });
    expect(r).toBe(407);
    expect(seen.auth).toBe("");
  });

  it("injects key and flags over TLS 1.3 on CONNECT and pipes data", async () => {
    const seen = { auth: "", line: "", tlsVersion: "" };
    const port = await fakeGateway(seen);
    fwd = await client(port).proxy.startForwarder({ apiKey: API_KEY, flags: "country-US-class-residential" });
    const out = await rawConnect(fwd, basic(fwd.username!), "ping", /echo:ping/);
    expect(out).toContain("200 Connection Established");
    expect(out).toContain("echo:ping");
    expect(seen.line).toBe("example.com:443");
    expect(seen.tlsVersion).toBe("TLSv1.3");
    expect(Buffer.from(seen.auth.slice(6), "base64").toString()).toBe(`country-US-class-residential:${API_KEY}`);
  });

  it("forwards absolute-URI http requests with the key injected", async () => {
    const seen = { auth: "", line: "", tlsVersion: "" };
    const port = await fakeGateway(seen);
    fwd = await client(port).proxy.startForwarder({ apiKey: API_KEY, flags: "class-dc-allowhttp-1" });
    const u = new URL(fwd.server);
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: u.hostname, port: u.port, path: "http://example.com/p", headers: { "Proxy-Authorization": basic(fwd!.username!) } }, (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve(b));
      }).on("error", reject);
    });
    expect(body).toBe("plain-ok");
    expect(seen.line).toBe("http://example.com/p");
    expect(Buffer.from(seen.auth.slice(6), "base64").toString()).toBe(`class-dc-allowhttp-1:${API_KEY}`);
  });

  it("allows tokenless use only with the explicit opt-in", async () => {
    const seen = { auth: "", line: "", tlsVersion: "" };
    const port = await fakeGateway(seen);
    fwd = await client(port).proxy.startForwarder({ apiKey: API_KEY, allowTokenless: true });
    expect(fwd.username).toBeNull();
    const out = await rawConnect(fwd, null, "hi", /echo:hi/);
    expect(out).toContain("echo:hi");
    expect(Buffer.from(seen.auth.slice(6), "base64").toString()).toBe(`relay:${API_KEY}`);
  });

  it("scrubs errors and maps a gateway 407 to 502", async () => {
    const seen = { auth: "", line: "", tlsVersion: "" };
    const port = await fakeGateway(seen, 407);
    fwd = await client(port).proxy.startForwarder({ apiKey: API_KEY });
    const out = await rawConnect(fwd, basic(fwd.username!));
    expect(out).toMatch(/^HTTP\/1\.1 502/);
    expect(out).not.toContain(API_KEY);
    await fwd.close();
    // Gateway unreachable: the TLS error text must not carry the key.
    const dead = await new Promise<number>((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
    fwd = await client(dead).proxy.startForwarder({ apiKey: API_KEY });
    const out2 = await rawConnect(fwd, basic(fwd.username!));
    expect(out2).toMatch(/^HTTP\/1\.1 502/);
    expect(out2).toContain("forwarder: gateway error");
    expect(out2).not.toContain(API_KEY);
    expect(out2).not.toContain("dn_live_");
  });

  it("close() stops listening and is idempotent", async () => {
    const port = await fakeGateway({ auth: "", line: "", tlsVersion: "" });
    fwd = await client(port).proxy.startForwarder({ apiKey: API_KEY });
    const u = new URL(fwd.server);
    await fwd.close();
    await fwd.close();
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => {
      const s = net.connect(Number(u.port), u.hostname);
      s.on("connect", () => { s.destroy(); r(null); });
      s.on("error", (e) => r(e));
    });
    expect(err?.code).toBe("ECONNREFUSED");
  });
});
