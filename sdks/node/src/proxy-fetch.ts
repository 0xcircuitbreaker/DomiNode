import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { ProxyError, invalidArg, scrubCredentials } from "./errors.js";
import { MAX_RESPONSE_BYTES } from "./constants.js";
import { validateTargetUrl, assertPublicResolution, type LookupAll } from "./ssrf.js";

/** `masked` = anonymizer (VPN/WARP/Tor) exits: cheapest, opt-in; never chosen unless requested. */
export type IpClass = "residential" | "dc" | "mobile" | "masked";
export const IP_CLASSES: readonly IpClass[] = ["residential", "dc", "mobile", "masked"];

/** Gateway routing flags, encoded into the proxy USERNAME (hyphen-joined; proxy-gateway parseProxyOptions). */
export interface ProxyRoutingOptions {
  /** ISO 3166-1 alpha-2 exit country -> `country-XX`. */
  country?: string;
  /** Exit IP class -> `class-residential|dc|mobile|masked`. */
  ipClass?: IpClass;
  /** Sticky session id (1-64 alphanumeric) -> `session-<id>`. */
  sessionId?: string;
  /** Opt in to plaintext http:// (exit-visible) -> `allowhttp-1`. */
  allowHttp?: boolean;
  /** Spend from an agentic wallet (UUID) -> `wallet-<uuid>`. */
  agenticWalletId?: string;
}

