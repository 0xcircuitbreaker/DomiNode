/**
 * DomiNode OpenClaw Plugin
 *
 * Implements 21 tools for interacting with DomiNode's rotating proxy service
 * directly from OpenClaw AI coding sessions.
 *
 * Uses native fetch (no external dependencies). Runs via jiti runtime.
 *
 * Security:
 *  - Full SSRF protection (private IP blocking, DNS rebinding, .localhost, embedded creds)
 *  - Credential scrubbing in error messages
 *  - Response truncation at 4000 chars for LLM context efficiency
 *  - OFAC sanctioned country validation
 */

import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import * as dns from "dns/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ParameterDef>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

interface ParameterDef {
  type: string;
  description: string;
  required?: boolean;
  enum?: string[];
  default?: unknown;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_RESPONSE_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB hard cap on fetch responses

/** OFAC sanctioned countries — must never be used as geo-targeting destinations. */
const SANCTIONED_COUNTRIES = new Set(["CU", "IR", "KP", "RU", "SY"]);

/** ISO 3166-1 alpha-2 country code pattern. */
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

/** UUID v4 pattern for wallet/team IDs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const key = process.env.DOMINUSNODE_API_KEY;
  if (!key || typeof key !== "string" || key.trim().length === 0) {
    throw new Error(
      "DOMINUSNODE_API_KEY environment variable is required. " +
        'Set it to your DomiNode API key (starts with "dn_live_" or "dn_test_").',
    );
  }
  const trimmed = key.trim();
  if (!trimmed.startsWith("dn_live_") && !trimmed.startsWith("dn_test_")) {
    throw new Error('DOMINUSNODE_API_KEY must start with "dn_live_" or "dn_test_".');
  }
  return trimmed;
}

function getBaseUrl(): string {
  const url = process.env.DOMINUSNODE_BASE_URL;
  if (url && typeof url === "string" && url.trim().length > 0) {
    // Strip trailing slash
    return url.trim().replace(/\/+$/, "");
  }
  return "https://api.dominusnode.com";
}

function getProxyHost(): string {
  return process.env.DOMINUSNODE_PROXY_HOST || "proxy.dominusnode.com";
}

function getProxyPort(): number {
  const port = parseInt(process.env.DOMINUSNODE_PROXY_PORT || "8080", 10);
  if (isNaN(port) || port < 1 || port > 65535) return 8080;
  return port;
}

// ---------------------------------------------------------------------------
// Credential scrubbing
// ---------------------------------------------------------------------------

/** Remove any dn_live_* or dn_test_* tokens from error messages. */
function scrubCredentials(msg: string): string {
  return msg.replace(/dn_(live|test)_[A-Za-z0-9_-]+/g, "dn_$1_***REDACTED***");
}

function safeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return scrubCredentials(raw);
}

// ---------------------------------------------------------------------------
// Response truncation
// ---------------------------------------------------------------------------

function truncate(text: string, max: number = MAX_RESPONSE_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n... [truncated, ${text.length - max} chars omitted]`;
}

// ---------------------------------------------------------------------------
// SSRF Protection
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
 * Normalize non-standard IPv4 representations to dotted-decimal.
 * Handles: decimal integers (2130706433), hex (0x7f000001), octal octets (0177.0.0.1).
 */
function normalizeIpv4(hostname: string): string | null {
  // Single decimal integer
  if (/^\d+$/.test(hostname)) {
    const n = parseInt(hostname, 10);
    if (n >= 0 && n <= 0xffffffff) {
      return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
    }
  }
  // Hex notation
  if (/^0x[0-9a-fA-F]+$/i.test(hostname)) {
    const n = parseInt(hostname, 16);
    if (n >= 0 && n <= 0xffffffff) {
      return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
    }
  }
  // Octal / mixed-radix octets
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
  // Strip IPv6 zone ID
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
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
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
    if (embedded.includes(".")) {
      return isPrivateIp(embedded);
    }
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

/**
 * Validate a URL for safety before proxying.
 * Blocks: private IPs, localhost, .local/.internal/.arpa, embedded credentials, non-http(s).
 */
function validateTargetUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${scrubCredentials(url)}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http: and https: protocols are supported, got ${parsed.protocol}`);
  }

  // Block embedded credentials (user:pass@host)
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error("Requests to localhost/loopback addresses are blocked");
  }

  if (isPrivateIp(hostname)) {
    throw new Error("Requests to private/internal IP addresses are blocked");
  }

  // Block .localhost TLD (RFC 6761)
  if (hostname.endsWith(".localhost")) {
    throw new Error("Requests to localhost/loopback addresses are blocked");
  }

  // Block internal network TLDs
  if (
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".arpa")
  ) {
    throw new Error("Requests to internal network hostnames are blocked");
  }

  return parsed;
}

/**
 * Validate a country code: must be 2 uppercase letters and not OFAC sanctioned.
 */
function validateCountry(country: string | undefined): string | undefined {
  if (!country) return undefined;
  const upper = country.toUpperCase().trim();
  if (!COUNTRY_CODE_RE.test(upper)) {
    throw new Error(`Invalid country code: "${country}". Must be a 2-letter ISO 3166-1 code.`);
  }
  if (SANCTIONED_COUNTRIES.has(upper)) {
    throw new Error(
      `Country "${upper}" is OFAC sanctioned and cannot be used as a proxy target.`,
    );
  }
  return upper;
}

/**
 * Validate a UUID string.
 */
