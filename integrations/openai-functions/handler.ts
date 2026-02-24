/**
 * DomiNode OpenAI-compatible function calling handler (TypeScript).
 *
 * Provides a factory function that creates a handler for dispatching
 * OpenAI function calls to the DomiNode REST API. Works with any
 * function-calling LLM system: OpenAI GPT, Anthropic Claude tool_use,
 * Google Gemini, or custom implementations.
 *
 * @example
 * ```ts
 * import { createDominusNodeFunctionHandler } from "./handler";
 *
 * const handler = createDominusNodeFunctionHandler({
 *   apiKey: "dn_live_...",
 *   baseUrl: "https://api.dominusnode.com",
 * });
 *
 * // Dispatch a function call from an LLM response
 * const result = await handler("dominusnode_check_balance", {});
 * console.log(result); // JSON string with balance info
 * ```
 *
 * @module
 */

import dns from "dns/promises";
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";

// ---------------------------------------------------------------------------
// SSRF Prevention -- URL validation
// ---------------------------------------------------------------------------

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

/**
 * Normalize non-standard IPv4 representations (hex, octal, decimal integer)
 * to standard dotted-decimal to prevent SSRF bypasses like 0x7f000001,
 * 2130706433, or 0177.0.0.1.
 */
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
  // Octal or mixed-radix octets (e.g., 0177.0.0.1)
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
        return null;
      }
      if (isNaN(val) || val < 0 || val > 255) return null;
      octets.push(val);
    }
    return octets.join(".");
  }
  return null;
}

function isPrivateIp(hostname: string): boolean {
  let ip = hostname.replace(/^\[|\]$/g, "");

  // Strip IPv6 zone ID (%25eth0, %eth0)
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) {
    ip = ip.substring(0, zoneIdx);
  }

  const normalized = normalizeIpv4(ip);
  const checkIp = normalized ?? ip;

  // IPv4 private ranges
  const ipv4Match = checkIp.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 127) return true;                        // 127.0.0.0/8
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                         // multicast + reserved
    return false;
  }

  // IPv6 private ranges
  const ipLower = ip.toLowerCase();
  if (ipLower === "::1") return true;
  if (ipLower === "::") return true;
  if (ipLower.startsWith("fc") || ipLower.startsWith("fd")) return true;
  if (ipLower.startsWith("fe80")) return true;
  if (ipLower.startsWith("::ffff:")) {
    const embedded = ipLower.slice(7);
    if (embedded.includes(".")) return isPrivateIp(embedded);
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

  // IPv4-compatible IPv6 (::x.x.x.x) — deprecated but still parsed
  if (ipLower.startsWith("::") && !ipLower.startsWith("::ffff:")) {
    const rest = ipLower.slice(2);
    if (rest && rest.includes(".")) return isPrivateIp(rest);
    const hexParts = rest.split(":");
    if (hexParts.length === 2 && hexParts[0] && hexParts[1]) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      if (!isNaN(hi) && !isNaN(lo)) {
        const reconstructed = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateIp(reconstructed);
      }
    }
  }

  // Teredo (2001:0000::/32) — block unconditionally
  if (ipLower.startsWith("2001:0000:") || ipLower.startsWith("2001:0:")) return true;

  // 6to4 (2002::/16) — block unconditionally
  if (ipLower.startsWith("2002:")) return true;

  // IPv6 multicast (ff00::/8)
  if (ipLower.startsWith("ff")) return true;

  return false;
}

/**
 * Validate a URL for safety before sending through the proxy.
 * Blocks private IPs, localhost, internal hostnames, and non-HTTP(S) protocols.
 *
 * @throws {Error} If the URL is invalid or targets a private/blocked address.
 */
function validateUrl(url: string): URL {
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

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error("Requests to localhost/loopback addresses are blocked");
  }

  if (isPrivateIp(hostname)) {
    throw new Error("Requests to private/internal IP addresses are blocked");
  }

  if (hostname.endsWith(".localhost")) {
    throw new Error("Requests to localhost/loopback addresses are blocked");
  }

  if (
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".arpa")
  ) {
    throw new Error("Requests to internal network hostnames are blocked");
  }

  // Block embedded credentials in URL
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Sanctioned countries (OFAC)
// ---------------------------------------------------------------------------

