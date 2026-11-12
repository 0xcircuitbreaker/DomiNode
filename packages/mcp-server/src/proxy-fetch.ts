import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { USER_AGENT } from "./version.js";
import * as tls from "node:tls";
import * as dns from "node:dns";
import type { McpConfig } from "./config.js";

/**
 * TLS to the gateway's HTTPS proxy port: TLS 1.3 with the hybrid
 * X25519MLKEM768 group first (mirrors @dominusnode/shared tls-pq.ts, which this
 * published package cannot depend on). Falls back to X25519 on OpenSSL < 3.5.
 */
let gatewayCurve: string | null = null;
export function gatewayEcdhCurve(): string {
  if (gatewayCurve !== null) return gatewayCurve;
  try {
    tls.createSecureContext({ ecdhCurve: "X25519MLKEM768:X25519" });
    gatewayCurve = "X25519MLKEM768:X25519";
  } catch {
    gatewayCurve = "X25519";
  }
  return gatewayCurve;
}

export interface ProxyFetchOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** ISO 3166-1 alpha-2 exit country (username flag country-XX). */
  country?: string;
  /** Exit IP class (username flag class-residential|dc|mobile|masked). */
  ipClass?: "residential" | "dc" | "mobile" | "masked";
  /** Sticky session id (username flag session-<id>, alphanumeric). */
  sessionId?: string;
  /** Opt in to exit-visible plaintext http:// (username flag allowhttp-1). */
  allowHttp?: boolean;
  timeoutMs?: number;
}

export type LookupAll = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupAll = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

export interface ProxyFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyTruncated: boolean;
  byteCount: number;
  /** Caller-supplied headers that were not sent (see BLOCKED_REQUEST_HEADERS). */
  droppedHeaders?: string[];
}

/**
 * Request headers a caller may not set: hop-by-hop/framing headers (request smuggling),
 * credentials (Authorization, Proxy-Authorization: the exit node could read them on
 * plaintext and they must never carry the dn_live_ key), and User-Agent (fixed to this
 * package's version).
 */
export const BLOCKED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "host", "connection", "content-length", "transfer-encoding", "proxy-authorization",
  "authorization", "user-agent", "proxy-connection", "upgrade", "te", "trailer", "keep-alive",
]);

/** Split caller headers into allowed and dropped (case-insensitive). */
export function filterRequestHeaders(headers: Record<string, string> | undefined): { allowed: Record<string, string>; dropped: string[] } {
  const allowed: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) dropped.push(key);
    else allowed[key] = value;
  }
  return { allowed, dropped };
}

const CRLF_PATTERN = /[\r\n]/;

function validateHeaders(headers: Record<string, string>): void {
  for (const [key, value] of Object.entries(headers)) {
    if (CRLF_PATTERN.test(key) || CRLF_PATTERN.test(value)) {
      throw new Error(`Header "${key}" contains invalid characters (CR/LF injection attempt)`);
    }
    // Block null bytes
    if (key.includes("\0") || value.includes("\0")) {
      throw new Error(`Header "${key}" contains null bytes`);
    }
  }
}

const BINARY_CONTENT_TYPES = [
  "image/", "audio/", "video/", "application/octet-stream",
  "application/zip", "application/gzip", "application/pdf",
  "application/x-tar", "application/x-rar",
];

function isBinaryContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return BINARY_CONTENT_TYPES.some((t) => lower.includes(t));
}

/**
 * Build the gateway username from relay routing flags (proxy-gateway
 * parseProxyOptions): country-XX, class-<c>, session-<id>, allowhttp-1.
 * Flags are hyphen-joined; with none set the neutral token "relay" is sent.
 */
export function buildProxyUsername(opts: Pick<ProxyFetchOptions, "country" | "ipClass" | "sessionId" | "allowHttp">): string {
  const parts: string[] = [];
  if (opts.country) {
    if (!/^[A-Za-z]{2}$/.test(opts.country)) throw new Error("country must be a 2-letter ISO code");
    parts.push(`country-${opts.country.toUpperCase()}`);
  }
  if (opts.ipClass) {
    if (!["residential", "dc", "mobile", "masked"].includes(opts.ipClass)) throw new Error("ip_class must be residential, dc, mobile or masked");
    parts.push(`class-${opts.ipClass}`);
  }
  if (opts.sessionId) {
    if (!/^[A-Za-z0-9]{1,64}$/.test(opts.sessionId)) throw new Error("session_id must be 1-64 alphanumeric characters");
    parts.push(`session-${opts.sessionId}`);
  }
  if (opts.allowHttp) parts.push("allowhttp-1");
  return parts.length > 0 ? parts.join("-") : "relay";
}

