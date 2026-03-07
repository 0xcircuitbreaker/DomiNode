/**
 * Dominus Node OpenClaw Plugin
 *
 * Implements 53 tools for interacting with Dominus Node's rotating proxy service
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

/** Valid domain name pattern (e.g. example.com, sub.example.co.uk). */
const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const key = process.env.DOMINUSNODE_API_KEY;
  if (!key || typeof key !== "string" || key.trim().length === 0) {
    throw new Error(
      "DOMINUSNODE_API_KEY environment variable is required. " +
        'Set it to your Dominus Node API key (starts with "dn_live_" or "dn_test_").',
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

function getAgentSecret(): string | undefined {
  return process.env.DOMINUSNODE_AGENT_SECRET || undefined;
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
let cachedApiKeyPrefix: string | null = null;

async function ensureAuth(apiKey: string, baseUrl: string): Promise<string> {
  const keyPrefix = apiKey.slice(0, 16);
  if (cachedJwt && Date.now() < jwtExpiresAt && cachedApiKeyPrefix === keyPrefix) return cachedJwt;
  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "dominusnode-openclaw-plugin/1.0.0",
  };
  const agentSecret = getAgentSecret();
  if (agentSecret) {
    authHeaders["X-DominusNode-Agent"] = "mcp";
    authHeaders["X-DominusNode-Agent-Secret"] = agentSecret;
  }
  const res = await fetch(`${baseUrl}/api/auth/verify-key`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ apiKey }),
    redirect: "error",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Auth failed (${res.status}): ${scrubCredentials(text.slice(0, 500))}`);
  }
  const data = await res.json() as { token: string };
  cachedApiKeyPrefix = keyPrefix;
  cachedJwt = data.token;
  // JWT expires in 15 min, refresh at 14 min for safety
  jwtExpiresAt = Date.now() + 14 * 60 * 1000;
  return cachedJwt;
}

// ---------------------------------------------------------------------------
// HTTP client for Dominus Node API
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
  const agentSecret = getAgentSecret();
  if (agentSecret) {
    headers["X-DominusNode-Agent"] = "mcp";
    headers["X-DominusNode-Agent-Secret"] = agentSecret;
  }

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

async function apiPut<T = unknown>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  return apiRequest<T>("PUT", path, body);
}

/**
 * Make an unauthenticated API request (for register, login, verify-email).
 * Does NOT call ensureAuth(). Includes agent headers if available.
 */
async function unauthenticatedRequest<T = unknown>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;

  const headers: Record<string, string> = {
    "Accept": "application/json",
    "User-Agent": "dominusnode-openclaw-plugin/1.0.0",
  };
  const agentSecret = getAgentSecret();
  if (agentSecret) {
    headers["X-DominusNode-Agent"] = "mcp";
    headers["X-DominusNode-Agent-Secret"] = agentSecret;
  }

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
    "Fetch a URL through Dominus Node's rotating proxy network. Supports geo-targeting " +
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
          const connectHost = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
          const connectReq = http.request({
            hostname: proxyHost, port: proxyPort, method: "CONNECT",
            path: `${connectHost}:${parsed.port || 443}`,
            headers: { "Proxy-Authorization": proxyAuth, Host: `${connectHost}:${parsed.port || 443}` },
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
    "Check your Dominus Node wallet balance and estimated remaining bandwidth at current pricing.",
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
        "Dominus Node Proxy Configuration",
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
    daily_limit_cents: {
      type: "number",
      description: "Optional daily spending budget in cents, resets midnight UTC (1-1000000)",
      required: false,
    },
    allowed_domains: {
      type: "array",
      description: "Optional domain allowlist for proxy requests (max 100, each <= 253 chars, e.g. ['example.com'])",
      required: false,
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

      const body: Record<string, unknown> = {
        label,
        spendingLimitCents,
      };

      // Validate optional daily_limit_cents
      if (args.daily_limit_cents !== undefined && args.daily_limit_cents !== null) {
        const dailyLimit = Number(args.daily_limit_cents);
        if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000000) {
          return "Error: daily_limit_cents must be a positive integer between 1 and 1000000.";
        }
        body.dailyLimitCents = dailyLimit;
      }

      // Validate optional allowed_domains
      if (args.allowed_domains !== undefined && args.allowed_domains !== null) {
        if (!Array.isArray(args.allowed_domains)) {
          return "Error: allowed_domains must be an array of domain strings.";
        }
        if (args.allowed_domains.length > 100) {
          return "Error: allowed_domains must have at most 100 entries.";
        }
        for (let i = 0; i < args.allowed_domains.length; i++) {
          const d = args.allowed_domains[i];
          if (typeof d !== "string") {
            return `Error: allowed_domains[${i}] must be a string.`;
          }
          if (d.length > 253) {
            return `Error: allowed_domains[${i}] exceeds 253 characters.`;
          }
          if (!DOMAIN_RE.test(d)) {
            return `Error: allowed_domains[${i}] is not a valid domain: ${d}`;
          }
        }
        body.allowedDomains = args.allowed_domains;
      }

      const data = await apiPost<{
        id: string;
        label: string;
        balanceCents: number;
        spendingLimitCents: number;
        status: string;
        createdAt: string;
      }>("/api/agent-wallet", body);

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

// 21. topup_paypal
const topupPaypalTool: ToolDefinition = {
  name: "topup_paypal",
  description:
    "Top up your Dominus Node wallet balance via PayPal. Creates a PayPal order and returns an " +
    "approval URL to complete payment. Minimum $5 (500 cents), maximum $1,000 (100000 cents).",
  parameters: {
    amount_cents: {
      type: "number",
      description: "Amount in cents to top up (min 500 = $5, max 100000 = $1,000)",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const amountCents = Number(args.amount_cents ?? 0);
      if (!Number.isInteger(amountCents) || amountCents < 500 || amountCents > 100000) {
        return "Error: amount_cents must be an integer between 500 ($5) and 100000 ($1,000).";
      }

      const data = await apiPost<{
        orderId: string;
        approvalUrl: string;
        amountCents: number;
      }>("/api/wallet/topup/paypal", { amountCents });

      return [
        "PayPal Top-Up Order Created",
        "",
        `Order ID: ${data.orderId}`,
        `Amount: ${formatCents(data.amountCents)}`,
        `Approval URL: ${data.approvalUrl}`,
        "",
        "Open the approval URL in a browser to complete payment.",
        "Once approved, the funds will be credited to your wallet automatically.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 22. topup_stripe
const topupStripeTool: ToolDefinition = {
  name: "topup_stripe",
  description:
    "Top up your Dominus Node wallet balance via Stripe. Creates a Stripe checkout session and returns " +
    "a checkout URL to complete payment. Minimum $5 (500 cents), maximum $1,000 (100000 cents).",
  parameters: {
    amount_cents: {
      type: "number",
      description: "Amount in cents to top up (min 500 = $5, max 100000 = $1,000)",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const amountCents = Number(args.amount_cents ?? 0);
      if (!Number.isInteger(amountCents) || amountCents < 500 || amountCents > 100000) {
        return "Error: amount_cents must be an integer between 500 ($5) and 100000 ($1,000).";
      }

      const data = await apiPost<{
        sessionId: string;
        url: string;
      }>("/api/wallet/topup/stripe", { amountCents });

      return [
        "Stripe Checkout Session Created",
        "",
        `Session ID: ${data.sessionId}`,
        `Amount: ${formatCents(amountCents)}`,
        `Checkout URL: ${data.url}`,
        "",
        "Open the checkout URL in a browser to complete payment.",
        "Once paid, the funds will be credited to your wallet automatically.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 23. topup_crypto
const VALID_CRYPTO_CURRENCIES = new Set([
  "BTC", "ETH", "LTC", "XMR", "ZEC", "USDC", "SOL", "USDT", "DAI", "BNB", "LINK",
]);

const topupCryptoTool: ToolDefinition = {
  name: "topup_crypto",
  description:
    "Top up your Dominus Node wallet balance via cryptocurrency. Creates a crypto payment invoice " +
    "and returns payment details. Minimum $5, maximum $1,000. " +
    "Supported currencies: BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK.",
  parameters: {
    amount_usd: {
      type: "number",
      description: "Amount in USD to top up (min 5, max 1000)",
      required: true,
    },
    currency: {
      type: "string",
      description: "Cryptocurrency to pay with",
      required: true,
      enum: ["BTC", "ETH", "LTC", "XMR", "ZEC", "USDC", "SOL", "USDT", "DAI", "BNB", "LINK"],
    },
  },
  execute: async (args) => {
    try {
      const amountUsd = Number(args.amount_usd ?? 0);
      if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || amountUsd < 5 || amountUsd > 1000) {
        return "Error: amount_usd must be a number between 5 and 1000.";
      }

      const currency = String(args.currency ?? "").toUpperCase();
      if (!VALID_CRYPTO_CURRENCIES.has(currency)) {
        return `Error: currency must be one of: ${[...VALID_CRYPTO_CURRENCIES].join(", ")}.`;
      }

      const data = await apiPost<{
        invoiceId: string;
        invoiceUrl: string;
        payCurrency: string;
        priceAmount: number;
      }>("/api/wallet/topup/crypto", { amountUsd, currency: currency.toLowerCase() });

      return [
        "Crypto Payment Invoice Created",
        "",
        `Invoice ID: ${data.invoiceId}`,
        `Amount: $${amountUsd}`,
        `Pay: ${data.priceAmount} ${data.payCurrency?.toUpperCase() ?? currency}`,
        `Payment URL: ${data.invoiceUrl}`,
        "",
        "Open the payment URL to complete payment.",
        "Once confirmed on-chain, the funds will be credited to your wallet.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 24. x402_info
const x402InfoTool: ToolDefinition = {
  name: "x402_info",
  description:
    "Get x402 micropayment protocol information including supported " +
    "facilitators, pricing, and payment options.",
  parameters: {},
  execute: async () => {
    try {
      const data = await apiGet<Record<string, unknown>>("/api/x402/info");
      return JSON.stringify(data, null, 2);
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 25. update_team_member_role
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

// 26. update_wallet_policy
const updateWalletPolicyTool: ToolDefinition = {
  name: "update_wallet_policy",
  description:
    "Update the policy of an agentic wallet. Sets or clears the daily budget cap " +
    "and/or domain allowlist. Pass null to clear a field. At least one field must be provided.",
  parameters: {
    wallet_id: {
      type: "string",
      description: "Agentic wallet ID (UUID)",
      required: true,
    },
    daily_limit_cents: {
      type: "number",
      description: "Daily spending budget in cents (1-1000000), or null to clear",
      required: false,
    },
    allowed_domains: {
      type: "array",
      description: "Domain allowlist (max 100 entries, each <= 253 chars), or null to clear",
      required: false,
    },
  },
  execute: async (args) => {
    try {
      const walletId = validateUuid(String(args.wallet_id ?? ""), "wallet_id");

      const body: Record<string, unknown> = {};

      if (args.daily_limit_cents !== undefined) {
        if (args.daily_limit_cents === null) {
          body.dailyLimitCents = null;
        } else {
          const dailyLimit = Number(args.daily_limit_cents);
          if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000000) {
            return "Error: daily_limit_cents must be a positive integer between 1 and 1000000, or null to clear.";
          }
          body.dailyLimitCents = dailyLimit;
        }
      }

      if (args.allowed_domains !== undefined) {
        if (args.allowed_domains === null) {
          body.allowedDomains = null;
        } else {
          if (!Array.isArray(args.allowed_domains)) {
            return "Error: allowed_domains must be an array of domain strings, or null to clear.";
          }
          if (args.allowed_domains.length > 100) {
            return "Error: allowed_domains must have at most 100 entries.";
          }
          for (let i = 0; i < args.allowed_domains.length; i++) {
            const d = args.allowed_domains[i];
            if (typeof d !== "string") {
              return `Error: allowed_domains[${i}] must be a string.`;
            }
            if (d.length > 253) {
              return `Error: allowed_domains[${i}] exceeds 253 characters.`;
            }
            if (!DOMAIN_RE.test(d)) {
              return `Error: allowed_domains[${i}] is not a valid domain: ${d}`;
            }
          }
          body.allowedDomains = args.allowed_domains;
        }
      }

      if (Object.keys(body).length === 0) {
        return "Error: At least one of daily_limit_cents or allowed_domains must be provided.";
      }

      const data = await apiPatch<{
        id: string;
        dailyLimitCents: number | null;
        allowedDomains: string[] | null;
      }>(`/api/agent-wallet/${encodeURIComponent(walletId)}/policy`, body);

      return [
        "Wallet Policy Updated",
        "",
        `Wallet ID: ${data.id}`,
        `Daily Limit: ${data.dailyLimitCents != null ? formatCents(data.dailyLimitCents) + "/day" : "None (unlimited)"}`,
        `Allowed Domains: ${data.allowedDomains != null && data.allowedDomains.length > 0 ? data.allowedDomains.join(", ") : "None (all domains)"}`,
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 27. get_proxy_status
const getProxyStatusTool: ToolDefinition = {
  name: "get_proxy_status",
  description:
    "Get the current status of the proxy gateway including uptime, active connections, and pool health.",
  parameters: {},
  execute: async () => {
    try {
      const data = await apiGet<{
        status: string;
        uptime: number;
        activeConnections: number;
        pools: Array<{
          name: string;
          healthy: boolean;
          activeIps: number;
        }>;
      }>("/api/proxy/status");

      const lines = [
        "Proxy Gateway Status",
        "",
        `Status: ${data.status ?? "unknown"}`,
        `Uptime: ${data.uptime != null ? `${Math.floor(data.uptime / 3600)}h ${Math.floor((data.uptime % 3600) / 60)}m` : "unknown"}`,
        `Active Connections: ${data.activeConnections ?? 0}`,
      ];

      const pools = data.pools ?? [];
      if (pools.length > 0) {
        lines.push("", "Pool Health:");
        for (const p of pools) {
          lines.push(`  ${p.name}: ${p.healthy ? "healthy" : "unhealthy"} (${p.activeIps} IPs)`);
        }
      }

      return lines.join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 28. get_transactions
const getTransactionsTool: ToolDefinition = {
  name: "get_transactions",
  description:
    "Get your main wallet transaction history including top-ups, usage charges, and refunds.",
  parameters: {
    limit: {
      type: "number",
      description: "Number of transactions to return (1-100, default 20)",
      required: false,
      default: 20,
    },
  },
  execute: async (args) => {
    try {
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);

      const data = await apiGet<{
        transactions: Array<{
          id: string;
          type: string;
          amountCents: number;
          description: string;
          createdAt: string;
        }>;
      }>(`/api/wallet/transactions?limit=${limit}`);

      const txs = data.transactions ?? [];
      if (txs.length === 0) {
        return "No wallet transactions found.";
      }

      const lines = [`Wallet Transactions (${txs.length})`, ""];
      for (const tx of txs) {
        const sign = tx.type === "topup" || tx.type === "refund" || tx.type === "fund" ? "+" : "-";
        lines.push(`  ${sign}${formatCents(Math.abs(tx.amountCents))} [${tx.type}] ${tx.description}`);
        lines.push(`    ${tx.createdAt}`);
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 29. get_forecast
const getForecastTool: ToolDefinition = {
  name: "get_forecast",
  description:
    "Get a spending forecast based on recent usage patterns. Shows projected balance depletion date and daily burn rate.",
  parameters: {},
  execute: async () => {
    try {
      const data = await apiGet<{
        currentBalanceCents: number;
        dailyBurnCents: number;
        estimatedDaysRemaining: number;
        projectedDepletionDate: string | null;
        avgDailyBytes: number;
      }>("/api/wallet/forecast");

      const lines = [
        "Spending Forecast",
        "",
        `Current Balance: ${formatCents(data.currentBalanceCents ?? 0)}`,
        `Daily Burn Rate: ${formatCents(data.dailyBurnCents ?? 0)}/day`,
        `Avg Daily Bandwidth: ${formatBytes(data.avgDailyBytes ?? 0)}`,
        `Estimated Days Remaining: ${data.estimatedDaysRemaining ?? "N/A"}`,
        `Projected Depletion: ${data.projectedDepletionDate ?? "N/A"}`,
        "",
        "Use topup_stripe, topup_paypal, or topup_crypto to add funds.",
      ];

      return lines.join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 30. check_payment
const checkPaymentTool: ToolDefinition = {
  name: "check_payment",
  description:
    "Check the status of a crypto payment invoice. Use the invoice ID returned by topup_crypto.",
  parameters: {
    invoice_id: {
      type: "string",
      description: "Crypto invoice ID to check",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const invoiceId = String(args.invoice_id ?? "").trim();
      if (!invoiceId || invoiceId.length === 0 || invoiceId.length > 200) {
        return "Error: invoice_id is required (max 200 characters).";
      }
      if (/[\x00-\x1f\x7f]/.test(invoiceId)) {
        return "Error: invoice_id contains invalid control characters.";
      }

      const data = await apiGet<{
        invoiceId: string;
        status: string;
        amountUsd: number;
        payCurrency: string;
        paidAmount: number | null;
        createdAt: string;
        updatedAt: string;
      }>(`/api/wallet/topup/crypto/${encodeURIComponent(invoiceId)}/status`);

      const lines = [
        "Crypto Payment Status",
        "",
        `Invoice ID: ${data.invoiceId ?? invoiceId}`,
        `Status: ${data.status}`,
        `Amount: $${data.amountUsd}`,
        `Currency: ${data.payCurrency?.toUpperCase() ?? "N/A"}`,
      ];

      if (data.paidAmount != null) {
        lines.push(`Paid: ${data.paidAmount} ${data.payCurrency?.toUpperCase() ?? ""}`);
      }

      lines.push(`Created: ${data.createdAt}`, `Updated: ${data.updatedAt}`);

      return lines.join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 31. get_daily_usage
const getDailyUsageTool: ToolDefinition = {
  name: "get_daily_usage",
  description:
    "Get daily bandwidth usage breakdown for the specified number of days. Shows per-day bytes, cost, and request count.",
  parameters: {
    days: {
      type: "number",
      description: "Number of days to look back (1-90, default 7)",
      required: false,
      default: 7,
    },
  },
  execute: async (args) => {
    try {
      const days = Math.min(Math.max(Number(args.days ?? 7), 1), 90);

      const data = await apiGet<{
        daily: Array<{
          date: string;
          totalBytes: number;
          totalCostCents: number;
          requestCount: number;
        }>;
      }>(`/api/usage/daily?days=${days}`);

      const daily = data.daily ?? [];
      if (daily.length === 0) {
        return `No daily usage data found for the last ${days} days.`;
      }

      const lines = [`Daily Usage (last ${days} days)`, ""];
      for (const d of daily) {
        lines.push(`  ${d.date}: ${formatBytes(d.totalBytes)} | ${formatCents(d.totalCostCents)} | ${d.requestCount} reqs`);
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 32. get_top_hosts
const getTopHostsTool: ToolDefinition = {
  name: "get_top_hosts",
  description:
    "Get the top hosts by bandwidth usage. Shows which domains consume the most proxy bandwidth.",
  parameters: {
    limit: {
      type: "number",
      description: "Number of top hosts to return (1-100, default 10)",
      required: false,
      default: 10,
    },
  },
  execute: async (args) => {
    try {
      const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 100);

      const data = await apiGet<{
        hosts: Array<{
          host: string;
          totalBytes: number;
          requestCount: number;
          lastSeen: string;
        }>;
      }>(`/api/usage/top-hosts?limit=${limit}`);

      const hosts = data.hosts ?? [];
      if (hosts.length === 0) {
        return "No host usage data found.";
      }

      const lines = [`Top Hosts by Bandwidth (${hosts.length})`, ""];
      for (let i = 0; i < hosts.length; i++) {
        const h = hosts[i];
        lines.push(`  ${i + 1}. ${h.host}: ${formatBytes(h.totalBytes)} | ${h.requestCount} reqs | Last: ${h.lastSeen}`);
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 33. register
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const registerTool: ToolDefinition = {
  name: "register",
  description:
    "Register a new Dominus Node account. Returns user info and instructions for email verification. " +
    "This is an unauthenticated endpoint -- no API key required.",
  parameters: {
    email: {
      type: "string",
      description: "Email address for the new account",
      required: true,
    },
    password: {
      type: "string",
      description: "Password for the new account (8-128 characters)",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const email = String(args.email ?? "").trim();
      if (!email || !EMAIL_RE.test(email)) {
        return "Error: A valid email address is required.";
      }
      if (email.length > 254) {
        return "Error: Email address is too long (max 254 characters).";
      }

      const password = String(args.password ?? "");
      if (password.length < 8 || password.length > 128) {
        return "Error: Password must be 8-128 characters.";
      }

      const data = await unauthenticatedRequest<{
        id: string;
        email: string;
        emailVerified: boolean;
        createdAt: string;
      }>("POST", "/api/auth/register", { email, password });

      return [
        "Account Registered",
        "",
        `User ID: ${data.id}`,
        `Email: ${data.email}`,
        `Email Verified: ${data.emailVerified ? "Yes" : "No"}`,
        `Created: ${data.createdAt}`,
        "",
        "Next steps:",
        "  1. Check your email for a verification code",
        "  2. Use verify_email to verify your email address",
        "  3. Set DOMINUSNODE_API_KEY to start using the proxy",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 34. login
const loginTool: ToolDefinition = {
  name: "login",
  description:
    "Log in to a Dominus Node account and receive access/refresh tokens. " +
    "This is an unauthenticated endpoint -- no API key required.",
  parameters: {
    email: {
      type: "string",
      description: "Account email address",
      required: true,
    },
    password: {
      type: "string",
      description: "Account password (8-128 characters)",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const email = String(args.email ?? "").trim();
      if (!email || !EMAIL_RE.test(email)) {
        return "Error: A valid email address is required.";
      }
      if (email.length > 254) {
        return "Error: Email address is too long (max 254 characters).";
      }

      const password = String(args.password ?? "");
      if (password.length < 8 || password.length > 128) {
        return "Error: Password must be 8-128 characters.";
      }

      const data = await unauthenticatedRequest<{
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        mfaRequired?: boolean;
      }>("POST", "/api/auth/login", { email, password });

      if (data.mfaRequired) {
        return [
          "MFA Required",
          "",
          "This account has multi-factor authentication enabled.",
          "Please complete MFA verification to continue.",
        ].join("\n");
      }

      return [
        "Login Successful",
        "",
        `Access Token: ${scrubCredentials(data.accessToken ?? "")}`,
        `Refresh Token: ${scrubCredentials(data.refreshToken ?? "")}`,
        `Expires In: ${data.expiresIn ?? 900} seconds`,
        "",
        "Use these tokens for authenticated API requests.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 35. get_account_info
const getAccountInfoTool: ToolDefinition = {
  name: "get_account_info",
  description:
    "Get your Dominus Node account information including email, plan, verification status, and creation date.",
  parameters: {},
  execute: async () => {
    try {
      const data = await apiGet<{
        id: string;
        email: string;
        emailVerified: boolean;
        plan: string;
        status: string;
        createdAt: string;
        mfaEnabled?: boolean;
      }>("/api/auth/me");

      return [
        "Account Info",
        "",
        `User ID: ${data.id}`,
        `Email: ${data.email}`,
        `Email Verified: ${data.emailVerified ? "Yes" : "No"}`,
        `Plan: ${data.plan}`,
        `Status: ${data.status}`,
        `MFA Enabled: ${data.mfaEnabled ? "Yes" : "No"}`,
        `Created: ${data.createdAt}`,
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 36. verify_email
const verifyEmailTool: ToolDefinition = {
  name: "verify_email",
  description:
    "Verify your email address using the code sent during registration. " +
    "This is an unauthenticated endpoint -- no API key required.",
  parameters: {
    email: {
      type: "string",
      description: "Email address to verify",
      required: true,
    },
    code: {
      type: "string",
      description: "Verification code from email",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const email = String(args.email ?? "").trim();
      if (!email || !EMAIL_RE.test(email)) {
        return "Error: A valid email address is required.";
      }
      if (email.length > 254) {
        return "Error: Email address is too long (max 254 characters).";
      }

      const code = String(args.code ?? "").trim();
      if (!code || code.length === 0 || code.length > 100) {
        return "Error: Verification code is required (max 100 characters).";
      }
      if (/[\x00-\x1f\x7f]/.test(code)) {
        return "Error: Verification code contains invalid control characters.";
      }

      await unauthenticatedRequest("POST", "/api/auth/verify-email", { email, code });

      return [
        "Email Verified Successfully",
        "",
        `Email: ${email}`,
        "",
        "Your account is now fully activated. You can start using the proxy.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 37. resend_verification
const resendVerificationTool: ToolDefinition = {
  name: "resend_verification",
  description:
    "Resend the email verification code. Requires authentication.",
  parameters: {},
  execute: async () => {
    try {
      await apiPost("/api/auth/resend-verification");

      return [
        "Verification Email Resent",
        "",
        "A new verification code has been sent to your registered email address.",
        "Use verify_email with the new code to complete verification.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 38. update_password
const updatePasswordTool: ToolDefinition = {
  name: "update_password",
  description:
    "Change your account password. Requires your current password for verification.",
  parameters: {
    current_password: {
      type: "string",
      description: "Your current password (8-128 characters)",
      required: true,
    },
    new_password: {
      type: "string",
      description: "Your new password (8-128 characters)",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const currentPassword = String(args.current_password ?? "");
      if (currentPassword.length < 8 || currentPassword.length > 128) {
        return "Error: Current password must be 8-128 characters.";
      }

      const newPassword = String(args.new_password ?? "");
      if (newPassword.length < 8 || newPassword.length > 128) {
        return "Error: New password must be 8-128 characters.";
      }

      await apiPost("/api/auth/change-password", {
        currentPassword,
        newPassword,
      });

      return [
        "Password Updated Successfully",
        "",
        "Your password has been changed.",
        "All existing sessions remain valid.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 39. list_keys
const listKeysTool: ToolDefinition = {
  name: "list_keys",
  description:
    "List all your personal API keys. Shows key prefix, label, status, and creation date.",
  parameters: {},
  execute: async () => {
    try {
      const data = await apiGet<{
        keys: Array<{
          id: string;
          prefix: string;
          label: string;
          status: string;
          createdAt: string;
          lastUsedAt: string | null;
        }>;
      }>("/api/keys");

      const keys = data.keys ?? [];
      if (keys.length === 0) {
        return "No API keys found. Use create_key to create one.";
      }

      const lines = [`API Keys (${keys.length})`, ""];
      for (const k of keys) {
        const lastUsed = k.lastUsedAt ? ` | Last used: ${k.lastUsedAt}` : "";
        lines.push(`  ${k.prefix}... | ${k.label} | ${k.status}${lastUsed}`);
        lines.push(`    ID: ${k.id} | Created: ${k.createdAt}`);
        lines.push("");
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 40. create_key
const createKeyTool: ToolDefinition = {
  name: "create_key",
  description:
    "Create a new personal API key. The full key is shown only once -- save it immediately.",
  parameters: {
    label: {
      type: "string",
      description: 'Label for the API key (e.g., "production", "dev")',
      required: true,
    },
  },
  execute: async (args) => {
    try {
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
      }>("/api/keys", { label });

      return [
        "API Key Created",
        "",
        `Key ID: ${data.id}`,
        `API Key: ${data.key}`,
        `Prefix: ${data.prefix}`,
        `Label: ${data.label}`,
        `Created: ${data.createdAt}`,
        "",
        "IMPORTANT: Save this API key now -- it will not be shown again.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 41. revoke_key
const revokeKeyTool: ToolDefinition = {
  name: "revoke_key",
  description:
    "Revoke (delete) a personal API key. This immediately invalidates the key.",
  parameters: {
    key_id: {
      type: "string",
      description: "API key ID (UUID) to revoke",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const keyId = validateUuid(String(args.key_id ?? ""), "key_id");

      await apiDelete(`/api/keys/${encodeURIComponent(keyId)}`);

      return [
        "API Key Revoked",
        "",
        `Key ID: ${keyId}`,
        "",
        "The key has been permanently revoked and can no longer be used.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 42. get_plan
const getPlanTool: ToolDefinition = {
  name: "get_plan",
  description:
    "Get your current plan details including limits, pricing, and features.",
  parameters: {},
  execute: async () => {
    try {
      const data = await apiGet<{
        plan: string;
        displayName: string;
        bandwidthLimitBytes: number | null;
        requestsPerMinute: number;
        maxApiKeys: number;
        maxAgenticWallets: number;
        maxTeams: number;
        features: string[];
      }>("/api/plans/user/plan");

      const lines = [
        "Current Plan",
        "",
        `Plan: ${data.displayName ?? data.plan}`,
        `Bandwidth Limit: ${data.bandwidthLimitBytes != null ? formatBytes(data.bandwidthLimitBytes) : "Unlimited"}`,
        `Rate Limit: ${data.requestsPerMinute} req/min`,
        `Max API Keys: ${data.maxApiKeys}`,
        `Max Agentic Wallets: ${data.maxAgenticWallets}`,
        `Max Teams: ${data.maxTeams}`,
      ];

      const features = data.features ?? [];
      if (features.length > 0) {
        lines.push("", "Features:");
        for (const f of features) {
          lines.push(`  - ${f}`);
        }
      }

      lines.push("", "Use list_plans to see available plan options.");

      return lines.join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 43. list_plans
const listPlansTool: ToolDefinition = {
  name: "list_plans",
  description:
    "List all available plans with pricing, limits, and features.",
  parameters: {},
  execute: async () => {
    try {
      const data = await apiGet<{
        plans: Array<{
          id: string;
          name: string;
          displayName: string;
          priceMonthly: number;
          bandwidthLimitBytes: number | null;
          requestsPerMinute: number;
          maxApiKeys: number;
          features: string[];
        }>;
      }>("/api/plans");

      const plans = data.plans ?? [];
      if (plans.length === 0) {
        return "No plans available.";
      }

      const lines = [`Available Plans (${plans.length})`, ""];
      for (const p of plans) {
        lines.push(`  ${p.displayName ?? p.name} ($${(p.priceMonthly / 100).toFixed(2)}/mo)`);
        lines.push(`    Bandwidth: ${p.bandwidthLimitBytes != null ? formatBytes(p.bandwidthLimitBytes) : "Unlimited"} | Rate: ${p.requestsPerMinute} req/min | Keys: ${p.maxApiKeys}`);
        if (p.features && p.features.length > 0) {
          lines.push(`    Features: ${p.features.join(", ")}`);
        }
        lines.push("");
      }

      lines.push("Use change_plan to switch plans.");

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 44. change_plan
const changePlanTool: ToolDefinition = {
  name: "change_plan",
  description:
    "Change your account plan. Use list_plans to see available options first.",
  parameters: {
    plan: {
      type: "string",
      description: "Plan name/ID to switch to",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const plan = String(args.plan ?? "").trim();
      if (!plan || plan.length === 0 || plan.length > 100) {
        return "Error: plan is required and must be 1-100 characters.";
      }
      if (/[\x00-\x1f\x7f]/.test(plan)) {
        return "Error: plan name contains invalid control characters.";
      }

      const data = await apiPut<{
        plan: string;
        displayName: string;
        effectiveAt: string;
      }>("/api/plans/user/plan", { plan });

      return [
        "Plan Changed Successfully",
        "",
        `New Plan: ${data.displayName ?? data.plan}`,
        `Effective: ${data.effectiveAt ?? "immediately"}`,
        "",
        "Use get_plan to view your updated plan details.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 45. team_delete
const teamDeleteTool: ToolDefinition = {
  name: "team_delete",
  description:
    "Delete a team. Only the team owner can delete a team. Any remaining team balance is refunded.",
  parameters: {
    team_id: {
      type: "string",
      description: "Team ID (UUID) to delete",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const teamId = validateUuid(String(args.team_id ?? ""), "team_id");

      await apiDelete(`/api/teams/${encodeURIComponent(teamId)}`);

      return [
        "Team Deleted",
        "",
        `Team ID: ${teamId}`,
        "",
        "The team has been permanently deleted.",
        "Any remaining balance has been refunded to the owner's wallet.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 46. team_revoke_key
const teamRevokeKeyTool: ToolDefinition = {
  name: "team_revoke_key",
  description:
    "Revoke a shared API key for a team. Only owners and admins can revoke keys.",
  parameters: {
    team_id: {
      type: "string",
      description: "Team ID (UUID)",
      required: true,
    },
    key_id: {
      type: "string",
      description: "API key ID (UUID) to revoke",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const teamId = validateUuid(String(args.team_id ?? ""), "team_id");
      const keyId = validateUuid(String(args.key_id ?? ""), "key_id");

      await apiDelete(`/api/teams/${encodeURIComponent(teamId)}/keys/${encodeURIComponent(keyId)}`);

      return [
        "Team API Key Revoked",
        "",
        `Team ID: ${teamId}`,
        `Key ID: ${keyId}`,
        "",
        "The key has been permanently revoked and can no longer be used.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 47. team_list_keys
const teamListKeysTool: ToolDefinition = {
  name: "team_list_keys",
  description:
    "List all API keys for a team. Shows key prefix, label, status, and creation date.",
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
        keys: Array<{
          id: string;
          prefix: string;
          label: string;
          status: string;
          createdAt: string;
          lastUsedAt: string | null;
        }>;
      }>(`/api/teams/${encodeURIComponent(teamId)}/keys`);

      const keys = data.keys ?? [];
      if (keys.length === 0) {
        return "No API keys found for this team. Use team_create_key to create one.";
      }

      const lines = [`Team API Keys (${keys.length})`, ""];
      for (const k of keys) {
        const lastUsed = k.lastUsedAt ? ` | Last used: ${k.lastUsedAt}` : "";
        lines.push(`  ${k.prefix}... | ${k.label} | ${k.status}${lastUsed}`);
        lines.push(`    ID: ${k.id} | Created: ${k.createdAt}`);
        lines.push("");
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 48. team_list_members
const teamListMembersTool: ToolDefinition = {
  name: "team_list_members",
  description:
    "List all members of a team with their roles and join dates.",
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
        members: Array<{
          userId: string;
          email: string;
          role: string;
          joinedAt: string;
        }>;
      }>(`/api/teams/${encodeURIComponent(teamId)}/members`);

      const members = data.members ?? [];
      if (members.length === 0) {
        return "No members found in this team.";
      }

      const lines = [`Team Members (${members.length})`, ""];
      for (const m of members) {
        lines.push(`  ${m.email} | ${m.role} | Joined: ${m.joinedAt}`);
        lines.push(`    User ID: ${m.userId}`);
        lines.push("");
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 49. team_add_member
const teamAddMemberTool: ToolDefinition = {
  name: "team_add_member",
  description:
    "Add a member directly to a team by user ID. Only owners and admins can add members.",
  parameters: {
    team_id: {
      type: "string",
      description: "Team ID (UUID)",
      required: true,
    },
    user_id: {
      type: "string",
      description: "User ID (UUID) of the person to add",
      required: true,
    },
    role: {
      type: "string",
      description: "Role for the new member",
      required: false,
      enum: ["member", "admin"],
      default: "member",
    },
  },
  execute: async (args) => {
    try {
      const teamId = validateUuid(String(args.team_id ?? ""), "team_id");
      const userId = validateUuid(String(args.user_id ?? ""), "user_id");
      const role = String(args.role ?? "member").trim();

      if (role !== "member" && role !== "admin") {
        return "Error: role must be 'member' or 'admin'.";
      }

      const data = await apiPost<{
        userId: string;
        teamId: string;
        role: string;
        joinedAt: string;
      }>(`/api/teams/${encodeURIComponent(teamId)}/members`, {
        userId,
        role,
      });

      return [
        "Team Member Added",
        "",
        `Team ID: ${data.teamId ?? teamId}`,
        `User ID: ${data.userId ?? userId}`,
        `Role: ${data.role ?? role}`,
        `Joined: ${data.joinedAt ?? "now"}`,
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 50. team_remove_member
const teamRemoveMemberTool: ToolDefinition = {
  name: "team_remove_member",
  description:
    "Remove a member from a team. Only owners and admins can remove members.",
  parameters: {
    team_id: {
      type: "string",
      description: "Team ID (UUID)",
      required: true,
    },
    user_id: {
      type: "string",
      description: "User ID (UUID) of the member to remove",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const teamId = validateUuid(String(args.team_id ?? ""), "team_id");
      const userId = validateUuid(String(args.user_id ?? ""), "user_id");

      await apiDelete(`/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`);

      return [
        "Team Member Removed",
        "",
        `Team ID: ${teamId}`,
        `User ID: ${userId}`,
        "",
        "The member has been removed from the team.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 51. team_invite_member
const teamInviteMemberTool: ToolDefinition = {
  name: "team_invite_member",
  description:
    "Send an invitation to join a team by email. The invitee receives an email with a link to accept.",
  parameters: {
    team_id: {
      type: "string",
      description: "Team ID (UUID)",
      required: true,
    },
    email: {
      type: "string",
      description: "Email address of the person to invite",
      required: true,
    },
    role: {
      type: "string",
      description: "Role for the invited member",
      required: false,
      enum: ["member", "admin"],
      default: "member",
    },
  },
  execute: async (args) => {
    try {
      const teamId = validateUuid(String(args.team_id ?? ""), "team_id");
      const email = String(args.email ?? "").trim();
      if (!email || !EMAIL_RE.test(email)) {
        return "Error: A valid email address is required.";
      }
      if (email.length > 254) {
        return "Error: Email address is too long (max 254 characters).";
      }

      const role = String(args.role ?? "member").trim();
      if (role !== "member" && role !== "admin") {
        return "Error: role must be 'member' or 'admin'.";
      }

      const data = await apiPost<{
        id: string;
        teamId: string;
        email: string;
        role: string;
        status: string;
        expiresAt: string;
        createdAt: string;
      }>(`/api/teams/${encodeURIComponent(teamId)}/invites`, {
        email,
        role,
      });

      return [
        "Team Invitation Sent",
        "",
        `Invite ID: ${data.id}`,
        `Team ID: ${data.teamId ?? teamId}`,
        `Email: ${data.email ?? email}`,
        `Role: ${data.role ?? role}`,
        `Status: ${data.status ?? "pending"}`,
        `Expires: ${data.expiresAt}`,
        "",
        "The invitee will receive an email with instructions to accept.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 52. team_list_invites
const teamListInvitesTool: ToolDefinition = {
  name: "team_list_invites",
  description:
    "List all pending invitations for a team.",
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
        invites: Array<{
          id: string;
          email: string;
          role: string;
          status: string;
          expiresAt: string;
          createdAt: string;
        }>;
      }>(`/api/teams/${encodeURIComponent(teamId)}/invites`);

      const invites = data.invites ?? [];
      if (invites.length === 0) {
        return "No pending invitations for this team.";
      }

      const lines = [`Team Invitations (${invites.length})`, ""];
      for (const inv of invites) {
        lines.push(`  ${inv.email} | ${inv.role} | ${inv.status}`);
        lines.push(`    ID: ${inv.id} | Expires: ${inv.expiresAt}`);
        lines.push("");
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  },
};

// 53. team_cancel_invite
const teamCancelInviteTool: ToolDefinition = {
  name: "team_cancel_invite",
  description:
    "Cancel a pending team invitation. Only owners and admins can cancel invites.",
  parameters: {
    team_id: {
      type: "string",
      description: "Team ID (UUID)",
      required: true,
    },
    invite_id: {
      type: "string",
      description: "Invite ID (UUID) to cancel",
      required: true,
    },
  },
  execute: async (args) => {
    try {
      const teamId = validateUuid(String(args.team_id ?? ""), "team_id");
      const inviteId = validateUuid(String(args.invite_id ?? ""), "invite_id");

      await apiDelete(`/api/teams/${encodeURIComponent(teamId)}/invites/${encodeURIComponent(inviteId)}`);

      return [
        "Team Invitation Cancelled",
        "",
        `Team ID: ${teamId}`,
        `Invite ID: ${inviteId}`,
        "",
        "The invitation has been cancelled.",
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
  // Proxy (3)
  proxiedFetchTool,
  getProxyConfigTool,
  getProxyStatusTool,
  // Sessions (1)
  listSessionsTool,
  // Wallet (8)
  checkBalanceTool,
  getTransactionsTool,
  getForecastTool,
  topupPaypalTool,
  topupStripeTool,
  topupCryptoTool,
  checkPaymentTool,
  x402InfoTool,
  // Usage (3)
  checkUsageTool,
  getDailyUsageTool,
  getTopHostsTool,
  // Account (6)
  registerTool,
  loginTool,
  getAccountInfoTool,
  verifyEmailTool,
  resendVerificationTool,
  updatePasswordTool,
  // API Keys (3)
  listKeysTool,
  createKeyTool,
  revokeKeyTool,
  // Plans (3)
  getPlanTool,
  listPlansTool,
  changePlanTool,
  // Agentic Wallets (9)
  createAgenticWalletTool,
  fundAgenticWalletTool,
  checkAgenticBalanceTool,
  listAgenticWalletsTool,
  agenticTransactionsTool,
  freezeAgenticWalletTool,
  unfreezeAgenticWalletTool,
  deleteAgenticWalletTool,
  updateWalletPolicyTool,
  // Teams (17)
  createTeamTool,
  listTeamsTool,
  teamDetailsTool,
  updateTeamTool,
  teamDeleteTool,
  teamFundTool,
  teamCreateKeyTool,
  teamRevokeKeyTool,
  teamListKeysTool,
  teamUsageTool,
  teamListMembersTool,
  teamAddMemberTool,
  teamRemoveMemberTool,
  updateTeamMemberRoleTool,
  teamInviteMemberTool,
  teamListInvitesTool,
  teamCancelInviteTool,
];

/**
 * Plugin metadata for OpenClaw discovery.
 */
export const plugin = {
  name: "dominusnode-proxy",
  version: "1.0.0",
  description:
    "Route web requests through Dominus Node's rotating proxy network with geo-targeting, " +
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