const SANCTIONED_COUNTRIES = new Set(["CU", "IR", "KP", "RU", "SY"]);

// ---------------------------------------------------------------------------
// Prototype pollution prevention
// ---------------------------------------------------------------------------

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function stripDangerousKeys(obj: unknown, depth = 0): void {
  if (depth > 50 || !obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripDangerousKeys(item, depth + 1);
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (DANGEROUS_KEYS.has(key)) {
      delete record[key];
    } else if (record[key] && typeof record[key] === "object") {
      stripDangerousKeys(record[key], depth + 1);
    }
  }
}

function safeJsonParse<T>(text: string): T {
  const parsed = JSON.parse(text);
  stripDangerousKeys(parsed);
  return parsed as T;
}

// ---------------------------------------------------------------------------
// DNS rebinding protection
// ---------------------------------------------------------------------------

/**
 * Resolve a hostname and verify none of the resolved IPs are private.
 * Prevents DNS rebinding attacks where a hostname initially resolves to a
 * public IP during validation but later resolves to a private IP.
 */
async function checkDnsRebinding(hostname: string): Promise<void> {
  // Skip if hostname is already an IP literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.startsWith("[")) {
    return;
  }

  // Check IPv4 addresses
  try {
    const addresses = await dns.resolve4(hostname);
    for (const addr of addresses) {
      if (isPrivateIp(addr)) {
        throw new Error(`Hostname resolves to private IP ${addr}`);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOTFOUND") {
      throw new Error(`Could not resolve hostname: ${hostname}`);
    }
    if (err instanceof Error && err.message.includes("private IP")) throw err;
  }

  // Check IPv6 addresses
  try {
    const addresses = await dns.resolve6(hostname);
    for (const addr of addresses) {
      if (isPrivateIp(addr)) {
        throw new Error(`Hostname resolves to private IPv6 ${addr}`);
      }
    }
  } catch {
    // IPv6 resolution failure is acceptable
  }
}

// ---------------------------------------------------------------------------
// Credential sanitization
// ---------------------------------------------------------------------------

const CREDENTIAL_RE = /dn_(live|test)_[a-zA-Z0-9]+/g;

function sanitizeError(message: string): string {
  return message.replace(CREDENTIAL_RE, "***");
}

// ---------------------------------------------------------------------------
// Allowed HTTP methods for proxied fetch
// ---------------------------------------------------------------------------

const ALLOWED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getProxyHost(): string {
  return process.env.DOMINUSNODE_PROXY_HOST || "proxy.dominusnode.com";
}
function getProxyPort(): number {
  const port = parseInt(process.env.DOMINUSNODE_PROXY_PORT || "8080", 10);
  if (isNaN(port) || port < 1 || port > 65535) return 8080;
  return port;
}

export interface DominusNodeFunctionConfig {
  /** DomiNode API key (starts with dn_live_ or dn_test_). */
  apiKey: string;
  /** Base URL of the DomiNode REST API. Defaults to https://api.dominusnode.com */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

interface ApiResponse {
  status: number;
  body: string;
}

async function apiRequest(
  config: Required<Pick<DominusNodeFunctionConfig, "baseUrl" | "timeoutMs">> & { token: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${config.baseUrl}${path}`;

  const headers: Record<string, string> = {
    "User-Agent": "dominusnode-openai-functions/1.0.0",
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.token}`,
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(config.timeoutMs),
    redirect: "error",
  });

  const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("Response body too large");
  }

  const responseText = await response.text();
  if (responseText.length > MAX_RESPONSE_BYTES) {
    throw new Error("Response body exceeds size limit");
  }

  if (!response.ok) {
    let message: string;
    try {
      const parsed = JSON.parse(responseText);
      message = parsed.error ?? parsed.message ?? responseText;
    } catch {
      message = responseText;
    }
    if (message.length > 500) message = message.slice(0, 500) + "... [truncated]";
    throw new Error(`API error ${response.status}: ${sanitizeError(message)}`);
  }

  return responseText ? safeJsonParse(responseText) : {};
}