function buildProxyAuth(apiKey: string, opts: ProxyFetchOptions): string {
  const username = buildProxyUsername(opts);
  return "Basic " + Buffer.from(`${username}:${apiKey}`).toString("base64");
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "[::1]",
  "[::ffff:127.0.0.1]",
  "0.0.0.0",
  "[::]",
]);

// Normalize non-standard IP representations (octal, hex, decimal)
// to standard dotted-decimal to prevent SSRF bypasses like 0x7f000001, 2130706433, 0177.0.0.1
function normalizeIpv4(hostname: string): string | null {
  // Single decimal integer (e.g., 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(hostname)) {
    const n = parseInt(hostname, 10);
    if (n >= 0 && n <= 0xffffffff) {
      return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
    }
  }
  // Hex notation (e.g., 0x7f000001)
  if (/^0x[0-9a-fA-F]+$/i.test(hostname)) {
    const n = parseInt(hostname, 16);
    if (n >= 0 && n <= 0xffffffff) {
      return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
    }
  }
  // Octal or mixed-radix octets (e.g., 0177.0.0.1, 0x7f.0.0.1)
  const parts = hostname.split(".");
  if (parts.length === 4) {
    const octets: number[] = [];
    for (const part of parts) {
      let val: number;
      if (/^0x[0-9a-fA-F]+$/i.test(part)) {
        val = parseInt(part, 16);
      } else if (/^0\d+$/.test(part)) {
        val = parseInt(part, 8);
      } else if (/^\d+$/.test(part)) {
        val = parseInt(part, 10);
      } else {
        return null; // Not an IP
      }
      if (isNaN(val) || val < 0 || val > 255) return null;
      octets.push(val);
    }
    return octets.join(".");
  }
  return null;
}

/** Non-public IPv4 ranges (CIDR-matched with node:net BlockList). */
const BLOCKED_V4 = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],        // "this" network
  ["10.0.0.0", 8],       // private
  ["100.64.0.0", 10],    // CGNAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local
  ["172.16.0.0", 12],    // private
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // TEST-NET-1
  ["192.88.99.0", 24],   // 6to4 relay anycast
  ["192.168.0.0", 16],   // private
  ["198.18.0.0", 15],    // benchmarking
  ["198.51.100.0", 24],  // TEST-NET-2
  ["203.0.113.0", 24],   // TEST-NET-3
  ["224.0.0.0", 3],      // multicast + reserved + broadcast
] as const) BLOCKED_V4.addSubnet(addr, prefix, "ipv4");

/** Non-public IPv6 ranges. Ranges that embed IPv4 are decoded separately (see isPrivateIp). */
const BLOCKED_V6 = new net.BlockList();
for (const [addr, prefix] of [
  ["::", 128],           // unspecified
  ["::1", 128],          // loopback
  ["100::", 64],         // discard-only
  ["64:ff9b:1::", 48],   // local-use NAT64
  ["2001::", 32],        // Teredo (embeds an obfuscated IPv4): block outright
  ["2001:db8::", 32],    // documentation
  ["2002::", 16],        // 6to4 (embeds IPv4): block outright
  ["fc00::", 7],         // unique local
  ["fe80::", 10],        // link-local
  ["fec0::", 10],        // site-local (deprecated)
  ["ff00::", 8],         // multicast
] as const) BLOCKED_V6.addSubnet(addr, prefix, "ipv6");

