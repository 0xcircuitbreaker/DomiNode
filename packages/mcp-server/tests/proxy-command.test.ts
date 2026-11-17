import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo, Socket } from "node:net";
import { ConfigError } from "../src/config.js";
import { runProxyCommand, parseProxyArgs, isLoopbackHost, type Forwarder } from "../src/proxy-command.js";

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const caFile = path.join(fx, "test-proxy-tls.crt");
const cert = fs.readFileSync(caFile);
const key = fs.readFileSync(path.join(fx, "test-proxy-tls.key"));
const API_KEY = "dn_live_" + "b".repeat(32);

let gateway: https.Server | undefined;
let fwd: Forwarder | null = null;
const socks: Socket[] = [];

afterEach(async () => {
  await fwd?.close();
  fwd = null;
  if (gateway) {
    for (const s of socks) s.destroy();
    socks.length = 0;
    gateway.closeAllConnections();
    await new Promise<void>((r) => gateway!.close(() => r()));
    gateway = undefined;
  }
});

async function fakeGateway(seen: { auth: string; proto: string }, status = 200): Promise<number> {
  gateway = https.createServer({ cert, key }, (req, res) => {
    seen.auth = String(req.headers["proxy-authorization"]);
    res.end("plain-ok");
  });
  gateway.on("connect", (req: http.IncomingMessage, sock: Socket) => {
    socks.push(sock);
    seen.auth = String(req.headers["proxy-authorization"]);
    seen.proto = String((sock as import("node:tls").TLSSocket).getProtocol());
    if (status !== 200) { sock.end(`HTTP/1.1 ${status} No\r\nContent-Length: 0\r\n\r\n`); return; }
    sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    sock.on("data", (d) => sock.write("echo:" + d.toString()));
  });
  await new Promise<void>((r) => gateway!.listen(0, "127.0.0.1", () => r()));
  return (gateway.address() as AddressInfo).port;
}

function env(port: number): Record<string, string> {
  return {
    DOMINUSNODE_API_KEY: API_KEY,
    DOMINUSNODE_PROXY_URL: `https://localhost:${port}`,
    DOMINUSNODE_PROXY_CA_FILE: caFile,
    DOMINUSNODE_ALLOW_LOCAL_GATEWAY: "1",
  };
}

function connect(f: Forwarder, auth: string | null, payload?: string): Promise<string> {
  const u = new URL(f.server);
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(u.port), u.hostname);
    let buf = "";
    let sent = false;
    s.on("data", (d) => {
      buf += d.toString();
      if (payload && !sent && buf.includes("200 Connection Established")) { sent = true; s.write(payload); return; }
      if (!payload || buf.includes("echo:")) { s.destroy(); resolve(buf); }
    });
    s.on("close", () => resolve(buf));
    s.on("error", reject);
    s.write(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`);
  });
}
const basic = (u: string): string => "Basic " + Buffer.from(`${u}:x`).toString("base64");

describe("dominusnode-mcp proxy", () => {
  it("parses args", () => {
    expect(parseProxyArgs(["--port", "9000", "--flags=country-US-class-residential"])).toMatchObject({ port: 9000, flags: "country-US-class-residential", allowTokenless: false });
    expect(() => parseProxyArgs(["--port", "abc"])).toThrow(ConfigError);
    expect(() => parseProxyArgs(["--api-key", API_KEY])).toThrow(/unknown option --api-key$/);
  });

  it("reads the key from DOMINUSNODE_API_KEY only", async () => {
    await expect(runProxyCommand([], {}, () => undefined)).rejects.toThrow(/DOMINUSNODE_API_KEY is required/);
  });

  it("refuses non-loopback binds", async () => {
    const port = await fakeGateway({ auth: "", proto: "" });
    await expect(runProxyCommand(["--host", "0.0.0.0"], env(port), () => undefined)).rejects.toThrow(/loopback/);
    expect(isLoopbackHost("10.66.0.1")).toBe(false);
  });

  it("requires the token, injects key+flags over TLS 1.3, never prints the key", async () => {
    const seen = { auth: "", proto: "" };
    const port = await fakeGateway(seen);
    let printed = "";
    fwd = await runProxyCommand(["--flags", "country-US-class-residential"], env(port), (s) => (printed += s));
    expect(fwd).not.toBeNull();
    expect(printed).not.toContain(API_KEY);
    expect(printed).toContain(fwd!.username!);
    expect(await connect(fwd!, null)).toMatch(/^HTTP\/1\.1 407/);
    expect(await connect(fwd!, basic("nope"))).toMatch(/^HTTP\/1\.1 407/);
    const out = await connect(fwd!, basic(fwd!.username!), "ping");
    expect(out).toContain("echo:ping");
    expect(seen.proto).toBe("TLSv1.3");
    expect(Buffer.from(seen.auth.slice(6), "base64").toString()).toBe(`country-US-class-residential:${API_KEY}`);
  });

  it("scrubs gateway errors", async () => {
    const port = await fakeGateway({ auth: "", proto: "" }, 407);
    fwd = await runProxyCommand([], env(port), () => undefined);
    const out = await connect(fwd!, basic(fwd!.username!));
    expect(out).toMatch(/^HTTP\/1\.1 502/);
    expect(out).not.toContain("dn_live_");
  });

  it("close() stops the listener", async () => {
    const port = await fakeGateway({ auth: "", proto: "" });
    fwd = await runProxyCommand([], env(port), () => undefined);
    const u = new URL(fwd!.server);
    await fwd!.close();
    const code = await new Promise<string | undefined>((r) => {
      const s = net.connect(Number(u.port), u.hostname);
      s.on("connect", () => { s.destroy(); r(undefined); });
      s.on("error", (e: NodeJS.ErrnoException) => r(e.code));
    });
    expect(code).toBe("ECONNREFUSED");
  });
  it("stays in sync with the Node SDK forwarder", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const body = (f: string, endMarker?: string): string => {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      const start = src.indexOf("const FLAGS_RE");
      const end = endMarker ? src.indexOf(endMarker) : src.length;
      return src.slice(start, end).trim();
    };
    expect(body("packages/mcp-server/src/proxy-command.ts", "const USAGE")).toBe(body("sdks/node/src/forwarder.ts"));
  });

  it("drops the gateway connection when the client leaves before CONNECT is answered", async () => {
    let gwSock: Socket | undefined;
    gateway = https.createServer({ cert, key });
    gateway.on("connect", (_req: http.IncomingMessage, sock: Socket) => { socks.push(sock); gwSock = sock; });
    await new Promise<void>((r) => gateway!.listen(0, "127.0.0.1", () => r()));
    fwd = await runProxyCommand([], env((gateway.address() as AddressInfo).port), () => undefined);
    const u = new URL(fwd!.server);
    const c = net.connect(Number(u.port), u.hostname);
    c.write(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: ${basic(fwd!.username!)}\r\n\r\n`);
    for (let i = 0; i < 100 && !gwSock; i++) await new Promise((r) => setTimeout(r, 20));
    expect(gwSock).toBeDefined();
    const closed = new Promise<void>((r) => gwSock!.on("close", () => r()));
    c.destroy();
    await closed;
  });
});