function validateUuid(id: string, label: string): string {
  const trimmed = id.trim();
  if (!UUID_RE.test(trimmed)) {
    throw new Error(`Invalid ${label}: must be a valid UUID.`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// DNS rebinding protection
// ---------------------------------------------------------------------------

/**
 * Resolve a hostname via DNS and verify none of the resolved IPs are private.
 * Skips check if the hostname is already an IP literal.
 */
async function checkDnsRebinding(hostname: string): Promise<void> {
  // If hostname is already an IP literal (v4 or bracketed v6), skip DNS resolution
  const stripped = hostname.replace(/^\[|\]$/g, "");
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(stripped) || stripped.includes(":")) {
    return;
  }

  const resolvedIps: string[] = [];

  try {
    const ipv4s = await dns.resolve4(hostname);
    resolvedIps.push(...ipv4s);
  } catch {
    // NODATA or NXDOMAIN for A records is fine, continue to AAAA
  }

  try {
    const ipv6s = await dns.resolve6(hostname);
    resolvedIps.push(...ipv6s);
  } catch {
    // NODATA or NXDOMAIN for AAAA records is fine
  }

  for (const ip of resolvedIps) {
    if (isPrivateIp(ip)) {
      throw new Error(
        `DNS rebinding detected: hostname resolves to private IP ${ip}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Prototype pollution prevention (recursive)
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

// ---------------------------------------------------------------------------
// Lazy JWT authentication
// ---------------------------------------------------------------------------

let cachedJwt: string | null = null;
let jwtExpiresAt = 0;

async function ensureAuth(apiKey: string, baseUrl: string): Promise<string> {
  if (cachedJwt && Date.now() < jwtExpiresAt) return cachedJwt;
  const res = await fetch(`${baseUrl}/api/auth/verify-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "dominusnode-openclaw-plugin/1.0.0" },
    body: JSON.stringify({ apiKey }),
    redirect: "error",
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const data = await res.json() as { accessToken: string; refreshToken: string };
  cachedJwt = data.accessToken;
  // JWT expires in 15 min, refresh at 14 min for safety
  jwtExpiresAt = Date.now() + 14 * 60 * 1000;
  return cachedJwt;
}

// ---------------------------------------------------------------------------
// HTTP client for DomiNode API
// ---------------------------------------------------------------------------

interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

async function apiRequest<T = unknown>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;

  const jwt = await ensureAuth(apiKey, baseUrl);
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${jwt}`,
    "Accept": "application/json",
    "User-Agent": "dominusnode-openclaw-plugin/1.0.0",
  };

  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  };

  if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`API request failed: ${safeError(err)}`);
  }

  // Read body as text first, then parse (safeJson pattern)
  let rawText: string;
  try {
    rawText = await res.text();
  } catch {
    rawText = "";
  }

  if (new TextEncoder().encode(rawText).length > MAX_RESPONSE_BYTES) {
    throw new Error("API response too large");
  }

  if (!res.ok) {
    let errorMsg = `API error ${res.status}`;
    if (rawText) {
      try {
        const parsed = JSON.parse(rawText);
        stripDangerousKeys(parsed);
        if (parsed.error) {
          errorMsg = `API error ${res.status}: ${scrubCredentials(String(parsed.error))}`;
        } else if (parsed.message) {
          errorMsg = `API error ${res.status}: ${scrubCredentials(String(parsed.message))}`;
        }
      } catch {
        errorMsg = `API error ${res.status}: ${scrubCredentials(rawText.slice(0, 200))}`;
      }
    }
    throw new Error(errorMsg);
  }

  if (!rawText || rawText.trim().length === 0) {
    return {} as T;
  }

  try {
    const parsed = JSON.parse(rawText);
    stripDangerousKeys(parsed);
    return parsed as T;
  } catch {
    throw new Error("Failed to parse API response as JSON");
  }
}

async function apiGet<T = unknown>(path: string): Promise<T> {
  return apiRequest<T>("GET", path);
}

async function apiPost<T = unknown>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  return apiRequest<T>("POST", path, body);
}

async function apiDelete<T = unknown>(path: string): Promise<T> {
  return apiRequest<T>("DELETE", path);
}

async function apiPatch<T = unknown>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  return apiRequest<T>("PATCH", path, body);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(3)} GB`;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

// 1. proxied_fetch
const proxiedFetchTool: ToolDefinition = {
  name: "proxied_fetch",
  description:
    "Fetch a URL through DomiNode's rotating proxy network. Supports geo-targeting " +
    "by country. Returns status code, headers, and response body (truncated to 4000 chars).",
  parameters: {
    url: {
      type: "string",
      description: "The URL to fetch (http or https)",
      required: true,
    },
    method: {
      type: "string",
      description: "HTTP method",
      required: false,
      enum: ["GET", "HEAD", "OPTIONS"],
      default: "GET",
    },
    country: {
      type: "string",
      description: "ISO 3166-1 alpha-2 country code for geo-targeting (e.g., US, GB, DE)",
      required: false,
    },
    pool: {
      type: "string",
      description: "Proxy pool to use: dc (datacenter, $3/GB) or residential ($5/GB)",
      required: false,
      enum: ["dc", "residential"],
      default: "dc",
    },
    headers: {
      type: "object",
      description: "Additional HTTP headers to include in the request (JSON object of key-value pairs)",
      required: false,
    },
  },
  execute: async (args) => {
    try {
      const url = String(args.url ?? "");
      if (!url) return "Error: url parameter is required.";

      const parsedUrl = validateTargetUrl(url);
      await checkDnsRebinding(parsedUrl.hostname);
      const country = validateCountry(args.country as string | undefined);
      const method = String(args.method ?? "GET").toUpperCase();
      const ALLOWED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
      if (!ALLOWED_METHODS.has(method)) {
        return `Error: HTTP method "${method}" is not allowed. Only GET, HEAD, and OPTIONS are permitted.`;
      }
      const proxyType = String(args.pool ?? "dc");

      // Validate and collect custom headers
      const STRIPPED_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "proxy-authorization", "authorization", "user-agent"]);
      const customHeaders: Record<string, string> = {};
      if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
        for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
          const key = String(k);
          const val = String(v ?? "");
          if (/[\r\n\0]/.test(key) || /[\r\n\0]/.test(val)) {
            return `Error: Header "${key.replace(/[\r\n\0]/g, "")}" contains invalid characters (CR, LF, or NUL).`;
          }
          if (!STRIPPED_HEADERS.has(key.toLowerCase())) {
            customHeaders[key] = val;
          }
        }
      }

      const proxyHost = getProxyHost();
      const proxyPort = getProxyPort();
      const apiKey = getApiKey();
      const parts: string[] = [];
      if (proxyType && proxyType !== "auto") parts.push(proxyType);
      if (country) parts.push(`country-${country.toUpperCase()}`);
      const username = parts.length > 0 ? parts.join("-") : "auto";
      const proxyAuth = "Basic " + Buffer.from(`${username}:${apiKey}`).toString("base64");

      const parsed = new URL(url);
      const MAX_RESP = 1_048_576; // 1MB

      // Build custom header lines for raw HTTP request
      const customHeaderLines = Object.entries(customHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join("");

      const result = await new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Proxy request timed out")), 30_000);

        if (parsed.protocol === "https:") {
          const connectReq = http.request({
            hostname: proxyHost, port: proxyPort, method: "CONNECT",
            path: `${parsed.hostname}:${parsed.port || 443}`,
            headers: { "Proxy-Authorization": proxyAuth, Host: `${parsed.hostname}:${parsed.port || 443}` },
          });
          connectReq.on("connect", (_res, sock) => {
            if (_res.statusCode !== 200) { clearTimeout(timer); sock.destroy(); reject(new Error(`CONNECT failed: ${_res.statusCode}`)); return; }
            const tlsSock = tls.connect({ host: parsed.hostname, socket: sock as net.Socket, servername: parsed.hostname, minVersion: "TLSv1.2" }, () => {
              const reqLine = `${method} ${parsed.pathname + parsed.search} HTTP/1.1\r\nHost: ${parsed.host}\r\nUser-Agent: dominusnode-openclaw/1.0.0\r\n${customHeaderLines}Connection: close\r\n\r\n`;
              tlsSock.write(reqLine);
              const chunks: Buffer[] = []; let bytes = 0;
              tlsSock.on("data", (c: Buffer) => { bytes += c.length; if (bytes <= MAX_RESP + 16384) chunks.push(c); });
              let done = false;
              const fin = () => { if (done) return; done = true; clearTimeout(timer);
                const raw = Buffer.concat(chunks).toString("utf-8");
                const hEnd = raw.indexOf("\r\n\r\n");
                if (hEnd === -1) { reject(new Error("Malformed response")); return; }
                const hdr = raw.substring(0, hEnd); const body = raw.substring(hEnd + 4).substring(0, MAX_RESP);
                const sm = hdr.split("\r\n")[0].match(/^HTTP\/\d\.\d\s+(\d+)/);
                const hdrs: Record<string, string> = {};
                for (const l of hdr.split("\r\n").slice(1)) { const ci = l.indexOf(":"); if (ci > 0) hdrs[l.substring(0, ci).trim().toLowerCase()] = l.substring(ci + 1).trim(); }
                resolve({ status: sm ? parseInt(sm[1], 10) : 0, headers: hdrs, body });
              };
              tlsSock.on("end", fin); tlsSock.on("close", fin);
              tlsSock.on("error", (e) => { clearTimeout(timer); reject(e); });
            });
            tlsSock.on("error", (e) => { clearTimeout(timer); reject(e); });
          });
          connectReq.on("error", (e) => { clearTimeout(timer); reject(e); });
          connectReq.end();
        } else {
          const req = http.request({
            hostname: proxyHost, port: proxyPort, method, path: url,
            headers: { "Proxy-Authorization": proxyAuth, Host: parsed.host ?? "", ...customHeaders },
          }, (res) => {
            const chunks: Buffer[] = []; let bytes = 0;
            res.on("data", (c: Buffer) => { bytes += c.length; if (bytes <= MAX_RESP) chunks.push(c); });
            let done = false;
            const fin = () => { if (done) return; done = true; clearTimeout(timer);
              const body = Buffer.concat(chunks).toString("utf-8").substring(0, MAX_RESP);
              const hdrs: Record<string, string> = {};
              for (const [k, v] of Object.entries(res.headers)) { if (v) hdrs[k] = Array.isArray(v) ? v.join(", ") : v; }
              resolve({ status: res.statusCode ?? 0, headers: hdrs, body });
            };
            res.on("end", fin); res.on("close", fin);
            res.on("error", (e) => { clearTimeout(timer); reject(e); });
          });
          req.on("error", (e) => { clearTimeout(timer); reject(e); });
          req.end();
        }
      });

      const lines = [
        `HTTP ${result.status}`,
        `Pool: ${proxyType} | Country: ${country ?? "auto"}`,
        "",
      ];

      // Include relevant response headers
      if (result.headers) {
        const showHeaders = ["content-type", "content-length", "server", "x-cache", "cache-control"];
        for (const h of showHeaders) {
          if (result.headers[h]) {
            lines.push(`${h}: ${result.headers[h]}`);
          }
        }
        lines.push("");
      }

      if (result.body) {
        lines.push(truncate(result.body));
      }

      return scrubCredentials(truncate(lines.join("\n")));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 2. check_balance
const checkBalanceTool: ToolDefinition = {
  name: "check_balance",
  description:
    "Check your DomiNode wallet balance and estimated remaining bandwidth at current pricing.",
  parameters: {},
  execute: async () => {
    try {
      const data = await apiGet<{
        balanceCents: number;
        balanceUsd: number;
      }>("/api/wallet");

      const balanceCents = data.balanceCents ?? 0;
      const balanceUsd = data.balanceUsd ?? balanceCents / 100;
      const dcGbRemaining = (balanceCents / 300).toFixed(2);
      const resGbRemaining = (balanceCents / 500).toFixed(2);

      return [
        `Wallet Balance: $${balanceUsd.toFixed(2)}`,
        "",
        "Estimated remaining bandwidth:",
        `  Datacenter ($3/GB): ~${dcGbRemaining} GB`,
        `  Residential ($5/GB): ~${resGbRemaining} GB`,
        "",
        "Use check_usage to see recent consumption.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 3. check_usage
const checkUsageTool: ToolDefinition = {
  name: "check_usage",
  description:
    "View bandwidth usage statistics for a specified time period. Shows total bytes, cost, and request count.",
  parameters: {
    days: {
      type: "number",
      description: "Number of days to look back (1-365)",
      required: false,
      default: 30,
    },
  },
  execute: async (args) => {
    try {
      const days = Math.min(Math.max(Number(args.days ?? 30), 1), 365);

      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const until = new Date().toISOString();
      const data = await apiGet<{
        summary: {
          totalBytes: number;
          totalCostUsd: number;
          requestCount: number;
        };
      }>(`/api/usage?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`);

      const s = data.summary;
      return [
        `Usage Summary (last ${days} days):`,
        `  Total Bandwidth: ${formatBytes(s.totalBytes)}`,
        `  Total Cost: $${s.totalCostUsd.toFixed(2)}`,
        `  Total Requests: ${s.requestCount}`,
        "",
        "Use check_balance to see remaining funds.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 4. get_proxy_config
const getProxyConfigTool: ToolDefinition = {
  name: "get_proxy_config",
  description:
    "Get available proxy pools, pricing, supported countries, and endpoint configuration.",
  parameters: {},
  execute: async () => {
    try {
      const data = await apiGet<{
        pools: Array<{
          name: string;
          type: string;
          pricePerGbCents: number;
          countries?: string[];
        }>;
        httpProxyPort: number;
        socks5ProxyPort: number;
        proxyHost: string;
      }>("/api/proxy/config");

      const lines = [
        "DomiNode Proxy Configuration",
        "",
        `Proxy Host: ${data.proxyHost ?? "proxy.dominusnode.com"}`,
        `HTTP Proxy Port: ${data.httpProxyPort ?? 8080}`,
        `SOCKS5 Proxy Port: ${data.socks5ProxyPort ?? 1080}`,
        "",
        "Available Pools:",
      ];

      if (data.pools) {
        for (const pool of data.pools) {
          lines.push(`  ${pool.name} (${pool.type}): ${formatCents(pool.pricePerGbCents)}/GB`);
          if (pool.countries && pool.countries.length > 0) {
            lines.push(`    Countries: ${pool.countries.slice(0, 20).join(", ")}${pool.countries.length > 20 ? "..." : ""}`);
          }
        }
      } else {
        lines.push("  Datacenter (dc): $3.00/GB");
        lines.push("  Residential (residential): $5.00/GB");
      }

      lines.push("");
      lines.push("Blocked countries (OFAC): CU, IR, KP, RU, SY");

      return lines.join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 5. list_sessions
const listSessionsTool: ToolDefinition = {
  name: "list_sessions",
  description: "List all active proxy sessions showing target hosts, bandwidth used, and status.",
  parameters: {},
  execute: async () => {
    try {
      const data = await apiGet<{
        sessions: Array<{
          id: string;
          status: string;
          startedAt: string;
          targetHost?: string;
          bytesIn?: number;
          bytesOut?: number;
        }>;
      }>("/api/sessions/active");

      const sessions = data.sessions ?? [];
      if (sessions.length === 0) {
        return "No active proxy sessions.";
      }

      const lines = [`Active Sessions (${sessions.length}):`, ""];
      for (const s of sessions) {
        const target = s.targetHost ? ` | Target: ${s.targetHost}` : "";
        const bw =
          s.bytesIn !== undefined || s.bytesOut !== undefined
            ? ` | In: ${formatBytes(s.bytesIn ?? 0)} / Out: ${formatBytes(s.bytesOut ?? 0)}`
            : "";
        lines.push(`  ${s.id.substring(0, 8)}... | ${s.status} | Since: ${s.startedAt}${target}${bw}`);
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 6. create_agentic_wallet
const createAgenticWalletTool: ToolDefinition = {
  name: "create_agentic_wallet",
  description:
    "Create a server-side custodial agentic wallet for autonomous proxy billing. " +
    "Set a spending limit per transaction for safety. Fund it from your main wallet.",
  parameters: {
    label: {
      type: "string",
      description: 'Label for this wallet (e.g., "scraper-bot", "research-agent")',
      required: true,
    },
    spending_limit_cents: {
      type: "number",
      description: "Max spend per transaction in cents (0 = no limit, default $100 = 10000 cents)",
      required: false,
      default: 10000,
    },
  },
  execute: async (args) => {
    try {
      const label = String(args.label ?? "").trim();
      if (!label || label.length === 0 || label.length > 100) {
        return "Error: label is required and must be 1-100 characters.";
      }
      // Sanitize label: strip control characters
      if (/[\x00-\x1f\x7f]/.test(label)) {
        return "Error: label contains invalid control characters.";
      }

      const spendingLimitCents = Math.min(
        Math.max(Number(args.spending_limit_cents ?? 10000), 0),
        1000000,
      );

      const data = await apiPost<{
        id: string;
        label: string;
        balanceCents: number;
        spendingLimitCents: number;
        status: string;
        createdAt: string;
      }>("/api/agent-wallet", {
        label,
        spendingLimitCents,
      });

      return [
        "Agentic Wallet Created",
        "",
        `Wallet ID: ${data.id}`,
        `Label: ${data.label}`,
        `Balance: ${formatCents(data.balanceCents)}`,
        `Spending Limit: ${data.spendingLimitCents > 0 ? `${formatCents(data.spendingLimitCents)} per transaction` : "No limit"}`,
        `Status: ${data.status}`,
        "",
        "Next steps:",
        "  1. Use fund_agentic_wallet to add funds from your main wallet",
        "  2. Use check_agentic_balance to verify the balance",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 7. fund_agentic_wallet
const fundAgenticWalletTool: ToolDefinition = {
  name: "fund_agentic_wallet",
  description:
    "Transfer funds from your main wallet to an agentic wallet. Minimum $1 (100 cents), maximum $10,000 (1000000 cents).",
  parameters: {
    wallet_id: {
      type: "string",
      description: "Agentic wallet ID (UUID)",
      required: true,
    },
    amount_cents: {
      type: "number",
      description: "Amount in cents to transfer (min 100, max 1000000)",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const walletId = validateUuid(String(args.wallet_id ?? ""), "wallet_id");
      const amountCents = Number(args.amount_cents ?? 0);
      if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > 1000000) {
        return "Error: amount_cents must be an integer between 100 ($1) and 1000000 ($10,000).";
      }

      const data = await apiPost<{
        transaction: {
          id: string;
          walletId: string;
          type: string;
          amountCents: number;
          description: string;
          createdAt: string;
        };
      }>(`/api/agent-wallet/${encodeURIComponent(walletId)}/fund`, {
        amountCents,
      });

      const tx = data.transaction;
      return [
        "Wallet Funded Successfully",
        "",
        `Transaction ID: ${tx.id}`,
        `Amount: ${formatCents(tx.amountCents)}`,
        `Type: ${tx.type}`,
        "",
        "The funds have been transferred from your main wallet.",
        "Use check_agentic_balance to verify the new balance.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 8. check_agentic_balance
const checkAgenticBalanceTool: ToolDefinition = {
  name: "check_agentic_balance",
  description: "Check the balance and details of an agentic wallet.",
  parameters: {
    wallet_id: {
      type: "string",
      description: "Agentic wallet ID (UUID)",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const walletId = validateUuid(String(args.wallet_id ?? ""), "wallet_id");

      const data = await apiGet<{
        id: string;
        label: string;
        balanceCents: number;
        spendingLimitCents: number;
        status: string;
        createdAt: string;
      }>(`/api/agent-wallet/${encodeURIComponent(walletId)}`);

      return [
        `Agentic Wallet: ${data.label}`,
        "",
        `Wallet ID: ${data.id}`,
        `Balance: ${formatCents(data.balanceCents)}`,
        `Spending Limit: ${data.spendingLimitCents > 0 ? `${formatCents(data.spendingLimitCents)} per tx` : "No limit"}`,
        `Status: ${data.status}`,
        `Created: ${data.createdAt}`,
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 9. list_agentic_wallets
const listAgenticWalletsTool: ToolDefinition = {
  name: "list_agentic_wallets",
  description: "List all your agentic wallets with balances and status.",
  parameters: {},
  execute: async () => {
    try {
      const data = await apiGet<{
        wallets: Array<{
          id: string;
          label: string;
          balanceCents: number;
          spendingLimitCents: number;
          status: string;
          createdAt: string;
        }>;
      }>("/api/agent-wallet");

      const wallets = data.wallets ?? [];
      if (wallets.length === 0) {
        return "No agentic wallets found. Use create_agentic_wallet to create one.";
      }

      const lines = [`Agentic Wallets (${wallets.length})`, ""];
      for (const w of wallets) {
        const limit =
          w.spendingLimitCents > 0
            ? `${formatCents(w.spendingLimitCents)}/tx`
            : "none";
        lines.push(`  ${w.label} (${w.id.slice(0, 8)}...)`);
        lines.push(`    Balance: ${formatCents(w.balanceCents)} | Limit: ${limit} | Status: ${w.status}`);
        lines.push("");
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 10. agentic_transactions
const agenticTransactionsTool: ToolDefinition = {
  name: "agentic_transactions",
  description: "Get transaction history for an agentic wallet.",
  parameters: {
    wallet_id: {
      type: "string",
      description: "Agentic wallet ID (UUID)",
      required: true,
    },
    limit: {
      type: "number",
      description: "Number of transactions to return (1-100, default 20)",
      required: false,
      default: 20,
    },
  },
  execute: async (args) => {
    try {
      const walletId = validateUuid(String(args.wallet_id ?? ""), "wallet_id");
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);

      const data = await apiGet<{
        transactions: Array<{
          id: string;
          walletId: string;
          type: string;
          amountCents: number;
          description: string;
          sessionId: string | null;
          createdAt: string;
        }>;
      }>(`/api/agent-wallet/${encodeURIComponent(walletId)}/transactions?limit=${limit}`);

      const txs = data.transactions ?? [];
      if (txs.length === 0) {
        return "No transactions found for this wallet.";
      }

      const lines = [`Wallet Transactions (${txs.length})`, ""];
      for (const tx of txs) {
        const sign = tx.type === "fund" || tx.type === "refund" ? "+" : "-";
        const session = tx.sessionId ? ` | Session: ${tx.sessionId.slice(0, 8)}` : "";
        lines.push(`  ${sign}${formatCents(tx.amountCents)} [${tx.type}] ${tx.description}`);
        lines.push(`    ${tx.createdAt}${session}`);
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 11. create_team
const createTeamTool: ToolDefinition = {
  name: "create_team",
  description:
    "Create a new team with shared wallet billing. Teams allow multiple users to share proxy access and costs.",
  parameters: {
    name: {
      type: "string",
      description: "Team name (1-100 characters)",
      required: true,
    },
    max_members: {
      type: "number",
      description: "Maximum number of team members (optional, no limit by default)",
      required: false,
    },
  },
  execute: async (args) => {
    try {
      const name = String(args.name ?? "").trim();
      if (!name || name.length === 0 || name.length > 100) {
        return "Error: name is required and must be 1-100 characters.";
      }
      if (/[\x00-\x1f\x7f]/.test(name)) {
        return "Error: team name contains invalid control characters.";
      }

      const body: Record<string, unknown> = { name };
      if (args.max_members !== undefined) {
        const maxMembers = Number(args.max_members);
        if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 100) {
          return "Error: max_members must be an integer between 1 and 100.";
        }
        body.maxMembers = maxMembers;
      }

      const data = await apiPost<{
        id: string;
        name: string;
        ownerId: string;
        maxMembers: number | null;
        status: string;
        walletId: string;
        createdAt: string;
        balanceCents?: number;
      }>("/api/teams", body);

      return [
        "Team Created",
        "",
        `Team ID: ${data.id}`,
        `Name: ${data.name}`,
        `Max Members: ${data.maxMembers ?? "Unlimited"}`,
        `Balance: ${formatCents(data.balanceCents ?? 0)}`,
        `Created: ${data.createdAt}`,
        "",
        "Next steps:",
        "  1. Use team_fund to add funds from your personal wallet",
        "  2. Use team_create_key to create a shared API key",
        "  3. Share the team with colleagues via the dashboard",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 12. list_teams
const listTeamsTool: ToolDefinition = {
  name: "list_teams",
  description: "List all teams you belong to, with your role and team balance.",
  parameters: {},
  execute: async () => {
    try {
      const data = await apiGet<{
        teams: Array<{
          id: string;
          name: string;
          ownerId: string;
          maxMembers: number | null;
          status: string;
          role: string;
          balanceCents: number;
          memberCount?: number;
          createdAt: string;
        }>;
      }>("/api/teams");

      const teams = data.teams ?? [];
      if (teams.length === 0) {
        return "No teams found. Use create_team to create one.";
      }

      const lines = [`Teams (${teams.length})`, ""];
      for (const t of teams) {
        const memberInfo = t.memberCount !== undefined ? ` | Members: ${t.memberCount}` : "";
        lines.push(`  ${t.name} (${t.id.slice(0, 8)}...)`);
        lines.push(`    Role: ${t.role} | Balance: ${formatCents(t.balanceCents)}${memberInfo}`);
        lines.push("");
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 13. team_details
const teamDetailsTool: ToolDefinition = {
  name: "team_details",
  description:
    "Get detailed info about a team including balance, members, settings, and your role.",
  parameters: {
    team_id: {
      type: "string",
      description: "Team ID (UUID)",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const teamId = validateUuid(String(args.team_id ?? ""), "team_id");

      const data = await apiGet<{
        id: string;
        name: string;
        ownerId: string;
        maxMembers: number | null;
        status: string;
        role: string;
        balanceCents: number;
        createdAt: string;
        members?: Array<{
          userId: string;
          email: string;
          role: string;
          joinedAt: string;
        }>;
      }>(`/api/teams/${encodeURIComponent(teamId)}`);

      const lines = [
        `Team: ${data.name}`,
        "",
        `Team ID: ${data.id}`,
        `Owner: ${data.ownerId}`,
        `Status: ${data.status}`,
        `Your Role: ${data.role}`,
        `Balance: ${formatCents(data.balanceCents)}`,
        `Max Members: ${data.maxMembers ?? "Unlimited"}`,
        `Created: ${data.createdAt}`,
      ];

      const members = data.members ?? [];
      if (members.length > 0) {
        lines.push("", `Members (${members.length}):`);
        for (const m of members) {
          lines.push(`  ${m.email} -- ${m.role} (joined ${m.joinedAt})`);
        }
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 14. team_fund
const teamFundTool: ToolDefinition = {
  name: "team_fund",
  description:
    "Transfer funds from your personal wallet to a team wallet. Minimum $1 (100 cents), maximum $10,000.",
  parameters: {
    team_id: {
      type: "string",
      description: "Team ID (UUID)",
      required: true,
    },
    amount_cents: {
      type: "number",
      description: "Amount in cents to transfer (min 100, max 1000000)",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const teamId = validateUuid(String(args.team_id ?? ""), "team_id");
      const amountCents = Number(args.amount_cents ?? 0);
      if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > 1000000) {
        return "Error: amount_cents must be an integer between 100 ($1) and 1000000 ($10,000).";
      }

      const data = await apiPost<{
        transaction: {
          id: string;
          walletId: string;
          type: string;
          amountCents: number;
          description: string;
          createdAt: string;
        };
      }>(`/api/teams/${encodeURIComponent(teamId)}/wallet/fund`, {
        amountCents,
      });

      const tx = data.transaction;
      return [
        "Team Funded Successfully",
        "",
        `Transaction ID: ${tx.id}`,
        `Amount: ${formatCents(tx.amountCents)}`,
        `Type: ${tx.type}`,
        "",
        "The funds have been transferred from your personal wallet.",
        "Use team_details to check the new team balance.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 15. team_create_key
const teamCreateKeyTool: ToolDefinition = {
  name: "team_create_key",
  description:
    "Create a shared API key for a team. Usage is billed against the team wallet. " +
    "The key is shown only once -- save it immediately.",
  parameters: {
    team_id: {
      type: "string",
      description: "Team ID (UUID)",
      required: true,
    },
    label: {
      type: "string",
      description: 'Label for the API key (e.g., "production", "staging")',
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const teamId = validateUuid(String(args.team_id ?? ""), "team_id");
      const label = String(args.label ?? "").trim();
      if (!label || label.length === 0 || label.length > 100) {
        return "Error: label is required and must be 1-100 characters.";
      }
      if (/[\x00-\x1f\x7f]/.test(label)) {
        return "Error: label contains invalid control characters.";
      }

      const data = await apiPost<{
        id: string;
        key: string;
        prefix: string;
        label: string;
        createdAt: string;
      }>(`/api/teams/${encodeURIComponent(teamId)}/keys`, {
        label,
      });

      return [
        "Team API Key Created",
        "",
        `Key ID: ${data.id}`,
        `API Key: ${data.key}`,
        `Prefix: ${data.prefix}`,
        `Label: ${data.label}`,
        `Team ID: ${teamId}`,
        `Created: ${data.createdAt}`,
        "",
        "IMPORTANT: Save this API key now -- it will not be shown again.",
        "Usage is billed against the team wallet.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 16. team_usage
const teamUsageTool: ToolDefinition = {
  name: "team_usage",
  description: "Get the team wallet transaction history (funding, usage charges, refunds).",
  parameters: {
    team_id: {
      type: "string",
      description: "Team ID (UUID)",
      required: true,
    },
    limit: {
      type: "number",
      description: "Number of transactions to return (1-100, default 20)",
      required: false,
      default: 20,
    },
  },
  execute: async (args) => {
    try {
      const teamId = validateUuid(String(args.team_id ?? ""), "team_id");
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);

      const data = await apiGet<{
        transactions: Array<{
          id: string;
          walletId: string;
          type: string;
          amountCents: number;
          description: string;
          createdAt: string;
        }>;
      }>(`/api/teams/${encodeURIComponent(teamId)}/wallet/transactions?limit=${limit}`);

      const txs = data.transactions ?? [];
      if (txs.length === 0) {
        return "No transactions found for this team. Use team_fund to add funds.";
      }

      const lines = [`Team Transactions (${txs.length})`, ""];
      for (const tx of txs) {
        const sign = tx.type === "fund" || tx.type === "refund" ? "+" : "-";
        lines.push(`  ${sign}${formatCents(tx.amountCents)} [${tx.type}] ${tx.description}`);
        lines.push(`    ${tx.createdAt} | Wallet: ${tx.walletId.slice(0, 8)}...`);
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 17. freeze_agentic_wallet
const freezeAgenticWalletTool: ToolDefinition = {
  name: "freeze_agentic_wallet",
  description:
    "Freeze an agentic wallet to prevent any further spending. The wallet balance is preserved but no transactions are allowed until unfrozen.",
  parameters: {
    wallet_id: {
      type: "string",
      description: "Agentic wallet ID (UUID)",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const walletId = validateUuid(String(args.wallet_id ?? ""), "wallet_id");

      const data = await apiPost<{
        id: string;
        label: string;
        balanceCents: number;
        spendingLimitCents: number;
        status: string;
      }>(`/api/agent-wallet/${encodeURIComponent(walletId)}/freeze`);

      return [
        "Agentic Wallet Frozen",
        "",
        `Wallet ID: ${data.id}`,
        `Label: ${data.label}`,
        `Balance: ${formatCents(data.balanceCents)}`,
        `Status: ${data.status}`,
        "",
        "The wallet is now frozen. No spending is allowed until unfrozen.",
        "Use unfreeze_agentic_wallet to re-enable spending.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 18. unfreeze_agentic_wallet
const unfreezeAgenticWalletTool: ToolDefinition = {
  name: "unfreeze_agentic_wallet",
  description:
    "Unfreeze a previously frozen agentic wallet to re-enable spending.",
  parameters: {
    wallet_id: {
      type: "string",
      description: "Agentic wallet ID (UUID)",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const walletId = validateUuid(String(args.wallet_id ?? ""), "wallet_id");

      const data = await apiPost<{
        id: string;
        label: string;
        balanceCents: number;
        spendingLimitCents: number;
        status: string;
      }>(`/api/agent-wallet/${encodeURIComponent(walletId)}/unfreeze`);

      return [
        "Agentic Wallet Unfrozen",
        "",
        `Wallet ID: ${data.id}`,
        `Label: ${data.label}`,
        `Balance: ${formatCents(data.balanceCents)}`,
        `Status: ${data.status}`,
        "",
        "The wallet is now active and spending is re-enabled.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 19. delete_agentic_wallet
const deleteAgenticWalletTool: ToolDefinition = {
  name: "delete_agentic_wallet",
  description:
    "Delete an agentic wallet. Any remaining balance is refunded to your main wallet.",
  parameters: {
    wallet_id: {
      type: "string",
      description: "Agentic wallet ID (UUID)",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const walletId = validateUuid(String(args.wallet_id ?? ""), "wallet_id");

      await apiDelete(`/api/agent-wallet/${encodeURIComponent(walletId)}`);

      return [
        "Agentic Wallet Deleted",
        "",
        `Wallet ID: ${walletId}`,
        "",
        "Any remaining balance has been refunded to your main wallet.",
        "Use check_balance to verify the refund.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 20. update_team
const updateTeamTool: ToolDefinition = {
  name: "update_team",
  description:
    "Update a team's settings (name and/or max member count). Only owners and admins can update.",
  parameters: {
    team_id: {
      type: "string",
      description: "Team ID (UUID)",
      required: true,
    },
    name: {
      type: "string",
      description: "New team name (1-100 characters). Optional -- omit to keep current.",
      required: false,
    },
    max_members: {
      type: "number",
      description: "New max member count (1-100). Optional -- omit to keep current.",
      required: false,
    },
  },
  execute: async (args) => {
    try {
      const teamId = validateUuid(String(args.team_id ?? ""), "team_id");

      const body: Record<string, unknown> = {};

      if (args.name !== undefined) {
        const name = String(args.name).trim();
        if (!name || name.length === 0 || name.length > 100) {
          return "Error: name must be 1-100 characters.";
        }
        if (/[\x00-\x1f\x7f]/.test(name)) {
          return "Error: team name contains invalid control characters.";
        }
        body.name = name;
      }

      if (args.max_members !== undefined) {
        const maxMembers = Number(args.max_members);
        if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 100) {
          return "Error: max_members must be an integer between 1 and 100.";
        }
        body.maxMembers = maxMembers;
      }

      if (Object.keys(body).length === 0) {
        return "Error: At least one of name or max_members must be provided.";
      }

      const data = await apiPatch<{
        id: string;
        name: string;
        maxMembers: number | null;
        status: string;
      }>(`/api/teams/${encodeURIComponent(teamId)}`, body);

      return [
        "Team Updated",
        "",
        `Team ID: ${data.id}`,
        `Name: ${data.name}`,
        `Max Members: ${data.maxMembers ?? "Unlimited"}`,
        `Status: ${data.status}`,
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 21. update_team_member_role
const updateTeamMemberRoleTool: ToolDefinition = {
  name: "update_team_member_role",
  description:
    "Update a team member's role (member or admin). Only owners and admins can change roles.",
  parameters: {
    team_id: {
      type: "string",
      description: "Team ID (UUID)",
      required: true,
    },
    user_id: {
      type: "string",
      description: "User ID (UUID) of the member whose role to change",
      required: true,
    },
    role: {
      type: "string",
      description: "New role for the member",
      required: true,
      enum: ["member", "admin"],
    },
  },
  execute: async (args) => {
    try {
      const teamId = validateUuid(String(args.team_id ?? ""), "team_id");
      const userId = validateUuid(String(args.user_id ?? ""), "user_id");
      const role = String(args.role ?? "").trim();

      if (role !== "member" && role !== "admin") {
        return "Error: role must be 'member' or 'admin'.";
      }

      const data = await apiPatch<{
        userId: string;
        role: string;
        teamId: string;
      }>(`/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, {
        role,
      });

      return [
        "Team Member Role Updated",
        "",
        `Team ID: ${data.teamId ?? teamId}`,
        `User ID: ${data.userId ?? userId}`,
        `New Role: ${data.role ?? role}`,
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// ---------------------------------------------------------------------------
// Plugin export — the tools array that OpenClaw discovers
// ---------------------------------------------------------------------------

export const tools: ToolDefinition[] = [
  proxiedFetchTool,
  checkBalanceTool,
  checkUsageTool,
  getProxyConfigTool,
  listSessionsTool,
  createAgenticWalletTool,
  fundAgenticWalletTool,
  checkAgenticBalanceTool,
  listAgenticWalletsTool,
  agenticTransactionsTool,
  freezeAgenticWalletTool,
  unfreezeAgenticWalletTool,
  deleteAgenticWalletTool,
  createTeamTool,
  listTeamsTool,
  teamDetailsTool,
  teamFundTool,
  teamCreateKeyTool,
  teamUsageTool,
  updateTeamTool,
  updateTeamMemberRoleTool,
];

/**
 * Plugin metadata for OpenClaw discovery.
 */
export const plugin = {
  name: "dominusnode-proxy",
  version: "1.0.0",
  description:
    "Route web requests through DomiNode's rotating proxy network with geo-targeting, " +
    "balance management, agentic wallets, and team collaboration.",
  tools,
};

export default plugin;

// Test exports — used by plugin.test.ts
export {
  isPrivateIp,
  validateTargetUrl,
  validateCountry,
  validateUuid,
  normalizeIpv4,
  stripDangerousKeys,
  scrubCredentials,
  truncate,
  formatBytes,
  formatCents,
};
