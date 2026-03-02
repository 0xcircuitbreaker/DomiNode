/**
 * Dominus Node Mastra AI Toolkit
 *
 * Implements 24 tools for interacting with Dominus Node's rotating proxy service
 * from Mastra AI agents and workflows.
 *
 * Uses createTool() from @mastra/core/tools with Zod schemas.
 *
 * Security:
 *  - Full SSRF protection (private IP blocking, DNS rebinding, .localhost, embedded creds)
 *  - Credential scrubbing in error messages
 *  - Response truncation at 4000 chars for LLM context efficiency
 *  - OFAC sanctioned country validation
 *  - Prototype pollution prevention (recursive)
 *  - HTTP method restriction (GET/HEAD/OPTIONS only for proxied fetch)
 *  - 10 MB response cap, 30s timeout
 *  - Redirect following disabled
 */

// @ts-ignore -- available when installed in Mastra project
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import * as dns from "dns/promises";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_RESPONSE_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB hard cap

/** OFAC sanctioned countries -- must never be used as geo-targeting destinations. */
const SANCTIONED_COUNTRIES = new Set(["CU", "IR", "KP", "RU", "SY"]);

/** ISO 3166-1 alpha-2 country code pattern. */
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

/** UUID v4 pattern for wallet/team IDs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DominusNodeToolkitConfig {
  /** Dominus Node API key (dn_live_... or dn_test_...). Falls back to DOMINUSNODE_API_KEY env var. */
  apiKey?: string;
  /** Base URL of the Dominus Node REST API. */
  baseUrl?: string;
  /** Hostname of the Dominus Node proxy gateway. */
  proxyHost?: string;
  /** Port of the Dominus Node proxy gateway. */
  proxyPort?: number;
}

// ---------------------------------------------------------------------------
// Credential scrubbing
// ---------------------------------------------------------------------------

/** Remove any dn_live_* or dn_test_* tokens from error messages. */
export function scrubCredentials(msg: string): string {
  return msg.replace(/dn_(live|test)_[A-Za-z0-9_-]+/g, "dn_$1_***REDACTED***");
}

function safeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return scrubCredentials(raw);
}

// ---------------------------------------------------------------------------
// Response truncation
// ---------------------------------------------------------------------------

