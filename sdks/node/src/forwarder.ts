/**
 * Local loopback forwarder for browser agents (Playwright, Puppeteer, Chromium).
 *
 * Chromium cannot send Proxy-Authorization to an HTTPS proxy, and the production
 * gateway refuses credentials over plaintext. The forwarder bridges that gap: it
 * listens on loopback as a plain HTTP proxy (CONNECT + absolute-URI requests),
 * checks a random per-start token in the client's proxy username, then opens a
 * TLS 1.3 connection to the gateway's HTTPS proxy port and injects the API key and
 * routing flags as Proxy-Authorization. The key never leaves this process in clear
 * and is never logged; every error string handed back to a client is scrubbed.
 */
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { invalidArg, scrubCredentials } from "./errors.js";

export interface ForwarderGateway {
  host: string;
  port: number;
  /** Trust roots for the gateway certificate (undefined = system roots). */
  ca?: string | Buffer | Array<string | Buffer>;
  /** TLS server name when host is an IP literal. */
  servername?: string;
}

export interface StartForwarderOptions {
  /** Loopback address to listen on. Default 127.0.0.1. Non-loopback binds are refused. */
  host?: string;
  /** Local port. Default 0 (an ephemeral port; read it from the returned url). */
  port?: number;
  /** Gateway username flags, hyphen-joined (e.g. "country-US-class-residential"). Default "relay". */
  flags?: string;
  /**
   * Accept clients that send no token. Any local process (and any web page able to
   * reach loopback) can then spend your balance through the forwarder. Default false.
   */
  allowTokenless?: boolean;
}

export interface Forwarder {
  /** Proxy URL with the token as username, e.g. http://<token>:x@127.0.0.1:43123. */
  url: string;
  /** Proxy server without credentials, e.g. http://127.0.0.1:43123 (Playwright `server`). */
  server: string;
  /** Proxy username the client must send (the per-start token), or null when tokenless. */
  username: string | null;
  /** Proxy password: ignored by the forwarder, any value works. */
  password: string;
  close(): Promise<void>;
}

const FLAGS_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,199}$/;
const MAX_GATEWAY_HEAD = 16 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;
const HOP_HEADERS = new Set(["proxy-authorization", "proxy-connection", "connection", "keep-alive", "te", "trailer", "upgrade", "transfer-encoding"]);

/** True for 127.0.0.0/8, ::1 and "localhost". */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  return net.isIPv4(h) && h.startsWith("127.");
}

function gatewayEcdhCurve(): string {
  try {
    tls.createSecureContext({ ecdhCurve: "X25519MLKEM768:X25519" });
    return "X25519MLKEM768:X25519";
  } catch {
    return "X25519";
  }
}