// ---------------------------------------------------------------------------
// Period to date range helper
// ---------------------------------------------------------------------------

function periodToDateRange(period: string): { since: string; until: string } {
  const now = new Date();
  const until = now.toISOString();
  let since: Date;

  switch (period) {
    case "day":
      since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case "week":
      since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "month":
    default:
      since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
  }

  return { since: since.toISOString(), until };
}

// ---------------------------------------------------------------------------
// Public API -- factory function
// ---------------------------------------------------------------------------

/**
 * Handler function type returned by createDominusNodeFunctionHandler.
 * Dispatches function calls to the DomiNode API and returns JSON string results.
 */
export type FunctionHandler = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

/**
 * Create a DomiNode function handler for OpenAI-compatible function calling.
 *
 * Authenticates using the provided API key, then returns a handler function
 * that dispatches function calls to the appropriate DomiNode REST API endpoint.
 *
 * @param config - API key and optional base URL / timeout.
 * @returns A handler function: (name, args) => Promise<string>
 *
 * @example
 * ```ts
 * import { createDominusNodeFunctionHandler } from "./handler";
 *
 * const handler = createDominusNodeFunctionHandler({
 *   apiKey: "dn_live_abc123",
 *   baseUrl: "https://api.dominusnode.com",
 * });
 *
 * // Handle a function call from an LLM
 * const result = await handler("dominusnode_check_balance", {});
 * console.log(JSON.parse(result));
 * // { balanceCents: 5000, balanceUsd: 50.00, currency: "USD", lastToppedUp: "..." }
 * ```
 */
// Test exports — used by handler.test.ts
export {
  isPrivateIp,
  validateUrl,
  normalizeIpv4,
  sanitizeError,
  stripDangerousKeys,
  safeJsonParse,
};