/** Expand an IPv6 literal to 8 16-bit groups (handles "::" and a dotted IPv4 tail). */
function ipv6Groups(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  let s = ip.toLowerCase();
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const o = tail.split(".").map(Number);
    s = `${s.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, rest] = s.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const r = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const fill = rest !== undefined ? 8 - h.length - r.length : 0;
  const groups = [...h, ...Array(fill).fill("0"), ...r].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

export function isPrivateIp(hostname: string): boolean {
  // Strip brackets from IPv6
  let ip = hostname.replace(/^\[|\]$/g, "");

  // Strip IPv6 zone ID (e.g., %25eth0, %eth0) before any analysis
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) {
    ip = ip.substring(0, zoneIdx);
  }

  // Normalize non-standard IPv4 forms (decimal, hex, octal) before checking
  const v4 = normalizeIpv4(ip) ?? ip;
  if (net.isIPv4(v4)) return BLOCKED_V4.check(v4, "ipv4");

  const g = ipv6Groups(ip);
  if (!g) return false; // not an IP literal (hostnames are checked after DNS resolution)

  const zero = (n: number) => g.slice(0, n).every((x) => x === 0);
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96): check the embedded IPv4
  if (zero(5) && g[5] === 0xffff) return isPrivateIp(v4FromGroups(g[6], g[7]));
  if (zero(6) && !(g[6] === 0 && g[7] <= 1)) return isPrivateIp(v4FromGroups(g[6], g[7]));
  // NAT64 well-known prefix (64:ff9b::/96): check the embedded IPv4
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isPrivateIp(v4FromGroups(g[6], g[7]));
  }
  return BLOCKED_V6.check(ip, "ipv6");
}

export function validateUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http: and https: protocols are supported, got ${parsed.protocol}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  // Relay nodes only dial ports 80/443 (node floor); fail fast client-side.
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    throw new Error("Only ports 80 and 443 are reachable through the relay network");
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known local hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error("Requests to localhost/loopback addresses are blocked");
  }

  // Block private/reserved IP addresses
  if (isPrivateIp(hostname)) {
    throw new Error("Requests to private/internal IP addresses are blocked");
  }

  // Block .localhost TLD (RFC 6761) — "foo.localhost" resolves to loopback
  if (hostname.endsWith(".localhost")) {
    throw new Error("Requests to localhost/loopback addresses are blocked");
  }

  // Block hostnames ending in .local, .internal, .arpa
  if (hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".arpa")) {
    throw new Error("Requests to internal network hostnames are blocked");
  }

  return parsed;
}

/**
 * DNS rebinding protection: resolve the hostname and reject if ANY resolved
 * address is private/reserved. The gateway and node floor re-check after
 * their own resolution; this is the client-side layer.
 */
export async function assertPublicResolution(hostname: string, lookup: LookupAll = defaultLookup): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Requests to private/internal IP addresses are blocked");
    return;
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(host);
  } catch {
    throw new Error(`DNS resolution failed for ${host}`);
  }
  if (!addrs.length) throw new Error(`DNS resolution returned no addresses for ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error("Hostname resolves to a private/internal IP address (blocked)");
    }
  }
}

export async function proxyFetch(
  config: McpConfig,
  opts: ProxyFetchOptions,
  lookup: LookupAll = defaultLookup,
): Promise<ProxyFetchResult> {
  if (!config.apiKey) {
    throw new Error("Proxy fetch requires an API key. Use dominusnode_wallet_setup to get one first.");
  }
  const apiKey = config.apiKey;

  const parsed = validateUrl(opts.url);
  const timeoutMs = Math.min(opts.timeoutMs ?? config.fetchTimeoutMs, 120_000);
  const maxBytes = Math.min(config.fetchMaxResponseBytes, 10 * 1024 * 1024);
  const method = (opts.method ?? "GET").toUpperCase();

  // Enforce read-only methods at function level (defense-in-depth)
  const ALLOWED_PROXY_METHODS = new Set(["GET", "HEAD"]);
  if (!ALLOWED_PROXY_METHODS.has(method)) {
    throw new Error(`Only GET and HEAD methods are allowed for proxy fetch, got ${method}`);
  }

  // Drop body on GET/HEAD — these methods should never carry a request body
  if (method === "GET" || method === "HEAD") {
    opts.body = undefined;
  }

  // Validate user-supplied headers to prevent CRLF injection
  if (opts.headers) {
    validateHeaders(opts.headers);
  }

  // Plaintext is exit-visible: require explicit opt-in (allowhttp-1).
  if (parsed.protocol === "http:" && !opts.allowHttp) {
    throw new Error(
      "Plaintext http:// requires allow_http=true (allowhttp-1). The exit node can read and modify plaintext traffic; prefer https://.",
    );
  }
  // Validate routing flags before any network activity.
  buildProxyUsername(opts);

  await assertPublicResolution(parsed.hostname, lookup);

  const { dropped } = filterRequestHeaders(opts.headers);
  const result = parsed.protocol === "https:"
    ? await httpsProxyFetch(apiKey, config, opts, parsed, method, timeoutMs, maxBytes)
    : await httpProxyFetch(apiKey, config, opts, parsed, method, timeoutMs, maxBytes);
  return dropped.length > 0 ? { ...result, droppedHeaders: dropped } : result;
}

/**
 * Open a request to the gateway. With config.proxyTls the channel to the gateway is
 * TLS (certificate verified), so Proxy-Authorization is never sent in clear.
 */