/** Start a forwarder. `apiKey` must already be validated by the caller. */
export async function startForwarder(gw: ForwarderGateway, apiKey: string, opts: StartForwarderOptions = {}): Promise<Forwarder> {
  const host = opts.host ?? "127.0.0.1";
  if (typeof host !== "string" || !isLoopbackHost(host)) throw invalidArg("forwarder host must be a loopback address (127.0.0.1, ::1 or localhost)");
  const port = opts.port ?? 0;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) throw invalidArg("forwarder port must be 0-65535");
  const flags = opts.flags === undefined || opts.flags === "" ? "relay" : opts.flags;
  if (typeof flags !== "string" || !FLAGS_RE.test(flags)) throw invalidArg("forwarder flags must be hyphen-joined letters/digits (e.g. country-US-class-residential)");
  const tokenless = opts.allowTokenless === true;
  const token = tokenless ? null : randomBytes(16).toString("hex");
  const auth = "Basic " + Buffer.from(`${flags}:${apiKey}`).toString("base64");
  const curve = gatewayEcdhCurve();
  const tlsOpts = (): tls.ConnectionOptions => ({
    host: gw.host,
    port: gw.port,
    ca: gw.ca,
    servername: gw.servername ?? (net.isIP(gw.host) ? undefined : gw.host),
    minVersion: "TLSv1.3",
    ecdhCurve: curve,
    rejectUnauthorized: true,
    ALPNProtocols: ["http/1.1"],
  });
  const fail = (err: unknown): string => scrubCredentials(`forwarder: gateway error: ${err instanceof Error ? err.message : String(err)}`);

  const authorized = (req: http.IncomingMessage): boolean => {
    if (token === null) return true;
    const h = req.headers["proxy-authorization"];
    if (typeof h !== "string" || !/^basic /i.test(h)) return false;
    const decoded = Buffer.from(h.slice(6).trim(), "base64").toString("utf8");
    const user = Buffer.from(decoded.split(":")[0] ?? "");
    const want = Buffer.from(token);
    return user.length === want.length && timingSafeEqual(user, want);
  };
  const deny407 = 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="dominusnode-forwarder"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    if (!authorized(req)) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="dominusnode-forwarder"', Connection: "close" });
      res.end();
      return;
    }
    const url = req.url ?? "";
    if (!/^http:\/\//i.test(url)) {
      res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
      res.end("forwarder: send absolute http:// URLs or CONNECT\n");
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_HEADERS.has(k)) continue;
      headers[k] = v;
    }
    headers["proxy-authorization"] = auth;
    headers["connection"] = "close";
    const up = http.request({
      method: req.method,
      path: url,
      headers,
      host: gw.host,
      port: gw.port,
      createConnection: () => tls.connect(tlsOpts()),
      timeout: CONNECT_TIMEOUT_MS,
    });
    up.on("response", (r) => {
      const status = r.statusCode === 407 ? 502 : r.statusCode ?? 502;
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !HOP_HEADERS.has(k) && k !== "proxy-authenticate") out[k] = v;
      res.writeHead(status, out);
      r.pipe(res);
    });
    up.on("timeout", () => up.destroy(new Error("gateway timed out")));
    // Client gone (aborted navigation): stop the upstream request instead of finishing it.
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    up.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain", Connection: "close" });
        res.end(fail(err) + "\n");
      } else res.destroy();
    });
    req.pipe(up);
  });

  server.on("connection", (s: net.Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.on("clientError", (_err, s) => s.destroy());

  server.on("connect", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on("error", () => undefined);
    if (!authorized(req)) {
      client.end(deny407);
      return;
    }
    const target = req.url ?? "";
    if (!/^[A-Za-z0-9.-]{1,253}:\d{1,5}$|^\[[0-9A-Fa-f:.]+\]:\d{1,5}$/.test(target)) {
      client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const up = tls.connect(tlsOpts());
    sockets.add(up as unknown as net.Socket);
    up.on("close", () => sockets.delete(up as unknown as net.Socket));
    up.setTimeout(CONNECT_TIMEOUT_MS, () => up.destroy(new Error("gateway timed out")));
    let buf = Buffer.alloc(0);
    let established = false;
    const onErr = (err: unknown): void => {
      if (!established && client.writable) {
        const body = fail(err) + "\n";
        client.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      } else client.destroy();
    };
    up.on("error", onErr);
    // Client gone before the gateway answered: drop the gateway connection now, not at the timeout.
    client.on("close", () => { if (!established) up.destroy(); });
    up.on("secureConnect", () => {
      up.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    });
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > MAX_GATEWAY_HEAD) { up.destroy(); onErr(new Error("oversized gateway response")); }
        return;
      }
      up.off("data", onData);
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString("latin1"));
      const status = m ? Number(m[1]) : 502;
      if (status !== 200) {
        up.destroy();
        const code = status === 407 ? 502 : status;
        const body = scrubCredentials(`forwarder: gateway refused CONNECT (${status})`) + "\n";
        client.end(`HTTP/1.1 ${code} Gateway Refused\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        return;
      }
      established = true;
      up.setTimeout(0);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = buf.subarray(end + 4);
      if (rest.length) client.write(rest);
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
      client.on("close", () => up.destroy());
      up.on("close", () => client.destroy());
    };
    up.on("data", onData);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const addr = server.address() as net.AddressInfo;
  const hostPart = net.isIPv6(addr.address) ? `[${addr.address}]` : addr.address;
  const base = `http://${hostPart}:${addr.port}`;
  let closed: Promise<void> | null = null;
  return {
    url: token ? `http://${token}:x@${hostPart}:${addr.port}` : base,
    server: base,
    username: token,
    password: "x",
    close(): Promise<void> {
      if (!closed) {
        closed = new Promise<void>((r) => server.close(() => r()));
        for (const s of sockets) s.destroy();
        sockets.clear();
      }
      return closed;
    },
  };
}
