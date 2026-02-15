import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import type { McpConfig } from "./config.js";

export interface ProxyFetchOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  country?: string;
  state?: string;
  city?: string;
  timeoutMs?: number;
}

export interface ProxyFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyTruncated: boolean;
  byteCount: number;
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

function buildProxyUsername(apiKey: string, opts: ProxyFetchOptions): string {
  let username = encodeURIComponent(apiKey);
  if (opts.country) {
    username += `-country_${encodeURIComponent(opts.country.toUpperCase())}`;
  }
  if (opts.state) {
    username += `-state_${encodeURIComponent(opts.state)}`;
  }
  if (opts.city) {
    username += `-city_${encodeURIComponent(opts.city)}`;
  }
  return username;
}

function buildProxyAuth(apiKey: string, opts: ProxyFetchOptions): string {
  const username = buildProxyUsername(apiKey, opts);
  return "Basic " + Buffer.from(`${username}:x`).toString("base64");
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

function isPrivateIp(hostname: string): boolean {
  // Strip brackets from IPv6
  const ip = hostname.replace(/^\[|\]$/g, "");

  // IPv4 private ranges
  const ipv4Match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 0) return true;                       // 0.0.0.0/8
    if (a === 10) return true;                      // 10.0.0.0/8
    if (a === 127) return true;                     // 127.0.0.0/8
    if (a === 169 && b === 254) return true;        // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;        // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                      // multicast + reserved
    return false;
  }

  // IPv6 private ranges
  const ipLower = ip.toLowerCase();
  if (ipLower === "::1") return true;               // loopback
  if (ipLower === "::") return true;                // unspecified
  if (ipLower.startsWith("fc") || ipLower.startsWith("fd")) return true; // fc00::/7 ULA
  if (ipLower.startsWith("fe80")) return true;      // fe80::/10 link-local
  if (ipLower.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 — check the embedded IPv4
    const embedded = ipLower.slice(7);
    // May be dotted-decimal (::ffff:127.0.0.1) or hex (::ffff:7f00:1)
    if (embedded.includes(".")) {
      return isPrivateIp(embedded);
    }
    // Hex form: convert ::ffff:XXYY:ZZWW to X.Y.Z.W
    const hexParts = embedded.split(":");
    if (hexParts.length === 2) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      if (!isNaN(hi) && !isNaN(lo)) {
        const reconstructed = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateIp(reconstructed);
      }
    }
    return isPrivateIp(embedded);
  }

  return false;
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

  const hostname = parsed.hostname.toLowerCase();

  // Block known local hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error("Requests to localhost/loopback addresses are blocked");
  }

  // Block private/reserved IP addresses
  if (isPrivateIp(hostname)) {
    throw new Error("Requests to private/internal IP addresses are blocked");
  }

  // Block hostnames ending in .local, .internal, .arpa
  if (hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".arpa")) {
    throw new Error("Requests to internal network hostnames are blocked");
  }

  return parsed;
}

export async function proxyFetch(
  config: McpConfig,
  opts: ProxyFetchOptions,
): Promise<ProxyFetchResult> {
  if (!config.apiKey) {
    throw new Error("Proxy fetch requires an API key. Use dominusnode_setup to create an account first.");
  }
  const apiKey = config.apiKey;

  const parsed = validateUrl(opts.url);
  const timeoutMs = Math.min(opts.timeoutMs ?? config.fetchTimeoutMs, 120_000);
  const maxBytes = config.fetchMaxResponseBytes;
  const method = (opts.method ?? "GET").toUpperCase();

  // Validate user-supplied headers to prevent CRLF injection
  if (opts.headers) {
    validateHeaders(opts.headers);
  }

  if (parsed.protocol === "https:") {
    return httpsProxyFetch(apiKey, config, opts, parsed, method, timeoutMs, maxBytes);
  }
  return httpProxyFetch(apiKey, config, opts, parsed, method, timeoutMs, maxBytes);
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

    const req = http.request(
      {
        hostname: config.proxyHost,
        port: config.httpProxyPort,
        method,
        path: opts.url,
        headers: {
          ...opts.headers,
          "Proxy-Authorization": buildProxyAuth(apiKey, opts),
          Host: parsed.host,
        },
      },
      (res) => {
        collectResponse(res, maxBytes, timer).then(
          ({ body, truncated, byteCount }) => {
            const contentType = res.headers["content-type"] ?? "";
            const responseHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              if (value) responseHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
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
    const connectReq = http.request({
      hostname: config.proxyHost,
      port: config.httpProxyPort,
      method: "CONNECT",
      path: `${parsed.hostname}:${parsed.port || 443}`,
      headers: {
        "Proxy-Authorization": buildProxyAuth(apiKey, opts),
        Host: `${parsed.hostname}:${parsed.port || 443}`,
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
          const reqHeaders: Record<string, string> = {
            Host: parsed.host,
            "User-Agent": "dominusnode-mcp-server/1.0.0",
            Accept: "*/*",
            Connection: "close",
            ...opts.headers,
          };

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

        const headers: Record<string, string> = {};
        const headerLines = headerSection.split("\r\n").slice(1);
        for (const line of headerLines) {
          const colonIdx = line.indexOf(":");
          if (colonIdx > 0) {
            headers[line.substring(0, colonIdx).trim().toLowerCase()] = line.substring(colonIdx + 1).trim();
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