function gatewayRequest(
  config: McpConfig,
  opts: http.RequestOptions,
  cb?: (res: http.IncomingMessage) => void,
): http.ClientRequest {
  if (!config.proxyTls) return http.request({ ...opts, port: config.httpProxyPort }, cb);
  return https.request({
    ...opts,
    port: config.proxyTls.port,
    ca: config.proxyTls.ca,
    servername: net.isIP(config.proxyHost) ? undefined : config.proxyHost,
    minVersion: "TLSv1.3",
    ecdhCurve: gatewayEcdhCurve(),
    rejectUnauthorized: true,
  }, cb);
}

/** Where proxy fetches go, for tool descriptions. */
export function gatewayDescription(config: McpConfig): string {
  return config.proxyTls
    ? `https://${config.proxyHost}:${config.proxyTls.port} (TLS)`
    : `http://${config.proxyHost}:${config.httpProxyPort}`;
}

function httpProxyFetch(
  apiKey: string,
  config: McpConfig,
  opts: ProxyFetchOptions,
  parsed: URL,
  method: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<ProxyFetchResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Proxy request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const safeHttpHeaders = filterRequestHeaders(opts.headers).allowed;

    const req = gatewayRequest(
      config,
      {
        hostname: config.proxyHost,
        method,
        path: opts.url,
        headers: {
          ...safeHttpHeaders,
          "User-Agent": USER_AGENT,
          "Proxy-Authorization": buildProxyAuth(apiKey, opts),
          Host: parsed.host,
        },
      },
      (res) => {
        collectResponse(res, maxBytes, timer).then(
          ({ body, truncated, byteCount }) => {
            const contentType = res.headers["content-type"] ?? "";
            // Redact security-sensitive response headers
            const REDACTED_RESP = new Set([
              "set-cookie", "www-authenticate", "proxy-authenticate",
              "authorization", "proxy-authorization",
            ]);
            const responseHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              if (value && !REDACTED_RESP.has(key)) responseHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
            }

            let responseBody: string;
            if (isBinaryContentType(contentType)) {
              responseBody = `[Binary content: ${contentType}, ${byteCount} bytes]`;
            } else {
              responseBody = body;
            }

            resolve({
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
              headers: responseHeaders,
              body: responseBody,
              bodyTruncated: truncated,
              byteCount,
            });
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      },
    );

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Proxy connection error: ${err.message}`));
    });

    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

function httpsProxyFetch(
  apiKey: string,
  config: McpConfig,
  opts: ProxyFetchOptions,
  parsed: URL,
  method: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<ProxyFetchResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket?.destroy();
      reject(new Error(`Proxy request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let socket: net.Socket | undefined;

    // Step 1: CONNECT tunnel
    const connectHost = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
    const connectReq = gatewayRequest(config, {
      hostname: config.proxyHost,
      method: "CONNECT",
      path: `${connectHost}:${parsed.port || 443}`,
      headers: {
        "Proxy-Authorization": buildProxyAuth(apiKey, opts),
        Host: `${connectHost}:${parsed.port || 443}`,
      },
    });

    connectReq.on("connect", (_res, tunnelSocket) => {
      if (_res.statusCode !== 200) {
        clearTimeout(timer);
        tunnelSocket.destroy();
        reject(new Error(`CONNECT tunnel failed with status ${_res.statusCode}`));
        return;
      }

      socket = tunnelSocket;

      // Step 2: TLS upgrade
      const tlsSocket = tls.connect(
        {
          host: parsed.hostname,
          port: parseInt(parsed.port || "443", 10),
          socket: tunnelSocket,
          servername: parsed.hostname,
          minVersion: "TLSv1.2",
        },
        () => {
          // Step 3: Send HTTP request through TLS tunnel
          const requestPath = parsed.pathname + parsed.search;
          // Validate request path for CRLF injection before writing raw HTTP request line
          if (/[\r\n]/.test(requestPath)) {
            clearTimeout(timer);
            tlsSocket.destroy();
            reject(new Error("Request path contains invalid characters"));
            return;
          }
          // Set base headers first, then user headers, but block security-sensitive overrides
          const safeUserHeaders = filterRequestHeaders(opts.headers).allowed;
          // Merge user headers WITHOUT allowing override of security-critical base headers
          const PROTECTED_HEADERS = new Set(["host", "user-agent", "connection", "content-length"]);
          const reqHeaders: Record<string, string> = {
            Host: parsed.host,
            "User-Agent": USER_AGENT,
            Accept: "*/*",
            Connection: "close",
          };
          for (const [key, value] of Object.entries(safeUserHeaders)) {
            if (!PROTECTED_HEADERS.has(key.toLowerCase())) {
              reqHeaders[key] = value;
            }
          }

          let reqLine = `${method} ${requestPath} HTTP/1.1\r\n`;
          for (const [key, value] of Object.entries(reqHeaders)) {
            reqLine += `${key}: ${value}\r\n`;
          }
          if (opts.body) {
            reqLine += `Content-Length: ${Buffer.byteLength(opts.body)}\r\n`;
          }
          reqLine += "\r\n";

          tlsSocket.write(reqLine);
          if (opts.body) {
            tlsSocket.write(opts.body);
          }

          // Step 4: Parse HTTP response
          parseHttpResponse(tlsSocket, maxBytes, timer).then(resolve, (err) => {
            clearTimeout(timer);
            reject(err);
          });
        },
      );

      tlsSocket.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`TLS error: ${err.message}`));
      });
    });

    connectReq.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`CONNECT request error: ${err.message}`));
    });

    connectReq.end();
  });
}