export function createDominusNodeFunctionHandler(
  config: DominusNodeFunctionConfig,
): FunctionHandler {
  const baseUrl = config.baseUrl ?? "https://api.dominusnode.com";
  const timeoutMs = config.timeoutMs ?? 30_000;

  if (!config.apiKey || typeof config.apiKey !== "string") {
    throw new Error("apiKey is required and must be a non-empty string");
  }

  // Authentication state -- lazily initialized on first call
  let authToken: string | null = null;
  let authPromise: Promise<void> | null = null;

  async function authenticate(): Promise<void> {
    const response = await fetch(`${baseUrl}/api/auth/verify-key`, {
      method: "POST",
      headers: {
        "User-Agent": "dominusnode-openai-functions/1.0.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apiKey: config.apiKey }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Authentication failed (${response.status}): ${text.slice(0, 500)}`);
    }

    const data = safeJsonParse<{ token: string }>(await response.text());
    if (!data.token) {
      throw new Error("Authentication response missing token");
    }
    authToken = data.token;
  }

  async function ensureAuth(): Promise<void> {
    if (authToken) return;
    if (!authPromise) {
      authPromise = authenticate().finally(() => {
        authPromise = null;
      });
    }
    await authPromise;
  }

  function api(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!authToken) throw new Error("Not authenticated");
    return apiRequest({ baseUrl, timeoutMs, token: authToken }, method, path, body);
  }

  // -----------------------------------------------------------------------
  // Function handlers
  // -----------------------------------------------------------------------

  async function handleProxiedFetch(args: Record<string, unknown>): Promise<string> {
    const url = args.url as string;
    if (!url || typeof url !== "string") {
      return JSON.stringify({ error: "url is required and must be a string" });
    }

    // SSRF validation
    let parsedUrl: URL;
    try {
      parsedUrl = validateUrl(url);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : "URL validation failed",
      });
    }

    // DNS rebinding protection
    try {
      await checkDnsRebinding(parsedUrl.hostname);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : "DNS validation failed",
      });
    }

    // Country validation
    const country = args.country as string | undefined;
    if (country) {
      const upper = country.toUpperCase();
      if (SANCTIONED_COUNTRIES.has(upper)) {
        return JSON.stringify({
          error: `Country '${upper}' is blocked (OFAC sanctioned country)`,
        });
      }
    }

    const method = ((args.method as string) ?? "GET").toUpperCase();

    // Restrict to read-only HTTP methods
    if (!ALLOWED_METHODS.has(method)) {
      return JSON.stringify({
        error: `HTTP method '${method}' is not allowed. Only GET, HEAD, OPTIONS are permitted.`,
      });
    }

    const proxyType = (args.proxy_type as string) ?? "dc";
    const headers = args.headers as Record<string, string> | undefined;

    // Build proxy username for geo-targeting
    const userParts: string[] = [proxyType];
    if (country) {
      userParts.push(`country-${country.toUpperCase()}`);
    }
    const username = userParts.join("-");

    // Use the proxy gateway for the actual request
    // The handler routes through the DomiNode proxy endpoint
    try {
      // Strip security-sensitive headers from user-provided headers
      const BLOCKED_HEADERS = new Set([
        "host", "connection", "content-length", "transfer-encoding",
        "proxy-authorization", "authorization", "user-agent",
      ]);
      const safeHeaders: Record<string, string> = {};
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          if (!BLOCKED_HEADERS.has(key.toLowerCase())) {
            // CRLF injection prevention
            if (/[\r\n\0]/.test(key) || /[\r\n\0]/.test(value)) {
              continue;
            }
            safeHeaders[key] = value;
          }
        }
      }

      // Route through proxy gateway directly
      const proxyHost = getProxyHost();
      const proxyPort = getProxyPort();
      const apiKey = config.apiKey;
      const parts: string[] = [];
      if (proxyType && proxyType !== "auto") parts.push(proxyType);
      if (country) parts.push(`country-${country.toUpperCase()}`);
      const username = parts.length > 0 ? parts.join("-") : "auto";
      const proxyAuth = "Basic " + Buffer.from(`${username}:${apiKey}`).toString("base64");

      const parsed = new URL(url);
      const MAX_BODY_BYTES = 1_048_576; // 1MB response cap

      const result = await new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Proxy request timed out after 30000ms")), 30_000);

        if (parsed.protocol === "https:") {
          // HTTPS: CONNECT tunnel + TLS
          const connectHost = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
          const connectReq = http.request({
            hostname: proxyHost,
            port: proxyPort,
            method: "CONNECT",
            path: `${connectHost}:${parsed.port || 443}`,
            headers: { "Proxy-Authorization": proxyAuth, Host: `${connectHost}:${parsed.port || 443}` },
          });
          connectReq.on("connect", (_res, tunnelSocket) => {
            if (_res.statusCode !== 200) {
              clearTimeout(timeout);
              tunnelSocket.destroy();
              reject(new Error(`CONNECT failed: ${_res.statusCode}`));
              return;
            }
            const tlsSocket = tls.connect({
              host: parsed.hostname,
              socket: tunnelSocket,
              servername: parsed.hostname,
              minVersion: "TLSv1.2",
            }, () => {
              const reqPath = parsed.pathname + parsed.search;
              let reqLine = `${method} ${reqPath} HTTP/1.1\r\nHost: ${parsed.host}\r\nUser-Agent: dominusnode-openai-functions/1.0.0\r\nAccept: */*\r\nConnection: close\r\n`;
              for (const [k, v] of Object.entries(safeHeaders)) {
                if (!["host", "user-agent", "connection"].includes(k.toLowerCase())) {
                  reqLine += `${k}: ${v}\r\n`;
                }
              }
              reqLine += "\r\n";
              tlsSocket.write(reqLine);
              const chunks: Buffer[] = [];
              let byteCount = 0;
              tlsSocket.on("data", (chunk: Buffer) => {
                byteCount += chunk.length;
                if (byteCount <= MAX_BODY_BYTES + 16384) chunks.push(chunk);
              });
              const finalize = () => {
                clearTimeout(timeout);
                const raw = Buffer.concat(chunks).toString("utf-8");
                const headerEnd = raw.indexOf("\r\n\r\n");
                if (headerEnd === -1) { reject(new Error("Malformed response")); return; }
                const headerSection = raw.substring(0, headerEnd);
                const body = raw.substring(headerEnd + 4).substring(0, MAX_BODY_BYTES);
                const statusLine = headerSection.split("\r\n")[0];
                const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
                const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
                const headers: Record<string, string> = {};
                for (const line of headerSection.split("\r\n").slice(1)) {
                  const ci = line.indexOf(":");
                  if (ci > 0) headers[line.substring(0, ci).trim().toLowerCase()] = line.substring(ci + 1).trim();
                }
                resolve({ status, headers, body });
              };
              tlsSocket.on("end", finalize);
              tlsSocket.on("close", finalize);
              tlsSocket.on("error", (err) => { clearTimeout(timeout); reject(err); });
            });
            tlsSocket.on("error", (err) => { clearTimeout(timeout); reject(err); });
          });
          connectReq.on("error", (err) => { clearTimeout(timeout); reject(err); });
          connectReq.end();
        } else {
          // HTTP: direct proxy request
          const req = http.request({
            hostname: proxyHost,
            port: proxyPort,
            method,
            path: url,
            headers: { ...safeHeaders, "Proxy-Authorization": proxyAuth, Host: parsed.host },
          }, (res) => {
            const chunks: Buffer[] = [];
            let byteCount = 0;
            res.on("data", (chunk: Buffer) => { byteCount += chunk.length; if (byteCount <= MAX_BODY_BYTES) chunks.push(chunk); });
            const finalize = () => {
              clearTimeout(timeout);
              const body = Buffer.concat(chunks).toString("utf-8").substring(0, MAX_BODY_BYTES);
              const headers: Record<string, string> = {};
              for (const [k, v] of Object.entries(res.headers)) {
                if (v) headers[k] = Array.isArray(v) ? v.join(", ") : v;
              }
              resolve({ status: res.statusCode ?? 0, headers, body });
            };
            res.on("end", finalize);
            res.on("close", finalize);
            res.on("error", (err) => { clearTimeout(timeout); reject(err); });
          });
          req.on("error", (err) => { clearTimeout(timeout); reject(err); });
          req.end();
        }
      });

      return JSON.stringify({
        status: result.status,
        headers: result.headers,
        body: result.body.substring(0, 4000), // Truncate for AI consumption
      });
    } catch (err) {
      return JSON.stringify({
        error: `Proxy fetch failed: ${sanitizeError(err instanceof Error ? err.message : String(err))}`,
        hint: "Ensure the DomiNode proxy gateway is running and accessible.",
      });
    }
  }

  async function handleCheckBalance(): Promise<string> {
    const result = await api("GET", "/api/wallet");
    return JSON.stringify(result);
  }

  async function handleCheckUsage(args: Record<string, unknown>): Promise<string> {
    const period = (args.period as string) ?? "month";
    const { since, until } = periodToDateRange(period);
    const params = new URLSearchParams({ since, until });
    const result = await api("GET", `/api/usage?${params.toString()}`);
    return JSON.stringify(result);
  }

  async function handleGetProxyConfig(): Promise<string> {
    const result = await api("GET", "/api/proxy/config");
    return JSON.stringify(result);
  }

  async function handleListSessions(): Promise<string> {
    const result = await api("GET", "/api/sessions/active");
    return JSON.stringify(result);
  }

  async function handleCreateAgenticWallet(args: Record<string, unknown>): Promise<string> {
    const label = args.label as string;
    const spendingLimitCents = args.spending_limit_cents as number;

    if (!label || typeof label !== "string") {
      return JSON.stringify({ error: "label is required and must be a string" });
    }
    if (label.length > 100) {
      return JSON.stringify({ error: "label must be 100 characters or fewer" });
    }
    if (/[\x00-\x1f\x7f]/.test(label)) {
      return JSON.stringify({ error: "label contains invalid control characters" });
    }
    if (
      !Number.isInteger(spendingLimitCents) ||
      spendingLimitCents <= 0 ||
      spendingLimitCents > 2_147_483_647
    ) {
      return JSON.stringify({
        error: "spending_limit_cents must be a positive integer <= 2,147,483,647",
      });
    }

    const result = await api("POST", "/api/agent-wallet", {
      label,
      spendingLimitCents,
    });
    return JSON.stringify(result);
  }

  async function handleFundAgenticWallet(args: Record<string, unknown>): Promise<string> {
    const walletId = args.wallet_id as string;
    const amountCents = args.amount_cents as number;

    if (!walletId || typeof walletId !== "string") {
      return JSON.stringify({ error: "wallet_id is required and must be a string" });
    }
    if (
      !Number.isInteger(amountCents) ||
      amountCents <= 0 ||
      amountCents > 2_147_483_647
    ) {
      return JSON.stringify({
        error: "amount_cents must be a positive integer <= 2,147,483,647",
      });
    }

    const result = await api(
      "POST",
      `/api/agent-wallet/${encodeURIComponent(walletId)}/fund`,
      { amountCents },
    );
    return JSON.stringify(result);
  }

  async function handleAgenticWalletBalance(args: Record<string, unknown>): Promise<string> {
    const walletId = args.wallet_id as string;

    if (!walletId || typeof walletId !== "string") {
      return JSON.stringify({ error: "wallet_id is required and must be a string" });
    }

    const result = await api(
      "GET",
      `/api/agent-wallet/${encodeURIComponent(walletId)}`,
    );
    return JSON.stringify(result);
  }

  async function handleListAgenticWallets(): Promise<string> {
    const result = await api("GET", "/api/agent-wallet");
    return JSON.stringify(result);
  }

  async function handleAgenticTransactions(args: Record<string, unknown>): Promise<string> {
    const walletId = args.wallet_id as string;
    if (!walletId || typeof walletId !== "string") {
      return JSON.stringify({ error: "wallet_id is required and must be a string" });
    }

    const limit = args.limit as number | undefined;
    const params = new URLSearchParams();
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return JSON.stringify({ error: "limit must be an integer between 1 and 100" });
      }
      params.set("limit", String(limit));
    }

    const qs = params.toString();
    const result = await api(
      "GET",
      `/api/agent-wallet/${encodeURIComponent(walletId)}/transactions${qs ? `?${qs}` : ""}`,
    );
    return JSON.stringify(result);
  }

  async function handleFreezeAgenticWallet(args: Record<string, unknown>): Promise<string> {
    const walletId = args.wallet_id as string;
    if (!walletId || typeof walletId !== "string") {
      return JSON.stringify({ error: "wallet_id is required and must be a string" });
    }

    const result = await api(
      "POST",
      `/api/agent-wallet/${encodeURIComponent(walletId)}/freeze`,
    );
    return JSON.stringify(result);
  }

  async function handleUnfreezeAgenticWallet(args: Record<string, unknown>): Promise<string> {
    const walletId = args.wallet_id as string;
    if (!walletId || typeof walletId !== "string") {
      return JSON.stringify({ error: "wallet_id is required and must be a string" });
    }

    const result = await api(
      "POST",
      `/api/agent-wallet/${encodeURIComponent(walletId)}/unfreeze`,
    );
    return JSON.stringify(result);
  }

  async function handleDeleteAgenticWallet(args: Record<string, unknown>): Promise<string> {
    const walletId = args.wallet_id as string;
    if (!walletId || typeof walletId !== "string") {
      return JSON.stringify({ error: "wallet_id is required and must be a string" });
    }

    const result = await api(
      "DELETE",
      `/api/agent-wallet/${encodeURIComponent(walletId)}`,
    );
    return JSON.stringify(result);
  }

  async function handleCreateTeam(args: Record<string, unknown>): Promise<string> {
    const name = args.name as string;
    if (!name || typeof name !== "string") {
      return JSON.stringify({ error: "name is required and must be a string" });
    }
    if (name.length > 100) {
      return JSON.stringify({ error: "name must be 100 characters or fewer" });
    }
    if (/[\x00-\x1f\x7f]/.test(name)) {
      return JSON.stringify({ error: "name contains invalid control characters" });
    }

    const body: Record<string, unknown> = { name };
    if (args.max_members !== undefined) {
      const maxMembers = Number(args.max_members);
      if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 100) {
        return JSON.stringify({ error: "max_members must be an integer between 1 and 100" });
      }
      body.maxMembers = maxMembers;
    }

    const result = await api("POST", "/api/teams", body);
    return JSON.stringify(result);
  }

  async function handleListTeams(): Promise<string> {
    const result = await api("GET", "/api/teams");
    return JSON.stringify(result);
  }

  async function handleTeamDetails(args: Record<string, unknown>): Promise<string> {
    const teamId = args.team_id as string;
    if (!teamId || typeof teamId !== "string") {
      return JSON.stringify({ error: "team_id is required and must be a string" });
    }

    const result = await api("GET", `/api/teams/${encodeURIComponent(teamId)}`);
    return JSON.stringify(result);
  }

  async function handleTeamFund(args: Record<string, unknown>): Promise<string> {
    const teamId = args.team_id as string;
    const amountCents = args.amount_cents as number;

    if (!teamId || typeof teamId !== "string") {
      return JSON.stringify({ error: "team_id is required and must be a string" });
    }
    if (
      !Number.isInteger(amountCents) ||
      amountCents < 100 ||
      amountCents > 1_000_000
    ) {
      return JSON.stringify({
        error: "amount_cents must be an integer between 100 ($1) and 1,000,000 ($10,000)",
      });
    }

    const result = await api(
      "POST",
      `/api/teams/${encodeURIComponent(teamId)}/wallet/fund`,
      { amountCents },
    );
    return JSON.stringify(result);
  }

  async function handleTeamCreateKey(args: Record<string, unknown>): Promise<string> {
    const teamId = args.team_id as string;
    const label = args.label as string;

    if (!teamId || typeof teamId !== "string") {
      return JSON.stringify({ error: "team_id is required and must be a string" });
    }
    if (!label || typeof label !== "string") {
      return JSON.stringify({ error: "label is required and must be a string" });
    }
    if (label.length > 100) {
      return JSON.stringify({ error: "label must be 100 characters or fewer" });
    }
    if (/[\x00-\x1f\x7f]/.test(label)) {
      return JSON.stringify({ error: "label contains invalid control characters" });
    }

    const result = await api(
      "POST",
      `/api/teams/${encodeURIComponent(teamId)}/keys`,
      { label },
    );
    return JSON.stringify(result);
  }

  async function handleTeamUsage(args: Record<string, unknown>): Promise<string> {
    const teamId = args.team_id as string;
    if (!teamId || typeof teamId !== "string") {
      return JSON.stringify({ error: "team_id is required and must be a string" });
    }

    const limit = args.limit as number | undefined;
    const params = new URLSearchParams();
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return JSON.stringify({ error: "limit must be an integer between 1 and 100" });
      }
      params.set("limit", String(limit));
    }

    const qs = params.toString();
    const result = await api(
      "GET",
      `/api/teams/${encodeURIComponent(teamId)}/wallet/transactions${qs ? `?${qs}` : ""}`,
    );
    return JSON.stringify(result);
  }

  async function handleUpdateTeam(args: Record<string, unknown>): Promise<string> {
    const teamId = args.team_id as string;
    if (!teamId || typeof teamId !== "string") {
      return JSON.stringify({ error: "team_id is required and must be a string" });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(teamId)) {
      return JSON.stringify({ error: "team_id must be a valid UUID" });
    }

    const body: Record<string, unknown> = {};

    if (args.name !== undefined) {
      const name = args.name as string;
      if (!name || typeof name !== "string") {
        return JSON.stringify({ error: "name must be a non-empty string" });
      }
      if (name.length > 100) {
        return JSON.stringify({ error: "name must be 100 characters or fewer" });
      }
      if (/[\x00-\x1f\x7f]/.test(name)) {
        return JSON.stringify({ error: "name contains invalid control characters" });
      }
      body.name = name;
    }

    if (args.max_members !== undefined) {
      const maxMembers = Number(args.max_members);
      if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 100) {
        return JSON.stringify({ error: "max_members must be an integer between 1 and 100" });
      }
      body.maxMembers = maxMembers;
    }

    if (Object.keys(body).length === 0) {
      return JSON.stringify({ error: "At least one of name or max_members must be provided" });
    }

    const result = await api(
      "PATCH",
      `/api/teams/${encodeURIComponent(teamId)}`,
      body,
    );
    return JSON.stringify(result);
  }

  async function handleTopupPaypal(args: Record<string, unknown>): Promise<string> {
    const amountCents = args.amount_cents as number;

    if (
      !Number.isInteger(amountCents) ||
      amountCents < 500 ||
      amountCents > 100_000
    ) {
      return JSON.stringify({
        error: "amount_cents must be an integer between 500 ($5) and 100,000 ($1,000)",
      });
    }

    const result = await api("POST", "/api/wallet/topup/paypal", { amountCents });
    return JSON.stringify(result);
  }

  async function handleUpdateTeamMemberRole(args: Record<string, unknown>): Promise<string> {
    const teamId = args.team_id as string;
    const userId = args.user_id as string;
    const role = args.role as string;

    if (!teamId || typeof teamId !== "string") {
      return JSON.stringify({ error: "team_id is required and must be a string" });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(teamId)) {
      return JSON.stringify({ error: "team_id must be a valid UUID" });
    }
    if (!userId || typeof userId !== "string") {
      return JSON.stringify({ error: "user_id is required and must be a string" });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      return JSON.stringify({ error: "user_id must be a valid UUID" });
    }
    if (!role || typeof role !== "string") {
      return JSON.stringify({ error: "role is required and must be a string" });
    }
    if (role !== "member" && role !== "admin") {
      return JSON.stringify({ error: "role must be 'member' or 'admin'" });
    }

    const result = await api(
      "PATCH",
      `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { role },
    );
    return JSON.stringify(result);
  }

  // -----------------------------------------------------------------------
  // Dispatch table
  // -----------------------------------------------------------------------

  const handlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<string>
  > = {
    dominusnode_proxied_fetch: handleProxiedFetch,
    dominusnode_check_balance: handleCheckBalance,
    dominusnode_check_usage: handleCheckUsage,
    dominusnode_get_proxy_config: handleGetProxyConfig,
    dominusnode_list_sessions: handleListSessions,
    dominusnode_create_agentic_wallet: handleCreateAgenticWallet,
    dominusnode_fund_agentic_wallet: handleFundAgenticWallet,
    dominusnode_agentic_wallet_balance: handleAgenticWalletBalance,
    dominusnode_list_agentic_wallets: handleListAgenticWallets,
    dominusnode_agentic_transactions: handleAgenticTransactions,
    dominusnode_freeze_agentic_wallet: handleFreezeAgenticWallet,
    dominusnode_unfreeze_agentic_wallet: handleUnfreezeAgenticWallet,
    dominusnode_delete_agentic_wallet: handleDeleteAgenticWallet,
    dominusnode_create_team: handleCreateTeam,
    dominusnode_list_teams: handleListTeams,
    dominusnode_team_details: handleTeamDetails,
    dominusnode_team_fund: handleTeamFund,
    dominusnode_team_create_key: handleTeamCreateKey,
    dominusnode_team_usage: handleTeamUsage,
    dominusnode_update_team: handleUpdateTeam,
    dominusnode_update_team_member_role: handleUpdateTeamMemberRole,
    dominusnode_topup_paypal: handleTopupPaypal,
  };

  // -----------------------------------------------------------------------
  // Main handler
  // -----------------------------------------------------------------------

  return async function handler(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    // Authenticate on first call
    await ensureAuth();

    const fn = handlers[name];
    if (!fn) {
      return JSON.stringify({
        error: `Unknown function: ${name}`,
        available: Object.keys(handlers),
      });
    }

    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof Error && err.message.includes("401")) {
        authToken = null;
        await ensureAuth();
        return await fn(args);
      }
      return JSON.stringify({
        error: sanitizeError(err instanceof Error ? err.message : String(err)),
      });
    }
  };
}