export function truncate(text: string, max: number = MAX_RESPONSE_CHARS): string {
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
export function normalizeIpv4(hostname: string): string | null {
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

export function isPrivateIp(hostname: string): boolean {
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

  // IPv4-compatible IPv6 (::x.x.x.x) -- deprecated but still parsed
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

  // Teredo (2001:0000::/32) -- block unconditionally
  if (ipLower.startsWith("2001:0000:") || ipLower.startsWith("2001:0:")) return true;

  // 6to4 (2002::/16) -- block unconditionally
  if (ipLower.startsWith("2002:")) return true;

  // IPv6 multicast (ff00::/8)
  if (ipLower.startsWith("ff")) return true;

  return false;
}

/**
 * Validate a URL for safety before proxying.
 * Blocks: private IPs, localhost, .local/.internal/.arpa, embedded credentials, non-http(s).
 */
export function validateTargetUrl(url: string): URL {
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
export function validateCountry(country: string | undefined): string | undefined {
  if (!country) return undefined;
  const upper = country.toUpperCase().trim();
  if (!upper) return undefined;
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
export function validateUuid(id: string, label: string): string {
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
 */
async function checkDnsRebinding(hostname: string): Promise<void> {
  const stripped = hostname.replace(/^\[|\]$/g, "");
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(stripped) || stripped.includes(":")) {
    return;
  }

  const resolvedIps: string[] = [];

  try {
    const ipv4s = await dns.resolve4(hostname);
    resolvedIps.push(...ipv4s);
  } catch {
    // NODATA or NXDOMAIN for A records is fine
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

export function stripDangerousKeys(obj: unknown, depth = 0): void {
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
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(3)} GB`;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// DominusNodeToolkit
// ---------------------------------------------------------------------------

export class DominusNodeToolkit {
  private apiKey: string;
  private baseUrl: string;
  private proxyHost: string;
  private proxyPort: number;
  private cachedJwt: string | null = null;
  private jwtExpiresAt = 0;

  constructor(config: DominusNodeToolkitConfig = {}) {
    this.apiKey = config.apiKey || process.env.DOMINUSNODE_API_KEY || "";
    this.baseUrl = (config.baseUrl || process.env.DOMINUSNODE_BASE_URL || "https://api.dominusnode.com").replace(/\/+$/, "");
    this.proxyHost = config.proxyHost || process.env.DOMINUSNODE_PROXY_HOST || "proxy.dominusnode.com";
    const portStr = config.proxyPort?.toString() || process.env.DOMINUSNODE_PROXY_PORT || "8080";
    const port = parseInt(portStr, 10);
    this.proxyPort = isNaN(port) || port < 1 || port > 65535 ? 8080 : port;
  }

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  private getApiKey(): string {
    if (!this.apiKey || typeof this.apiKey !== "string" || this.apiKey.trim().length === 0) {
      throw new Error(
        "DOMINUSNODE_API_KEY is required. " +
        'Set it to your Dominus Node API key (starts with "dn_live_" or "dn_test_").',
      );
    }
    const trimmed = this.apiKey.trim();
    if (!trimmed.startsWith("dn_live_") && !trimmed.startsWith("dn_test_")) {
      throw new Error('DOMINUSNODE_API_KEY must start with "dn_live_" or "dn_test_".');
    }
    return trimmed;
  }

  private async ensureAuth(): Promise<string> {
    if (this.cachedJwt && Date.now() < this.jwtExpiresAt) return this.cachedJwt;

    const apiKey = this.getApiKey();
    const res = await fetch(`${this.baseUrl}/api/auth/verify-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "dominusnode-mastra/1.0.0",
      },
      body: JSON.stringify({ apiKey }),
      redirect: "error",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Auth failed (${res.status}): ${scrubCredentials(text.slice(0, 500))}`);
    }

    const data = (await res.json()) as { token: string };
    this.cachedJwt = data.token;
    // JWT expires in 15 min, refresh at 14 min for safety
    this.jwtExpiresAt = Date.now() + 14 * 60 * 1000;
    return this.cachedJwt;
  }

  // -----------------------------------------------------------------------
  // HTTP client for Dominus Node API
  // -----------------------------------------------------------------------

  private async apiRequest<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const jwt = await this.ensureAuth();
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/json",
      "User-Agent": "dominusnode-mastra/1.0.0",
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

  private async apiGet<T = unknown>(path: string): Promise<T> {
    return this.apiRequest<T>("GET", path);
  }

  private async apiPost<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T> {
    return this.apiRequest<T>("POST", path, body);
  }

  private async apiDelete<T = unknown>(path: string): Promise<T> {
    return this.apiRequest<T>("DELETE", path);
  }

  private async apiPatch<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T> {
    return this.apiRequest<T>("PATCH", path, body);
  }

  // -----------------------------------------------------------------------
  // Tool implementations
  // -----------------------------------------------------------------------

  async proxiedFetch(
    url: string,
    method: string = "GET",
    country?: string,
    proxyType: string = "dc",
  ): Promise<{ status: number; headers: Record<string, string>; body: string; pool: string; country: string }> {
    const parsedUrl = validateTargetUrl(url);
    await checkDnsRebinding(parsedUrl.hostname);
    const validCountry = validateCountry(country);

    const ALLOWED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
    const methodUpper = method.toUpperCase();
    if (!ALLOWED_METHODS.has(methodUpper)) {
      throw new Error(`HTTP method "${methodUpper}" is not allowed. Only GET, HEAD, and OPTIONS are permitted.`);
    }

    const apiKey = this.getApiKey();
    const parts: string[] = [];
    if (proxyType && proxyType !== "auto") parts.push(proxyType);
    if (validCountry) parts.push(`country-${validCountry.toUpperCase()}`);
    const username = parts.length > 0 ? parts.join("-") : "auto";
    const proxyAuth = "Basic " + Buffer.from(`${username}:${apiKey}`).toString("base64");

    const parsed = new URL(url);
    const MAX_RESP = 1_048_576; // 1MB

    const result = await new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Proxy request timed out")), REQUEST_TIMEOUT_MS);

      if (parsed.protocol === "https:") {
        const connectHost = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
        const connectReq = http.request({
          hostname: this.proxyHost,
          port: this.proxyPort,
          method: "CONNECT",
          path: `${connectHost}:${parsed.port || 443}`,
          headers: { "Proxy-Authorization": proxyAuth, Host: `${connectHost}:${parsed.port || 443}` },
        });
        connectReq.on("connect", (_res, sock) => {
          if (_res.statusCode !== 200) {
            clearTimeout(timer);
            sock.destroy();
            reject(new Error(`CONNECT failed: ${_res.statusCode}`));
            return;
          }
          const tlsSock = tls.connect(
            { host: parsed.hostname, socket: sock as net.Socket, servername: parsed.hostname, minVersion: "TLSv1.2" },
            () => {
              const reqLine = `${methodUpper} ${parsed.pathname + parsed.search} HTTP/1.1\r\nHost: ${parsed.host}\r\nUser-Agent: dominusnode-mastra/1.0.0\r\nConnection: close\r\n\r\n`;
              tlsSock.write(reqLine);
              const chunks: Buffer[] = [];
              let bytes = 0;
              tlsSock.on("data", (c: Buffer) => {
                bytes += c.length;
                if (bytes <= MAX_RESP + 16384) chunks.push(c);
              });
              let done = false;
              const fin = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                const raw = Buffer.concat(chunks).toString("utf-8");
                const hEnd = raw.indexOf("\r\n\r\n");
                if (hEnd === -1) {
                  reject(new Error("Malformed response"));
                  return;
                }
                const hdr = raw.substring(0, hEnd);
                const body = raw.substring(hEnd + 4).substring(0, MAX_RESP);
                const sm = hdr.split("\r\n")[0].match(/^HTTP\/\d\.\d\s+(\d+)/);
                const hdrs: Record<string, string> = {};
                for (const l of hdr.split("\r\n").slice(1)) {
                  const ci = l.indexOf(":");
                  if (ci > 0) hdrs[l.substring(0, ci).trim().toLowerCase()] = l.substring(ci + 1).trim();
                }
                resolve({ status: sm ? parseInt(sm[1], 10) : 0, headers: hdrs, body });
              };
              tlsSock.on("end", fin);
              tlsSock.on("close", fin);
              tlsSock.on("error", (e) => { clearTimeout(timer); reject(e); });
            },
          );
          tlsSock.on("error", (e) => { clearTimeout(timer); reject(e); });
        });
        connectReq.on("error", (e) => { clearTimeout(timer); reject(e); });
        connectReq.end();
      } else {
        const req = http.request(
          {
            hostname: this.proxyHost,
            port: this.proxyPort,
            method: methodUpper,
            path: url,
            headers: { "Proxy-Authorization": proxyAuth, Host: parsed.host ?? "" },
          },
          (res) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on("data", (c: Buffer) => {
              bytes += c.length;
              if (bytes <= MAX_RESP) chunks.push(c);
            });
            let done = false;
            const fin = () => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              const body = Buffer.concat(chunks).toString("utf-8").substring(0, MAX_RESP);
              const hdrs: Record<string, string> = {};
              for (const [k, v] of Object.entries(res.headers)) {
                if (v) hdrs[k] = Array.isArray(v) ? v.join(", ") : v;
              }
              resolve({ status: res.statusCode ?? 0, headers: hdrs, body });
            };
            res.on("end", fin);
            res.on("close", fin);
            res.on("error", (e) => { clearTimeout(timer); reject(e); });
          },
        );
        req.on("error", (e) => { clearTimeout(timer); reject(e); });
        req.end();
      }
    });

    return {
      status: result.status,
      headers: result.headers,
      body: truncate(scrubCredentials(result.body)),
      pool: proxyType,
      country: validCountry ?? "auto",
    };
  }

  async checkBalance(): Promise<{ balanceCents: number; balanceUsd: number; dcGbRemaining: string; resGbRemaining: string }> {
    const data = await this.apiGet<{ balanceCents: number; balanceUsd: number }>("/api/wallet");
    const balanceCents = data.balanceCents ?? 0;
    const balanceUsd = data.balanceUsd ?? balanceCents / 100;
    return {
      balanceCents,
      balanceUsd,
      dcGbRemaining: (balanceCents / 300).toFixed(2),
      resGbRemaining: (balanceCents / 500).toFixed(2),
    };
  }

  async checkUsage(days: number = 30): Promise<{ totalBytes: number; totalCostUsd: number; requestCount: number; period: string }> {
    const safeDays = Math.min(Math.max(days, 1), 365);
    const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
    const until = new Date().toISOString();
    const data = await this.apiGet<{ summary: { totalBytes: number; totalCostUsd: number; requestCount: number } }>(
      `/api/usage?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
    );
    return { ...data.summary, period: `${safeDays} days` };
  }

  async getProxyConfig(): Promise<Record<string, unknown>> {
    return this.apiGet("/api/proxy/config");
  }

  async listSessions(): Promise<Record<string, unknown>> {
    return this.apiGet("/api/sessions/active");
  }

  async createAgenticWallet(
    label: string,
    spendingLimitCents: number,
    dailyLimitCents?: number,
    allowedDomains?: string[],
  ): Promise<Record<string, unknown>> {
    if (!label || label.length === 0 || label.length > 100) {
      throw new Error("label is required and must be 1-100 characters.");
    }
    if (/[\x00-\x1f\x7f]/.test(label)) {
      throw new Error("label contains invalid control characters.");
    }
    const safeLimitCents = Math.min(Math.max(spendingLimitCents, 0), 1000000);
    const body: Record<string, unknown> = { label, spendingLimitCents: safeLimitCents };
    if (dailyLimitCents !== undefined && dailyLimitCents !== null) {
      if (!Number.isInteger(dailyLimitCents) || dailyLimitCents < 1 || dailyLimitCents > 1000000) {
        throw new Error("daily_limit_cents must be an integer between 1 and 1,000,000.");
      }
      body.dailyLimitCents = dailyLimitCents;
    }
    if (allowedDomains !== undefined && allowedDomains !== null) {
      if (!Array.isArray(allowedDomains) || allowedDomains.length > 100) {
        throw new Error("allowed_domains must be an array of at most 100 entries.");
      }
      for (const d of allowedDomains) {
        if (typeof d !== "string" || d.length > 253) {
          throw new Error(`invalid domain "${d}". Must be a string of at most 253 characters.`);
        }
      }
      body.allowedDomains = allowedDomains;
    }
    return this.apiPost("/api/agent-wallet", body);
  }

  async updateWalletPolicy(
    walletId: string,
    dailyLimitCents?: number | null,
    allowedDomains?: string[] | null,
  ): Promise<Record<string, unknown>> {
    validateUuid(walletId, "wallet_id");
    const body: Record<string, unknown> = {};
    if (dailyLimitCents !== undefined) {
      if (dailyLimitCents === null) {
        body.dailyLimitCents = null;
      } else {
        if (!Number.isInteger(dailyLimitCents) || dailyLimitCents < 1 || dailyLimitCents > 1000000) {
          throw new Error("daily_limit_cents must be an integer between 1 and 1,000,000, or null to remove.");
        }
        body.dailyLimitCents = dailyLimitCents;
      }
    }
    if (allowedDomains !== undefined) {
      if (allowedDomains === null) {
        body.allowedDomains = null;
      } else {
        if (!Array.isArray(allowedDomains) || allowedDomains.length > 100) {
          throw new Error("allowed_domains must be an array of at most 100 entries, or null to remove.");
        }
        for (const d of allowedDomains) {
          if (typeof d !== "string" || d.length > 253) {
            throw new Error(`invalid domain "${d}". Must be a string of at most 253 characters.`);
          }
        }
        body.allowedDomains = allowedDomains;
      }
    }
    if (Object.keys(body).length === 0) {
      throw new Error("At least one of daily_limit_cents or allowed_domains must be provided.");
    }
    return this.apiPatch(`/api/agent-wallet/${encodeURIComponent(walletId)}/policy`, body);
  }

  async fundAgenticWallet(walletId: string, amountCents: number): Promise<Record<string, unknown>> {
    validateUuid(walletId, "wallet_id");
    if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > 1000000) {
      throw new Error("amount_cents must be an integer between 100 ($1) and 1000000 ($10,000).");
    }
    return this.apiPost(`/api/agent-wallet/${encodeURIComponent(walletId)}/fund`, { amountCents });
  }

  async agenticWalletBalance(walletId: string): Promise<Record<string, unknown>> {
    validateUuid(walletId, "wallet_id");
    return this.apiGet(`/api/agent-wallet/${encodeURIComponent(walletId)}`);
  }

  async listAgenticWallets(): Promise<Record<string, unknown>> {
    return this.apiGet("/api/agent-wallet");
  }

  async agenticTransactions(walletId: string, limit: number = 20): Promise<Record<string, unknown>> {
    validateUuid(walletId, "wallet_id");
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    return this.apiGet(`/api/agent-wallet/${encodeURIComponent(walletId)}/transactions?limit=${safeLimit}`);
  }

  async freezeAgenticWallet(walletId: string): Promise<Record<string, unknown>> {
    validateUuid(walletId, "wallet_id");
    return this.apiPost(`/api/agent-wallet/${encodeURIComponent(walletId)}/freeze`);
  }

  async unfreezeAgenticWallet(walletId: string): Promise<Record<string, unknown>> {
    validateUuid(walletId, "wallet_id");
    return this.apiPost(`/api/agent-wallet/${encodeURIComponent(walletId)}/unfreeze`);
  }

  async deleteAgenticWallet(walletId: string): Promise<Record<string, unknown>> {
    validateUuid(walletId, "wallet_id");
    return this.apiDelete(`/api/agent-wallet/${encodeURIComponent(walletId)}`);
  }

  async createTeam(name: string, maxMembers?: number): Promise<Record<string, unknown>> {
    if (!name || name.length === 0 || name.length > 100) {
      throw new Error("name is required and must be 1-100 characters.");
    }
    if (/[\x00-\x1f\x7f]/.test(name)) {
      throw new Error("team name contains invalid control characters.");
    }
    const body: Record<string, unknown> = { name };
    if (maxMembers !== undefined) {
      if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 100) {
        throw new Error("max_members must be an integer between 1 and 100.");
      }
      body.maxMembers = maxMembers;
    }
    return this.apiPost("/api/teams", body);
  }

  async listTeams(): Promise<Record<string, unknown>> {
    return this.apiGet("/api/teams");
  }

  async teamDetails(teamId: string): Promise<Record<string, unknown>> {
    validateUuid(teamId, "team_id");
    return this.apiGet(`/api/teams/${encodeURIComponent(teamId)}`);
  }

  async teamFund(teamId: string, amountCents: number): Promise<Record<string, unknown>> {
    validateUuid(teamId, "team_id");
    if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > 1000000) {
      throw new Error("amount_cents must be an integer between 100 ($1) and 1000000 ($10,000).");
    }
    return this.apiPost(`/api/teams/${encodeURIComponent(teamId)}/wallet/fund`, { amountCents });
  }

  async teamCreateKey(teamId: string, label: string): Promise<Record<string, unknown>> {
    validateUuid(teamId, "team_id");
    if (!label || label.length === 0 || label.length > 100) {
      throw new Error("label is required and must be 1-100 characters.");
    }
    if (/[\x00-\x1f\x7f]/.test(label)) {
      throw new Error("label contains invalid control characters.");
    }
    return this.apiPost(`/api/teams/${encodeURIComponent(teamId)}/keys`, { label });
  }

  async teamUsage(teamId: string, limit: number = 20): Promise<Record<string, unknown>> {
    validateUuid(teamId, "team_id");
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    return this.apiGet(`/api/teams/${encodeURIComponent(teamId)}/wallet/transactions?limit=${safeLimit}`);
  }

  async updateTeam(teamId: string, name?: string, maxMembers?: number): Promise<Record<string, unknown>> {
    validateUuid(teamId, "team_id");
    const body: Record<string, unknown> = {};
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length === 0 || trimmed.length > 100) {
        throw new Error("name must be 1-100 characters.");
      }
      if (/[\x00-\x1f\x7f]/.test(trimmed)) {
        throw new Error("team name contains invalid control characters.");
      }
      body.name = trimmed;
    }
    if (maxMembers !== undefined) {
      if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 100) {
        throw new Error("max_members must be an integer between 1 and 100.");
      }
      body.maxMembers = maxMembers;
    }
    if (Object.keys(body).length === 0) {
      throw new Error("At least one of name or max_members must be provided.");
    }
    return this.apiPatch(`/api/teams/${encodeURIComponent(teamId)}`, body);
  }

  async updateTeamMemberRole(teamId: string, userId: string, role: string): Promise<Record<string, unknown>> {
    validateUuid(teamId, "team_id");
    validateUuid(userId, "user_id");
    if (role !== "member" && role !== "admin") {
      throw new Error("role must be 'member' or 'admin'.");
    }
    return this.apiPatch(
      `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { role },
    );
  }

  async topupPaypal(amountCents: number): Promise<Record<string, unknown>> {
    if (!Number.isInteger(amountCents) || amountCents < 500 || amountCents > 100000) {
      throw new Error("amount_cents must be an integer between 500 ($5) and 100000 ($1,000).");
    }
    return this.apiPost("/api/wallet/topup/paypal", { amountCents });
  }

  async x402Info(): Promise<Record<string, unknown>> {
    return this.apiGet("/api/x402/info");
  }

  // -----------------------------------------------------------------------
  // getTools() -- returns Mastra createTool() instances for all 24 tools
  // -----------------------------------------------------------------------

  getTools() {
    return [
      // 1. proxied_fetch
      createTool({
        id: "dominusnode_proxied_fetch",
        description:
          "Fetch a URL through Dominus Node's rotating proxy network with geo-targeting. " +
          "Supports datacenter ($3/GB) and residential ($5/GB) pools. " +
          "Only GET, HEAD, and OPTIONS methods are allowed.",
        inputSchema: z.object({
          url: z.string().describe("Target URL to fetch (http or https)"),
          method: z.enum(["GET", "HEAD", "OPTIONS"]).default("GET").describe("HTTP method"),
          country: z.string().optional().describe("ISO 3166-1 alpha-2 country code for geo-targeting (e.g., US, GB, DE)"),
          proxyType: z.enum(["dc", "residential"]).default("dc").describe("Proxy pool type: dc (datacenter, $3/GB) or residential ($5/GB)"),
        }) as any,
        outputSchema: z.object({
          status: z.number(),
          headers: z.record(z.string()),
          body: z.string(),
          pool: z.string(),
          country: z.string(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return await this.proxiedFetch(context.url, context.method, context.country, context.proxyType);
          } catch (err) {
            return { status: 0, headers: {}, body: "", pool: context.proxyType ?? "dc", country: context.country ?? "auto", error: safeError(err) };
          }
        },
      }),

      // 2. check_balance
      createTool({
        id: "dominusnode_check_balance",
        description:
          "Check your Dominus Node wallet balance and estimated remaining bandwidth at current pricing. " +
          "Shows balance in USD, datacenter GB remaining ($3/GB), and residential GB remaining ($5/GB).",
        inputSchema: z.object({}) as any,
        outputSchema: z.object({
          balanceCents: z.number(),
          balanceUsd: z.number(),
          dcGbRemaining: z.string(),
          resGbRemaining: z.string(),
          error: z.string().optional(),
        }),
        execute: async () => {
          try {
            return await this.checkBalance();
          } catch (err) {
            return { balanceCents: 0, balanceUsd: 0, dcGbRemaining: "0", resGbRemaining: "0", error: safeError(err) };
          }
        },
      }),

      // 3. check_usage
      createTool({
        id: "dominusnode_check_usage",
        description:
          "View bandwidth usage statistics for a specified time period. " +
          "Shows total bytes transferred, total cost, and request count.",
        inputSchema: z.object({
          days: z.number().min(1).max(365).default(30).describe("Number of days to look back (1-365)"),
        }) as any,
        outputSchema: z.object({
          totalBytes: z.number(),
          totalCostUsd: z.number(),
          requestCount: z.number(),
          period: z.string(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return await this.checkUsage(context.days);
          } catch (err) {
            return { totalBytes: 0, totalCostUsd: 0, requestCount: 0, period: `${context.days} days`, error: safeError(err) };
          }
        },
      }),

      // 4. get_proxy_config
      createTool({
        id: "dominusnode_get_proxy_config",
        description:
          "Get available proxy pools, pricing, supported countries, and endpoint configuration. " +
          "Returns proxy host, ports, and pool details.",
        inputSchema: z.object({}) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async () => {
          try {
            return { data: await this.getProxyConfig() };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 5. list_sessions
      createTool({
        id: "dominusnode_list_sessions",
        description:
          "List all active proxy sessions showing target hosts, bandwidth used, and status.",
        inputSchema: z.object({}) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async () => {
          try {
            return { data: await this.listSessions() };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 6. create_agentic_wallet
      createTool({
        id: "dominusnode_create_agentic_wallet",
        description:
          "Create a server-side custodial agentic wallet for autonomous proxy billing. " +
          "Set a spending limit per transaction for safety. Optionally set a daily budget cap and domain allowlist.",
        inputSchema: z.object({
          label: z.string().min(1).max(100).describe('Label for this wallet (e.g., "scraper-bot", "research-agent")'),
          spendingLimitCents: z.number().int().min(0).max(1000000).default(10000)
            .describe("Max spend per transaction in cents (0 = no limit, default $100 = 10000 cents)"),
          dailyLimitCents: z.number().int().positive().max(1000000).optional()
            .describe("Optional daily budget cap in cents (max 1,000,000 = $10,000)"),
          allowedDomains: z.array(z.string().max(253)).max(100).optional()
            .describe("Optional list of allowed domains for proxy access (max 100 entries)"),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.createAgenticWallet(context.label, context.spendingLimitCents, context.dailyLimitCents, context.allowedDomains) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 7. fund_agentic_wallet
      createTool({
        id: "dominusnode_fund_agentic_wallet",
        description:
          "Transfer funds from your main wallet to an agentic wallet. " +
          "Minimum $1 (100 cents), maximum $10,000 (1000000 cents).",
        inputSchema: z.object({
          walletId: z.string().describe("Agentic wallet ID (UUID)"),
          amountCents: z.number().int().min(100).max(1000000).describe("Amount in cents to transfer (min 100, max 1000000)"),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.fundAgenticWallet(context.walletId, context.amountCents) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 8. agentic_wallet_balance
      createTool({
        id: "dominusnode_agentic_wallet_balance",
        description: "Check the balance and details of an agentic wallet.",
        inputSchema: z.object({
          walletId: z.string().describe("Agentic wallet ID (UUID)"),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.agenticWalletBalance(context.walletId) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 9. list_agentic_wallets
      createTool({
        id: "dominusnode_list_agentic_wallets",
        description: "List all your agentic wallets with balances and status.",
        inputSchema: z.object({}) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async () => {
          try {
            return { data: await this.listAgenticWallets() };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 10. agentic_transactions
      createTool({
        id: "dominusnode_agentic_transactions",
        description: "Get transaction history for an agentic wallet.",
        inputSchema: z.object({
          walletId: z.string().describe("Agentic wallet ID (UUID)"),
          limit: z.number().int().min(1).max(100).default(20).describe("Number of transactions to return (1-100, default 20)"),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.agenticTransactions(context.walletId, context.limit) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 11. freeze_agentic_wallet
      createTool({
        id: "dominusnode_freeze_agentic_wallet",
        description:
          "Freeze an agentic wallet to prevent any further spending. " +
          "The wallet balance is preserved but no transactions are allowed until unfrozen.",
        inputSchema: z.object({
          walletId: z.string().describe("Agentic wallet ID (UUID)"),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.freezeAgenticWallet(context.walletId) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 12. unfreeze_agentic_wallet
      createTool({
        id: "dominusnode_unfreeze_agentic_wallet",
        description: "Unfreeze a previously frozen agentic wallet to re-enable spending.",
        inputSchema: z.object({
          walletId: z.string().describe("Agentic wallet ID (UUID)"),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.unfreezeAgenticWallet(context.walletId) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 13. delete_agentic_wallet
      createTool({
        id: "dominusnode_delete_agentic_wallet",
        description:
          "Delete an agentic wallet. Must be unfrozen first. " +
          "Any remaining balance is refunded to your main wallet.",
        inputSchema: z.object({
          walletId: z.string().describe("Agentic wallet ID (UUID)"),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.deleteAgenticWallet(context.walletId) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 13b. update_wallet_policy
      createTool({
        id: "dominusnode_update_wallet_policy",
        description:
          "Update spending policy for an agentic wallet. " +
          "Set or remove daily budget caps and domain restrictions.",
        inputSchema: z.object({
          walletId: z.string().describe("Agentic wallet ID (UUID)"),
          dailyLimitCents: z.number().int().positive().max(1000000).nullable().optional()
            .describe("Daily budget cap in cents (max 1,000,000). Set null to remove."),
          allowedDomains: z.array(z.string().max(253)).max(100).nullable().optional()
            .describe("List of allowed domains (max 100). Set null to remove restriction."),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.updateWalletPolicy(context.walletId, context.dailyLimitCents, context.allowedDomains) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 14. create_team
      createTool({
        id: "dominusnode_create_team",
        description:
          "Create a new team with shared wallet billing. " +
          "Teams allow multiple users to share proxy access and costs.",
        inputSchema: z.object({
          name: z.string().min(1).max(100).describe("Team name (1-100 characters)"),
          maxMembers: z.number().int().min(1).max(100).optional().describe("Maximum number of team members (1-100, optional)"),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.createTeam(context.name, context.maxMembers) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 15. list_teams
      createTool({
        id: "dominusnode_list_teams",
        description: "List all teams you belong to, with your role and team balance.",
        inputSchema: z.object({}) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async () => {
          try {
            return { data: await this.listTeams() };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 16. team_details
      createTool({
        id: "dominusnode_team_details",
        description:
          "Get detailed info about a team including balance, members, settings, and your role.",
        inputSchema: z.object({
          teamId: z.string().describe("Team ID (UUID)"),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.teamDetails(context.teamId) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 17. team_fund
      createTool({
        id: "dominusnode_team_fund",
        description:
          "Transfer funds from your personal wallet to a team wallet. " +
          "Minimum $1 (100 cents), maximum $10,000 (1000000 cents).",
        inputSchema: z.object({
          teamId: z.string().describe("Team ID (UUID)"),
          amountCents: z.number().int().min(100).max(1000000).describe("Amount in cents to transfer (min 100, max 1000000)"),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.teamFund(context.teamId, context.amountCents) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 18. team_create_key
      createTool({
        id: "dominusnode_team_create_key",
        description:
          "Create a shared API key for a team. Usage is billed against the team wallet. " +
          "The key is shown only once -- save it immediately.",
        inputSchema: z.object({
          teamId: z.string().describe("Team ID (UUID)"),
          label: z.string().min(1).max(100).describe('Label for the API key (e.g., "production", "staging")'),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.teamCreateKey(context.teamId, context.label) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 19. team_usage
      createTool({
        id: "dominusnode_team_usage",
        description: "Get the team wallet transaction history (funding, usage charges, refunds).",
        inputSchema: z.object({
          teamId: z.string().describe("Team ID (UUID)"),
          limit: z.number().int().min(1).max(100).default(20).describe("Number of transactions to return (1-100, default 20)"),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.teamUsage(context.teamId, context.limit) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 20. update_team
      createTool({
        id: "dominusnode_update_team",
        description:
          "Update a team's settings (name and/or max member count). Only owners and admins can update.",
        inputSchema: z.object({
          teamId: z.string().describe("Team ID (UUID)"),
          name: z.string().min(1).max(100).optional().describe("New team name (1-100 characters)"),
          maxMembers: z.number().int().min(1).max(100).optional().describe("New max member count (1-100)"),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.updateTeam(context.teamId, context.name, context.maxMembers) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 21. update_team_member_role
      createTool({
        id: "dominusnode_update_team_member_role",
        description:
          "Update a team member's role (member or admin). Only owners and admins can change roles.",
        inputSchema: z.object({
          teamId: z.string().describe("Team ID (UUID)"),
          userId: z.string().describe("User ID (UUID) of the member whose role to change"),
          role: z.enum(["member", "admin"]).describe("New role for the member"),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.updateTeamMemberRole(context.teamId, context.userId, context.role) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 22. topup_paypal
      createTool({
        id: "dominusnode_topup_paypal",
        description:
          "Top up your Dominus Node wallet balance via PayPal. Creates a PayPal order and returns " +
          "an approval URL to complete payment. Minimum $5 (500 cents), maximum $1,000 (100000 cents).",
        inputSchema: z.object({
          amountCents: z.number().int().min(500).max(100000)
            .describe("Amount in cents to top up (min 500 = $5, max 100000 = $1,000)"),
        }) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async ({ context }: { context: any }) => {
          try {
            return { data: await this.topupPaypal(context.amountCents) };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),

      // 24. x402_info
      createTool({
        id: "dominusnode_x402_info",
        description:
          "Get x402 micropayment protocol information including supported " +
          "facilitators, pricing, and payment options.",
        inputSchema: z.object({}) as any,
        outputSchema: z.object({
          data: z.unknown(),
          error: z.string().optional(),
        }),
        execute: async () => {
          try {
            return { data: await this.x402Info() };
          } catch (err) {
            return { data: null, error: safeError(err) };
          }
        },
      }),
    ];
  }
}