function collectResponse(
  res: http.IncomingMessage,
  maxBytes: number,
  timer: ReturnType<typeof setTimeout>,
): Promise<{ body: string; truncated: boolean; byteCount: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let truncated = false;

    res.on("data", (chunk: Buffer) => {
      byteCount += chunk.length;
      if (!truncated) {
        if (byteCount <= maxBytes) {
          chunks.push(chunk);
        } else {
          const excess = byteCount - maxBytes;
          chunks.push(chunk.subarray(0, chunk.length - excess));
          truncated = true;
          res.destroy(); // Stop data flow to save bandwidth
        }
      }
    });

    let resolved = false;
    function finalize(): void {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        body: Buffer.concat(chunks).toString("utf-8"),
        truncated,
        byteCount,
      });
    }

    res.on("end", finalize);
    res.on("close", finalize);

    res.on("error", (err) => {
      if (resolved) return; // Destroyed by us for truncation
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseHttpResponse(
  socket: tls.TLSSocket,
  maxBytes: number,
  timer: ReturnType<typeof setTimeout>,
): Promise<ProxyFetchResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;

    // Hard cap: headers buffer (16KB) + body maxBytes. Destroy socket on overflow to stop bandwidth burn.
    const hardCap = maxBytes + 16384;
    let truncated = false;

    socket.on("data", (chunk: Buffer) => {
      byteCount += chunk.length;
      if (byteCount <= hardCap) {
        chunks.push(chunk);
      } else if (!truncated) {
        // Keep what we have, destroy socket to stop data flow
        const excess = byteCount - hardCap;
        if (chunk.length > excess) {
          chunks.push(chunk.subarray(0, chunk.length - excess));
        }
        truncated = true;
        socket.destroy();
      }
    });

    let resolved = false;
    function finalize(): void {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const headerEnd = raw.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          reject(new Error("Malformed HTTP response — no header terminator"));
          return;
        }

        const headerSection = raw.substring(0, headerEnd);
        const bodySection = raw.substring(headerEnd + 4);

        const statusLine = headerSection.split("\r\n")[0];
        const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)\s*(.*)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
        const statusText = statusMatch?.[2] ?? "";

        // Redact security-sensitive response headers before returning to MCP client
        const REDACTED_RESPONSE_HEADERS = new Set([
          "set-cookie", "www-authenticate", "proxy-authenticate",
          "authorization", "proxy-authorization",
        ]);
        const headers: Record<string, string> = {};
        const headerLines = headerSection.split("\r\n").slice(1);
        for (const line of headerLines) {
          const colonIdx = line.indexOf(":");
          if (colonIdx > 0) {
            const key = line.substring(0, colonIdx).trim().toLowerCase();
            if (REDACTED_RESPONSE_HEADERS.has(key)) continue;
            headers[key] = line.substring(colonIdx + 1).trim();
          }
        }

        const contentType = headers["content-type"] ?? "";
        const bodyBytes = Buffer.byteLength(bodySection, "utf-8");
        const wasBodyTruncated = truncated || bodyBytes > maxBytes;
        let body: string;

        if (isBinaryContentType(contentType)) {
          body = `[Binary content: ${contentType}, ${byteCount} bytes]`;
        } else if (wasBodyTruncated) {
          body = bodySection.substring(0, maxBytes);
        } else {
          body = bodySection;
        }

        resolve({
          status,
          statusText,
          headers,
          body,
          bodyTruncated: wasBodyTruncated,
          byteCount: bodyBytes,
        });
      } catch (err) {
        reject(new Error(`Failed to parse response: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    socket.on("end", finalize);
    socket.on("close", finalize);

    socket.on("error", (err) => {
      if (resolved) return; // Socket was destroyed by us for truncation
      clearTimeout(timer);
      reject(new Error(`Socket error: ${err.message}`));
    });
  });
}