const OFAC_BLOCKED = new Set(["CU", "IR", "KP", "RU", "SY"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Build the gateway username. No flags -> the neutral token "relay". */
export function buildProxyUsername(opts: ProxyRoutingOptions = {}): string {
  const parts: string[] = [];
  if (opts.country !== undefined) {
    if (typeof opts.country !== "string" || !/^[A-Za-z]{2}$/.test(opts.country)) throw invalidArg("country must be a 2-letter ISO code");
    const c = opts.country.toUpperCase();
    if (OFAC_BLOCKED.has(c)) throw invalidArg(`country ${c} is sanctioned (OFAC) and cannot be targeted`);
    parts.push(`country-${c}`);
  }
  if (opts.ipClass !== undefined) {
    if (!(IP_CLASSES as readonly string[]).includes(opts.ipClass)) throw invalidArg("ipClass must be residential, dc, mobile or masked");
    parts.push(`class-${opts.ipClass}`);
  }
  if (opts.sessionId !== undefined) {
    if (typeof opts.sessionId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(opts.sessionId)) throw invalidArg("sessionId must be 1-64 alphanumeric characters");
    parts.push(`session-${opts.sessionId}`);
  }
  if (opts.agenticWalletId !== undefined) {
    if (typeof opts.agenticWalletId !== "string" || !UUID_RE.test(opts.agenticWalletId)) throw invalidArg("agenticWalletId must be a UUID");
    parts.push(`wallet-${opts.agenticWalletId.toLowerCase()}`);
  }
  if (opts.allowHttp === true) parts.push("allowhttp-1");
  return parts.length > 0 ? parts.join("-") : "relay";
}

export interface ProxyFetchOptions extends ProxyRoutingOptions {
  /** GET (default) or HEAD. Anything else is refused. */
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  /** Default 30s, max 120s. */
  timeoutMs?: number;
  /** Body cap in bytes; default and maximum 10 MB. Larger bodies are truncated (truncated=true). */
  maxBytes?: number;
}

export interface ProxyFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Raw body bytes (at most maxBytes). */
  body: Buffer;
  /** True when the body was cut at maxBytes. */
  truncated: boolean;
  /** Body decoded as UTF-8. */
  text(): string;
}

export interface ProxyEndpoint {
  host: string;
  port: number;
  /** DNS resolver used by the rebinding check (injectable for tests). */
  lookup?: LookupAll;
  /**
   * TLS to the gateway itself ("https proxy"): Proxy-Authorization is sent inside
   * TLS, then CONNECT runs inside that channel. The gateway certificate is always
   * verified (system roots, or `ca` when given).
   */
  tls?: { ca?: string | Buffer | Array<string | Buffer>; servername?: string };
}

/** Open a request to the gateway: plain TCP, or TLS when the endpoint has `tls`. */
function gatewayRequest(ep: ProxyEndpoint, opts: http.RequestOptions, cb?: (res: http.IncomingMessage) => void): http.ClientRequest {
  if (!ep.tls) return http.request(opts, cb);
  return https.request({
    ...opts, ca: ep.tls.ca, servername: ep.tls.servername ?? (net.isIP(ep.host) ? undefined : ep.host),
    minVersion: "TLSv1.2", rejectUnauthorized: true,
  }, cb);
}

const FORBIDDEN_HEADERS = new Set([
  "host", "connection", "content-length", "transfer-encoding", "proxy-authorization",
  "proxy-connection", "authorization", "upgrade", "te", "trailer", "keep-alive",
]);

function cleanHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const [k, v] of Object.entries(h)) {
    if (typeof k !== "string" || typeof v !== "string" || /[\r\n\0]/.test(k) || /[\r\n\0]/.test(v) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) {
      throw invalidArg(`header "${String(k).slice(0, 40)}" contains invalid characters`);
    }
    if (!FORBIDDEN_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function flatten(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

/**
 * Fetch a URL through the relay gateway. https:// goes through a CONNECT tunnel
 * (end-to-end TLS, the exit node sees only host:port); http:// is sent as an
 * absolute-URI request and needs allowHttp. Redirects are never followed:
 * a 3xx is returned as-is.
 */
export async function proxyFetch(endpoint: ProxyEndpoint, apiKey: string, url: string, opts: ProxyFetchOptions = {}): Promise<ProxyFetchResponse> {
  const method = (opts.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") throw invalidArg("proxy.fetch only allows GET and HEAD");
  const target = validateTargetUrl(url);
  if (target.protocol === "http:" && opts.allowHttp !== true) {
    throw invalidArg("plaintext http:// requires allowHttp: true (the exit node can read and modify it); prefer https://");
  }
  const username = buildProxyUsername(opts);
  const headers = cleanHeaders(opts.headers);
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 30_000, 1), 120_000);
  const maxBytes = Math.min(Math.max(opts.maxBytes ?? MAX_RESPONSE_BYTES, 1), MAX_RESPONSE_BYTES);
  await assertPublicResolution(target.hostname, endpoint.lookup);

  const proxyAuth = "Basic " + Buffer.from(`${username}:${apiKey}`).toString("base64");
  const deadline = AbortSignal.timeout(timeoutMs);
  const run = target.protocol === "https:"
    ? viaConnect(endpoint, proxyAuth, target, method, headers, maxBytes, deadline)
    : viaAbsoluteUri(endpoint, proxyAuth, target, method, headers, maxBytes, deadline);
  try {
    return await run;
  } catch (err) {
    if (err instanceof ProxyError) throw err;
    if (deadline.aborted) throw new ProxyError(`Proxy request timed out after ${timeoutMs}ms`);
    throw new ProxyError(scrubCredentials(`Proxy request failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

function collect(res: http.IncomingMessage, maxBytes: number, method: string): Promise<ProxyFetchResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const body = Buffer.concat(chunks);
      resolve({
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? "",
        headers: flatten(res.headers),
        body,
        truncated,
        text: () => body.toString("utf8"),
      });
    };
    if (method === "HEAD") { res.resume(); res.on("end", finish); res.on("close", finish); return; }
    res.on("data", (c: Buffer) => {
      if (truncated) return;
      if (size + c.length > maxBytes) {
        chunks.push(c.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        res.destroy(); // stop the transfer
        finish();
        return;
      }
      chunks.push(c);
      size += c.length;
    });
    res.on("end", finish);
    res.on("close", finish);
    res.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

function viaAbsoluteUri(ep: ProxyEndpoint, proxyAuth: string, target: URL, method: string, headers: Record<string, string>,
  maxBytes: number, signal: AbortSignal): Promise<ProxyFetchResponse> {
  return new Promise((resolve, reject) => {
    const req = gatewayRequest(ep, {
      host: ep.host, port: ep.port, method, path: target.href, signal, agent: false,
      headers: { ...headers, Host: target.host, "Proxy-Authorization": proxyAuth, Connection: "close" },
    }, (res) => collect(res, maxBytes, method).then(resolve, reject));
    req.on("error", reject);
    req.end();
  });
}

/** X-DominusNode-Error / Retry-After from a refused CONNECT head (SDK_SURFACE §3.15 step 7). */
export function relayErrorHead(h: Record<string, string | string[] | undefined>): { code?: string; retryAfter?: number } {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const raw = one(h["x-dominusnode-error"])?.trim();
  const code = raw && /^[A-Z0-9_]{1,64}$/.test(raw) ? raw : undefined;
  const ra = one(h["retry-after"])?.trim();
  const retryAfter = ra !== undefined && /^\d{1,6}$/.test(ra) ? Number(ra) : undefined;
  return { code, retryAfter };
}

function viaConnect(ep: ProxyEndpoint, proxyAuth: string, target: URL, method: string, headers: Record<string, string>,
  maxBytes: number, signal: AbortSignal): Promise<ProxyFetchResponse> {
  const port = target.port || "443";
  const authority = `${target.hostname}:${port}`; // URL.hostname keeps IPv6 brackets
  return new Promise((resolve, reject) => {
    const connectReq = gatewayRequest(ep, {
      host: ep.host, port: ep.port, method: "CONNECT", path: authority, signal, agent: false,
      headers: { Host: authority, "Proxy-Authorization": proxyAuth },
    });
    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const { code, retryAfter } = relayErrorHead(res.headers);
        reject(new ProxyError(`Proxy refused CONNECT (HTTP ${res.statusCode ?? 0})${code ? `: ${code}` : ""}`, res.statusCode, code, retryAfter));
        return;
      }
      const servername = target.hostname.replace(/^\[|\]$/g, "");
      const req = https.request({
        // No `agent` here: with agent:false Node ignores createConnection and dials the target
        // directly, bypassing the tunnel.
        host: servername, port: Number(port), method, path: target.pathname + target.search, signal,
        servername, minVersion: "TLSv1.2", rejectUnauthorized: true,
        headers: { ...headers, Host: target.host, Connection: "close" },
        createConnection: () => tls.connect({ socket: socket as Duplex as net.Socket, servername, minVersion: "TLSv1.2", rejectUnauthorized: true }),
      }, (r) => collect(r, maxBytes, method).then(resolve, reject));
      req.on("error", reject);
      req.end();
    });
    connectReq.on("error", reject);
    connectReq.end();
  });
}
