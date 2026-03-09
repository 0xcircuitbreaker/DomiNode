/**
 * Dominus Node Pi Extension Toolkit
 *
 * Provides 53 tools for the pi-mono agent framework (github.com/badlogic/pi-mono).
 * Covers proxied fetching, wallet management, agentic wallets, teams,
 * Stripe/PayPal/crypto top-up, and x402 micropayment info.
 *
 * Security:
 *  - Full SSRF protection (private IP blocking, DNS rebinding, Teredo/6to4,
 *    IPv4-mapped/compatible IPv6, hex/octal/decimal normalization, zone ID
 *    stripping, .localhost/.local/.internal/.arpa TLD blocking, embedded
 *    credential blocking)
 *  - OFAC sanctioned country validation (CU, IR, KP, RU, SY)
 *  - Credential scrubbing in all error outputs
 *  - Prototype pollution prevention on all parsed JSON (recursive)
 *  - HTTP method restriction (GET/HEAD/OPTIONS only for proxied fetch)
 *  - 10 MB response cap, 4000 char truncation, 30 s timeout
 *  - Redirect following disabled to prevent open redirect abuse
 *  - DNS rebinding protection on all proxied requests
 */

import * as crypto from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import * as dns from "dns/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RESPONSE_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB hard cap
const MAX_PROXY_RESPONSE_BYTES = 1_048_576; // 1 MB for proxied fetch
const ALLOWED_PROXY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** OFAC sanctioned countries — must never be used as geo-targeting destinations. */
export const SANCTIONED_COUNTRIES = new Set(["CU", "IR", "KP", "RU", "SY"]);

/** ISO 3166-1 alpha-2 country code pattern. */
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

/** UUID v4 pattern for wallet/team IDs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "[::1]",
  "[::ffff:127.0.0.1]",
  "0.0.0.0",
  "[::]",
]);

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

/**
 * Normalize non-standard IPv4 representations to dotted-decimal.
 * Handles: decimal integers (2130706433), hex (0x7f000001), octal octets (0177.0.0.1).
 */
export function normalizeIpv4(hostname: string): string | null {
  // Helper: parse one numeric part (supports hex 0x.., octal 0.., decimal)
  function parsePart(part: string): number {
    if (/^0x[0-9a-fA-F]+$/i.test(part)) return parseInt(part, 16);
    if (/^0\d+$/.test(part)) return parseInt(part, 8);
    if (/^\d+$/.test(part)) return parseInt(part, 10);
    return NaN;
  }
  function u32ToDotted(n: number): string {
    return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
  }

  // Single integer form (decimal or hex) — e.g. 2130706433 or 0x7f000001
  if (/^\d+$/.test(hostname)) {
    const n = parseInt(hostname, 10);
    if (n >= 0 && n <= 0xffffffff) return u32ToDotted(n);
  }
  if (/^0x[0-9a-fA-F]+$/i.test(hostname)) {
    const n = parseInt(hostname, 16);
    if (n >= 0 && n <= 0xffffffff) return u32ToDotted(n);
  }

  const parts = hostname.split(".");
  if (parts.length === 4) {
    // a.b.c.d — each octet 0-255
    const octets = parts.map(parsePart);
    if (octets.some((v) => isNaN(v) || v < 0 || v > 255)) return null;
    return octets.join(".");
  }
  if (parts.length === 3) {
    // a.b.cd — a,b: 0-255, cd: 0-65535 → a.b.(cd>>8).(cd&0xff)
    const [a, b, cd] = parts.map(parsePart);
    if ([a, b].some((v) => isNaN(v) || v < 0 || v > 255)) return null;
    if (isNaN(cd) || cd < 0 || cd > 0xffff) return null;
    return `${a}.${b}.${(cd >>> 8) & 0xff}.${cd & 0xff}`;
  }
  if (parts.length === 2) {
    // a.bcd — a: 0-255, bcd: 0-16777215 → a.(bcd>>16).(bcd>>8&0xff).(bcd&0xff)
    const [a, bcd] = parts.map(parsePart);
    if (isNaN(a) || a < 0 || a > 255) return null;
    if (isNaN(bcd) || bcd < 0 || bcd > 0xffffff) return null;
    return `${a}.${(bcd >>> 16) & 0xff}.${(bcd >>> 8) & 0xff}.${bcd & 0xff}`;
  }
  return null;
}

export function isPrivateIp(hostname: string): boolean {
  let ip = hostname.replace(/^\[|\]$/g, "");
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) ip = ip.substring(0, zoneIdx);

  const normalized = normalizeIpv4(ip);
  const checkIp = normalized ?? ip;

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
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // Multicast / reserved
    return false;
  }

  const ipLower = ip.toLowerCase();
  if (ipLower === "::1") return true;
  if (ipLower === "::") return true;
  if (ipLower.startsWith("fc") || ipLower.startsWith("fd")) return true; // ULA
  if (ipLower.startsWith("fe80")) return true; // Link-local
  if (ipLower.startsWith("ff")) return true; // Multicast
  if (ipLower.startsWith("2001:0000:") || ipLower.startsWith("2001:0:")) return true; // Teredo
  if (ipLower.startsWith("2002:")) return true; // 6to4

  // IPv4-mapped ::ffff:x.x.x.x
  if (ipLower.startsWith("::ffff:")) {
    const embedded = ipLower.slice(7);
    if (embedded.includes(".")) return isPrivateIp(embedded);
    const hexParts = embedded.split(":");
    if (hexParts.length === 2) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      if (!isNaN(hi) && !isNaN(lo)) {
        return isPrivateIp(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
      }
    }
    return isPrivateIp(embedded);
  }

  // IPv4-compatible ::x.x.x.x (deprecated but parsed)
  if (ipLower.startsWith("::") && !ipLower.startsWith("::ffff:")) {
    const rest = ipLower.slice(2);
    if (rest && rest.includes(".")) return isPrivateIp(rest);
    const hexParts = rest.split(":");
    if (hexParts.length === 2 && hexParts[0] && hexParts[1]) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      if (!isNaN(hi) && !isNaN(lo)) {
        return isPrivateIp(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
      }
    }
  }

  return false;
}

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
  if (hostname.endsWith(".localhost")) {
    throw new Error("Requests to localhost/loopback addresses are blocked");
  }
  if (hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".arpa")) {
    throw new Error("Requests to internal network hostnames are blocked");
  }
  return parsed;
}

export function validateCountry(country: string | undefined): string | undefined {
  if (!country) return undefined;
  const upper = country.toUpperCase().trim();
  if (!COUNTRY_CODE_RE.test(upper)) {
    throw new Error(`Invalid country code: "${country}". Must be a 2-letter ISO 3166-1 code.`);
  }
  if (SANCTIONED_COUNTRIES.has(upper)) {
    throw new Error(`Country "${upper}" is OFAC sanctioned and cannot be used as a proxy target.`);
  }
  return upper;
}

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

export async function checkDnsRebinding(hostname: string): Promise<void> {
  const stripped = hostname.replace(/^\[|\]$/g, "");
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(stripped) || stripped.includes(":")) return;

  // M-4: Use stripped (bracket-removed) hostname for DNS resolution
  const resolvedIps: string[] = [];
  try {
    resolvedIps.push(...(await dns.resolve4(stripped)));
  } catch { /* NODATA/NXDOMAIN for A is fine */ }
  try {
    resolvedIps.push(...(await dns.resolve6(stripped)));
  } catch { /* NODATA/NXDOMAIN for AAAA is fine */ }

  for (const ip of resolvedIps) {
    if (isPrivateIp(ip)) {
      throw new Error(`DNS rebinding detected: hostname resolves to private IP ${ip}`);
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
// Pi tool return type
// ---------------------------------------------------------------------------

export interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

function ok(text: string): PiToolResult {
  return { content: [{ type: "text", text: truncate(text) }], details: {} };
}

/** C-1: Validate a label string — reject empty, control chars, and over-length values.
 *  M-1: Includes ASCII C0/C1, DEL, BOM, Unicode line/paragraph separators, bidi overrides. */
function validateLabel(label: string, fieldName = "label"): string | null {
  const trimmed = label.trim();
  if (!trimmed) return `${fieldName} is required`;
  if (trimmed.length > 100) return `${fieldName} must be 1-100 characters`;
  if (/[\x00-\x1f\x7f\x80-\x9f\u2028\u2029\ufeff\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(trimmed))
    return `${fieldName} contains invalid control characters`;
  return null;
}

function err(e: unknown): PiToolResult {
  return ok(`Error: ${safeError(e)}`);
}

// ---------------------------------------------------------------------------
// Toolkit options
// ---------------------------------------------------------------------------

export interface DominusNodeToolkitOptions {
  apiKey?: string;
  baseUrl?: string;
  proxyHost?: string;
  proxyPort?: number;
  timeout?: number;
  /** Optional agent secret for MCP agent auto-verification (bypasses reCAPTCHA). */
  agentSecret?: string;
}

// ---------------------------------------------------------------------------
// DominusNodeToolkit
// ---------------------------------------------------------------------------

export class DominusNodeToolkit {
  private apiKey: string;
  private baseUrl: string;
  private proxyHost: string;
  private proxyPort: number;
  private timeout: number;
  private agentSecret?: string;
  private token: string | null = null;
  private tokenExpiresAt: number = 0;
  private _authPromise: Promise<void> | null = null; // H-1: mutex for concurrent _ensureAuth

  constructor(options: DominusNodeToolkitOptions = {}) {
    this.apiKey = options.apiKey || process.env["DOMINUSNODE_API_KEY"] || "";

    // H-6: Validate baseUrl
    const rawBase = (options.baseUrl || process.env["DOMINUSNODE_BASE_URL"] || "https://api.dominusnode.com").replace(/\/+$/, "");
    try {
      const parsedBase = new URL(rawBase);
      if (parsedBase.protocol !== "https:" && parsedBase.protocol !== "http:") throw new Error("only http/https allowed");
      if (parsedBase.username || parsedBase.password) throw new Error("embedded credentials not allowed in base URL");
      // H-1: Warn on HTTP base URL in production
      if (parsedBase.protocol === "http:" && parsedBase.hostname !== "localhost" && parsedBase.hostname !== "127.0.0.1") {
        console.warn("[DominusNode] WARNING: baseUrl uses HTTP — API key will be sent unencrypted");
      }
    } catch (e) {
      throw new Error(`Invalid DOMINUSNODE_BASE_URL: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.baseUrl = rawBase;

    // H-2: Validate proxyHost against private/internal IPs
    const rawProxyHost = options.proxyHost || process.env["DOMINUSNODE_PROXY_HOST"] || "proxy.dominusnode.com";
    if (BLOCKED_HOSTNAMES.has(rawProxyHost.toLowerCase()) || isPrivateIp(rawProxyHost)) {
      throw new Error("DOMINUSNODE_PROXY_HOST must not be a private or loopback address");
    }
    if (rawProxyHost.endsWith(".localhost") || rawProxyHost.endsWith(".local") ||
        rawProxyHost.endsWith(".internal") || rawProxyHost.endsWith(".arpa")) {
      throw new Error("DOMINUSNODE_PROXY_HOST must not use internal network TLDs");
    }
    this.proxyHost = rawProxyHost;
    const portVal = Number(options.proxyPort ?? process.env["DOMINUSNODE_PROXY_PORT"] ?? 8080);
    this.proxyPort = isNaN(portVal) || portVal < 1 || portVal > 65535 ? 8080 : portVal;
    // H-2: Validate timeout option; store but use REQUEST_TIMEOUT_MS constant for requests
    const tVal = Number(options.timeout ?? 30000);
    this.timeout = Number.isFinite(tVal) && tVal >= 1000 && tVal <= 120000 ? tVal : 30000;
    this.agentSecret = options.agentSecret || process.env["DOMINUSNODE_AGENT_SECRET"];
  }

  // -----------------------------------------------------------------------
  // SHA-256 Proof-of-Work solver
  // -----------------------------------------------------------------------

  private static _countLeadingZeroBits(buf: Buffer): number {
    let count = 0;
    for (const byte of buf) {
      if (byte === 0) { count += 8; continue; }
      let mask = 0x80;
      while (mask && !(byte & mask)) { count++; mask >>= 1; }
      break;
    }
    return count;
  }

  private async _solvePoW(): Promise<{ challengeId: string; nonce: string } | null> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/auth/pow/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        redirect: "error",
      });
      if (!resp.ok) return null;
      const text = await resp.text();
      if (text.length > 10_485_760) return null;
      const challenge = JSON.parse(text);
      const prefix: string = challenge.prefix ?? "";
      const difficulty: number = challenge.difficulty ?? 20;
      const challengeId: string = challenge.challengeId ?? "";
      if (!prefix || !challengeId) return null;
      for (let nonce = 0; nonce < 100_000_000; nonce++) {
        const hash = crypto.createHash("sha256").update(prefix + nonce.toString()).digest();
        if (DominusNodeToolkit._countLeadingZeroBits(hash) >= difficulty) {
          return { challengeId, nonce: nonce.toString() };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  private async _authenticate(): Promise<string> {
    if (!this.apiKey) throw new Error("Dominus Node API key is required. Set DOMINUSNODE_API_KEY env var.");
    if (!this.apiKey.startsWith("dn_live_") && !this.apiKey.startsWith("dn_test_")) {
      throw new Error('DOMINUSNODE_API_KEY must start with "dn_live_" or "dn_test_".');
    }
    const authHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "dominusnode-pi/1.0.0",
    };
    if (this.agentSecret) {
      authHeaders["X-DominusNode-Agent"] = "mcp";
      authHeaders["X-DominusNode-Agent-Secret"] = this.agentSecret;
    }
    const res = await fetch(`${this.baseUrl}/api/auth/verify-key`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ apiKey: this.apiKey }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // L-1: Bounded error body read — avoid buffering large error responses
      let errorText = "";
      if (res.body) {
        const reader = res.body.getReader();
        let eb = 0;
        const parts: Uint8Array[] = [];
        try {
          while (eb < 4096) {
            const { done, value } = await reader.read();
            if (done) break;
            eb += value.length;
            parts.push(value);
          }
        } catch { /* ignore */ }
        reader.cancel().catch(() => {});
        errorText = Buffer.concat(parts).toString("utf-8").slice(0, 500);
      }
      throw new Error(`Auth failed (${res.status}): ${scrubCredentials(errorText)}`);
    }
    // H-5: Cap auth response size and validate token type
    const rawText = await res.text().catch(() => "");
    if (new TextEncoder().encode(rawText).length > 65536) throw new Error("Auth response too large");
    const data = JSON.parse(rawText) as { token: string };
    stripDangerousKeys(data);
    if (!data.token || typeof data.token !== "string" || data.token.length > 4096) {
      throw new Error("Invalid token in auth response");
    }
    this.token = data.token;
    this.tokenExpiresAt = Date.now() + 14 * 60 * 1000;
    return this.token;
  }

  private async _ensureAuth(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiresAt) return;
    // H-1: Serialize concurrent auth calls — all concurrent callers await the same promise
    if (this._authPromise) { await this._authPromise; return; }
    this._authPromise = this._authenticate()
      .then(() => { this._authPromise = null; })
      .catch((e) => { this._authPromise = null; throw e; });
    await this._authPromise;
  }

  private async _apiRequest<T = unknown>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    await this._ensureAuth();
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "User-Agent": "dominusnode-pi/1.0.0",
    };
    if (this.agentSecret) {
      headers["X-DominusNode-Agent"] = "mcp";
      headers["X-DominusNode-Agent-Secret"] = this.agentSecret;
    }
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error" };
    // M-6: Drop body on safe HTTP methods
    if (body && !["GET", "HEAD"].includes(method) && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new Error(`API request failed: ${safeError(e)}`);
    }
    // C-2: Stream response body with size cap to avoid memory exhaustion
    let rawText = "";
    if (res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            reader.cancel().catch(() => {});
            throw new Error("API response too large");
          }
          chunks.push(value);
        }
      } catch (e) {
        reader.cancel().catch(() => {});
        throw e;
      }
      rawText = Buffer.concat(chunks).toString("utf-8"); // M-3: Uint8Array[] accepted directly
    }
    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const parsed = JSON.parse(rawText);
        stripDangerousKeys(parsed);
        const detail = parsed.error ?? parsed.message;
        if (detail) msg = `API error ${res.status}: ${scrubCredentials(String(detail))}`;
      } catch { if (rawText) msg = `API error ${res.status}: ${scrubCredentials(rawText.slice(0, 200))}`; }
      throw new Error(msg);
    }
    if (!rawText || !rawText.trim()) return {} as T;
    try {
      const parsed = JSON.parse(rawText);
      stripDangerousKeys(parsed);
      return parsed as T;
    } catch {
      throw new Error("Failed to parse API response as JSON");
    }
  }

  private async _req<T = unknown>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    try {
      return await this._apiRequest<T>(method, path, body);
    } catch (e) {
      // H-7: Match exact "API error 401" pattern, not any string containing "401"
      if (e instanceof Error && /^API error 401\b/.test(e.message)) {
        this.token = null;
        this.tokenExpiresAt = 0;
        return await this._apiRequest<T>(method, path, body);
      }
      throw e;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 1: proxiedFetch
  // -----------------------------------------------------------------------

  async proxiedFetch(url: string, method = "GET", country?: string, proxyType = "dc"): Promise<PiToolResult> {
    try {
      if (!url) return err("url parameter is required");
      const parsedUrl = validateTargetUrl(url);
      await checkDnsRebinding(parsedUrl.hostname);
      const validCountry = validateCountry(country);
      const methodUpper = method.toUpperCase();
      if (!ALLOWED_PROXY_METHODS.has(methodUpper)) return err(`HTTP method "${methodUpper}" is not allowed. Only GET, HEAD, OPTIONS permitted.`);
      if (!["dc", "residential", "auto"].includes(proxyType)) return err("proxyType must be 'dc', 'residential', or 'auto'");
      if (!this.apiKey) return err("API key is required for proxied fetch");

      const parts: string[] = [];
      if (proxyType !== "auto") parts.push(proxyType);
      if (validCountry) parts.push(`country-${validCountry}`);
      const username = parts.length ? parts.join("-") : "auto";
      const proxyAuth = "Basic " + Buffer.from(`${username}:${this.apiKey}`).toString("base64");
      // C-3: Use the already-validated parsedUrl — do not re-parse the raw url string
      const parsed = parsedUrl;

      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        // H-3: Shared cleanup reference — each branch sets this to destroy its own request socket
        let cleanupFn: (() => void) | null = null;
        const timer = setTimeout(() => {
          cleanupFn?.();
          reject(new Error("Proxy request timed out"));
        }, REQUEST_TIMEOUT_MS);

        if (parsed.protocol === "https:") {
          const connectHost = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
          const connectReq = http.request({
            hostname: this.proxyHost, port: this.proxyPort, method: "CONNECT",
            path: `${connectHost}:${parsed.port || 443}`,
            headers: { "Proxy-Authorization": proxyAuth, Host: `${connectHost}:${parsed.port || 443}` },
          });
          cleanupFn = () => connectReq.destroy();
          connectReq.on("connect", (_res, sock) => {
            if (_res.statusCode !== 200) { clearTimeout(timer); sock.destroy(); reject(new Error(`CONNECT failed: ${_res.statusCode}`)); return; }
            const tlsSock = tls.connect({ host: parsed.hostname, socket: sock as net.Socket, servername: parsed.hostname, minVersion: "TLSv1.2" }, () => {
              const reqLine = `${methodUpper} ${parsed.pathname + parsed.search} HTTP/1.1\r\nHost: ${parsed.host}\r\nUser-Agent: dominusnode-pi/1.0.0\r\nConnection: close\r\n\r\n`;
              tlsSock.write(reqLine);
              const chunks: Buffer[] = [];
              let bytes = 0;
              tlsSock.on("data", (c: Buffer) => {
                bytes += c.length;
                if (bytes > MAX_PROXY_RESPONSE_BYTES + 16384) { tlsSock.destroy(); return; } // H-4: destroy on oversize
                chunks.push(c);
              });
              let done = false;
              const fin = () => {
                if (done) return; done = true; clearTimeout(timer);
                const raw = Buffer.concat(chunks).toString("utf-8");
                const hEnd = raw.indexOf("\r\n\r\n");
                if (hEnd === -1) { reject(new Error("Malformed response")); return; }
                const hdr = raw.substring(0, hEnd);
                const body = raw.substring(hEnd + 4).substring(0, MAX_PROXY_RESPONSE_BYTES);
                const sm = hdr.split("\r\n")[0].match(/^HTTP\/\d\.\d\s+(\d+)/);
                resolve({ status: sm ? parseInt(sm[1], 10) : 0, body });
              };
              tlsSock.on("end", fin); tlsSock.on("close", fin);
              tlsSock.on("error", (e) => { clearTimeout(timer); reject(e); });
            });
            // M-1: Update cleanupFn to destroy tlsSock — covers the TLS handshake window
            cleanupFn = () => tlsSock.destroy();
            tlsSock.on("error", (e) => { clearTimeout(timer); reject(e); });
          });
          connectReq.on("error", (e) => { clearTimeout(timer); reject(e); });
          connectReq.end();
        } else {
          const reqPath = parsed.pathname + parsed.search;
          const proxyReq = http.request({
            hostname: this.proxyHost, port: this.proxyPort, method: methodUpper,
            path: `http://${parsed.host}${reqPath}`,
            headers: { "Proxy-Authorization": proxyAuth, Host: parsed.host, "User-Agent": "dominusnode-pi/1.0.0", Connection: "close" },
          });
          cleanupFn = () => proxyReq.destroy(); // H-3: destroy on timeout
          const chunks: Buffer[] = [];
          let bytes = 0;
          proxyReq.on("response", (r) => {
            r.on("data", (c: Buffer) => {
              bytes += c.length;
              if (bytes > MAX_PROXY_RESPONSE_BYTES + 16384) { r.destroy(); return; } // H-4: destroy on oversize
              chunks.push(c);
            });
            r.on("end", () => { clearTimeout(timer); const body = Buffer.concat(chunks).toString("utf-8").substring(0, MAX_PROXY_RESPONSE_BYTES); resolve({ status: r.statusCode ?? 0, body }); });
            r.on("error", (e) => { clearTimeout(timer); reject(e); });
          });
          proxyReq.on("error", (e) => { clearTimeout(timer); reject(e); });
          proxyReq.end();
        }
      });

      return ok(`HTTP ${result.status}\n\n${result.body}`);
    } catch (e) {
      return err(e);
    }
  }

  // -----------------------------------------------------------------------
  // Tool 2: checkBalance
  // -----------------------------------------------------------------------

  async checkBalance(): Promise<PiToolResult> {
    try {
      const data = await this._req("GET", "/api/wallet");
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 3: checkUsage
  // -----------------------------------------------------------------------

  async checkUsage(days = 30): Promise<PiToolResult> {
    try {
      const rawDays = Number(days);
      if (!Number.isFinite(rawDays)) return err("days must be a finite number between 1 and 365");
      const d = Math.max(1, Math.min(365, Math.floor(rawDays)));
      const until = new Date().toISOString();
      const since = new Date(Date.now() - d * 86400000).toISOString();
      const data = await this._req("GET", `/api/usage?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 4: getProxyConfig
  // -----------------------------------------------------------------------

  async getProxyConfig(): Promise<PiToolResult> {
    try {
      const data = await this._req("GET", "/api/proxy/config");
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 5: listSessions
  // -----------------------------------------------------------------------

  async listSessions(): Promise<PiToolResult> {
    try {
      const data = await this._req("GET", "/api/proxy/sessions");
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 6: createAgenticWallet
  // -----------------------------------------------------------------------

  async createAgenticWallet(label: string, spendingLimitCents?: number): Promise<PiToolResult> {
    try {
      const labelErr = validateLabel(label);
      if (labelErr) return err(labelErr);
      const body: Record<string, unknown> = { label: label.trim() };
      if (spendingLimitCents !== undefined) {
        const limit = Math.floor(Number(spendingLimitCents));
        if (isNaN(limit) || limit < 1 || limit > 1000000) return err("spendingLimitCents must be between 1 and 1,000,000");
        body.spendingLimitCents = limit;
      }
      const data = await this._req("POST", "/api/agent-wallet", body);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 7: fundAgenticWallet
  // -----------------------------------------------------------------------

  async fundAgenticWallet(walletId: string, amountCents: number): Promise<PiToolResult> {
    try {
      const id = validateUuid(walletId, "walletId");
      const amount = Math.floor(Number(amountCents));
      if (isNaN(amount) || amount < 1 || amount > 1000000) return err("amountCents must be between 1 and 1,000,000");
      const data = await this._req("POST", `/api/agent-wallet/${encodeURIComponent(id)}/fund`, { amountCents: amount });
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 8: checkAgenticBalance
  // -----------------------------------------------------------------------

  async checkAgenticBalance(walletId: string): Promise<PiToolResult> {
    try {
      const id = validateUuid(walletId, "walletId");
      const data = await this._req("GET", `/api/agent-wallet/${encodeURIComponent(id)}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 9: listAgenticWallets
  // -----------------------------------------------------------------------

  async listAgenticWallets(): Promise<PiToolResult> {
    try {
      const data = await this._req("GET", "/api/agent-wallet");
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 10: agenticTransactions
  // -----------------------------------------------------------------------

  async agenticTransactions(walletId: string, limit = 20): Promise<PiToolResult> {
    try {
      const id = validateUuid(walletId, "walletId");
      const rawLim = Number(limit);
      if (!Number.isFinite(rawLim)) return err("limit must be a finite number");
      const lim = Math.max(1, Math.min(100, Math.floor(rawLim)));
      const data = await this._req("GET", `/api/agent-wallet/${encodeURIComponent(id)}/transactions?limit=${lim}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 11: freezeAgenticWallet
  // -----------------------------------------------------------------------

  async freezeAgenticWallet(walletId: string): Promise<PiToolResult> {
    try {
      const id = validateUuid(walletId, "walletId");
      const data = await this._req("POST", `/api/agent-wallet/${encodeURIComponent(id)}/freeze`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 12: unfreezeAgenticWallet
  // -----------------------------------------------------------------------

  async unfreezeAgenticWallet(walletId: string): Promise<PiToolResult> {
    try {
      const id = validateUuid(walletId, "walletId");
      const data = await this._req("POST", `/api/agent-wallet/${encodeURIComponent(id)}/unfreeze`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 13: deleteAgenticWallet
  // -----------------------------------------------------------------------

  async deleteAgenticWallet(walletId: string): Promise<PiToolResult> {
    try {
      const id = validateUuid(walletId, "walletId");
      const data = await this._req("DELETE", `/api/agent-wallet/${encodeURIComponent(id)}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 14: createTeam
  // -----------------------------------------------------------------------

  async createTeam(name: string, maxMembers = 10): Promise<PiToolResult> {
    try {
      const nameErr = validateLabel(name, "name");
      if (nameErr) return err(nameErr);
      const max = Math.max(1, Math.min(100, Math.floor(Number(maxMembers))));
      if (isNaN(max)) return err("maxMembers must be a number between 1 and 100");
      const data = await this._req("POST", "/api/teams", { name: name.trim(), maxMembers: max });
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 15: listTeams
  // -----------------------------------------------------------------------

  async listTeams(limit = 20): Promise<PiToolResult> {
    try {
      const rawLim = Number(limit);
      if (!Number.isFinite(rawLim)) return err("limit must be a finite number");
      const lim = Math.max(1, Math.min(100, Math.floor(rawLim)));
      const data = await this._req("GET", `/api/teams?limit=${lim}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 16: teamDetails
  // -----------------------------------------------------------------------

  async teamDetails(teamId: string): Promise<PiToolResult> {
    try {
      const id = validateUuid(teamId, "teamId");
      const data = await this._req("GET", `/api/teams/${encodeURIComponent(id)}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 17: teamFund
  // -----------------------------------------------------------------------

  async teamFund(teamId: string, amountCents: number): Promise<PiToolResult> {
    try {
      const id = validateUuid(teamId, "teamId");
      const amount = Math.floor(Number(amountCents));
      if (isNaN(amount) || amount < 1 || amount > 1000000) return err("amountCents must be between 1 and 1,000,000");
      const data = await this._req("POST", `/api/teams/${encodeURIComponent(id)}/wallet/fund`, { amountCents: amount });
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 18: teamCreateApiKey
  // -----------------------------------------------------------------------

  async teamCreateApiKey(teamId: string, label: string): Promise<PiToolResult> {
    try {
      const id = validateUuid(teamId, "teamId");
      const labelErr = validateLabel(label);
      if (labelErr) return err(labelErr);
      const data = await this._req("POST", `/api/teams/${encodeURIComponent(id)}/keys`, { label: label.trim() });
      return ok(JSON.stringify(data, null, 2) + "\n\nIMPORTANT: Store this API key securely — it will not be shown again.");
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 19: teamUsage
  // -----------------------------------------------------------------------

  async teamUsage(teamId: string, days = 30): Promise<PiToolResult> {
    try {
      const id = validateUuid(teamId, "teamId");
      const rawDays = Number(days);
      if (!Number.isFinite(rawDays)) return err("days must be a finite number between 1 and 365");
      const d = Math.max(1, Math.min(365, Math.floor(rawDays)));
      const until = new Date().toISOString();
      const since = new Date(Date.now() - d * 86400000).toISOString();
      const data = await this._req("GET", `/api/teams/${encodeURIComponent(id)}/usage?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 20: updateTeam
  // -----------------------------------------------------------------------

  async updateTeam(teamId: string, name?: string, maxMembers?: number): Promise<PiToolResult> {
    try {
      const id = validateUuid(teamId, "teamId");
      const body: Record<string, unknown> = {};
      if (name !== undefined) {
        const nameErr = validateLabel(name, "name");
        if (nameErr) return err(nameErr);
        body.name = name.trim();
      }
      if (maxMembers !== undefined) {
        const max = Math.max(1, Math.min(100, Math.floor(Number(maxMembers))));
        if (isNaN(max)) return err("maxMembers must be a number");
        body.maxMembers = max;
      }
      if (!Object.keys(body).length) return err("At least one of name or maxMembers must be provided");
      const data = await this._req("PATCH", `/api/teams/${encodeURIComponent(id)}`, body);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 21: updateTeamMemberRole
  // -----------------------------------------------------------------------

  async updateTeamMemberRole(teamId: string, userId: string, role: string): Promise<PiToolResult> {
    try {
      const tid = validateUuid(teamId, "teamId");
      const uid = validateUuid(userId, "userId");
      if (!["admin", "member"].includes(role)) return err("role must be 'admin' or 'member'");
      const data = await this._req("PATCH", `/api/teams/${tid}/members/${uid}`, { role });
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 22: topupPaypal
  // -----------------------------------------------------------------------

  async topupPaypal(amountCents: number): Promise<PiToolResult> {
    try {
      const amount = Math.floor(Number(amountCents));
      if (isNaN(amount) || amount < 500 || amount > 1000000) return err("amountCents must be between 500 ($5.00) and 1,000,000 ($10,000.00)");
      const data = await this._req("POST", "/api/wallet/topup/paypal", { amountCents: amount });
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 23: topupStripe
  // -----------------------------------------------------------------------

  async topupStripe(amountCents: number): Promise<PiToolResult> {
    try {
      const amount = Math.floor(Number(amountCents));
      if (isNaN(amount) || amount < 500 || amount > 1000000) return err("amountCents must be between 500 ($5.00) and 1,000,000 ($10,000.00)");
      const data = await this._req("POST", "/api/wallet/topup/stripe", { amountCents: amount });
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 24: topupCrypto
  // -----------------------------------------------------------------------

  async topupCrypto(amountUsd: number, currency: string): Promise<PiToolResult> {
    try {
      // M-2: Require whole-number dollars to avoid silent truncation (5.9 → 5)
      const rawAmount = Number(amountUsd);
      if (!Number.isInteger(rawAmount) || rawAmount < 5 || rawAmount > 10000)
        return err("amountUsd must be a whole number between 5 and 10,000");
      const amount = rawAmount;
      const VALID_CURRENCIES = ["BTC", "ETH", "LTC", "XMR", "ZEC", "USDC", "SOL", "USDT", "DAI", "BNB", "LINK"];
      const cur = (currency || "").toUpperCase().trim();
      if (!VALID_CURRENCIES.includes(cur)) return err(`currency must be one of: ${VALID_CURRENCIES.join(", ")}`);
      const data = await this._req("POST", "/api/wallet/topup/crypto", { amountUsd: amount, currency: cur });
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 25: x402Info
  // -----------------------------------------------------------------------

  async x402Info(): Promise<PiToolResult> {
    try {
      const data = await this._req("GET", "/api/wallet/x402/info");
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 26: updateWalletPolicy
  // -----------------------------------------------------------------------

  async updateWalletPolicy(walletId: string, dailyLimitCents?: number, allowedDomains?: string[]): Promise<PiToolResult> {
    try {
      const id = validateUuid(walletId, "walletId");
      const body: Record<string, unknown> = {};
      if (dailyLimitCents !== undefined) {
        const limit = Math.floor(Number(dailyLimitCents));
        if (isNaN(limit) || limit < 0 || limit > 1000000) return err("dailyLimitCents must be between 0 and 1,000,000");
        body.dailyLimitCents = limit;
      }
      if (allowedDomains !== undefined) {
        if (!Array.isArray(allowedDomains)) return err("allowedDomains must be an array of strings");
        if (allowedDomains.length > 100) return err("allowedDomains must have at most 100 entries");
        for (let i = 0; i < allowedDomains.length; i++) {
          if (typeof allowedDomains[i] !== "string") return err(`allowedDomains[${i}] must be a string`);
          if ((allowedDomains[i] as string).length > 253) return err(`allowedDomains[${i}] exceeds 253 characters`);
          if (/[\x00-\x1f\x7f]/.test(allowedDomains[i] as string)) return err(`allowedDomains[${i}] contains invalid characters`);
        }
        body.allowedDomains = allowedDomains.map((d) => String(d).trim().toLowerCase());
      }
      if (!Object.keys(body).length) return err("At least one of dailyLimitCents or allowedDomains must be provided");
      const data = await this._req("PATCH", `/api/agent-wallet/${encodeURIComponent(id)}/policy`, body);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Unauthenticated request helper (register, login, verify-email)
  // -----------------------------------------------------------------------

  private async _rawRequest<T = unknown>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "dominusnode-pi/1.0.0",
    };
    if (this.agentSecret) {
      headers["X-DominusNode-Agent"] = "mcp";
      headers["X-DominusNode-Agent-Secret"] = this.agentSecret;
    }
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error" };
    if (body && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new Error(`API request failed: ${safeError(e)}`);
    }
    let rawText = "";
    if (res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            reader.cancel().catch(() => {});
            throw new Error("API response too large");
          }
          chunks.push(value);
        }
      } catch (e) {
        reader.cancel().catch(() => {});
        throw e;
      }
      rawText = Buffer.concat(chunks).toString("utf-8");
    }
    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const parsed = JSON.parse(rawText);
        stripDangerousKeys(parsed);
        const detail = parsed.error ?? parsed.message;
        if (detail) msg = `API error ${res.status}: ${scrubCredentials(String(detail))}`;
      } catch { if (rawText) msg = `API error ${res.status}: ${scrubCredentials(rawText.slice(0, 200))}`; }
      throw new Error(msg);
    }
    if (!rawText || !rawText.trim()) return {} as T;
    try {
      const parsed = JSON.parse(rawText);
      stripDangerousKeys(parsed);
      return parsed as T;
    } catch {
      throw new Error("Failed to parse API response as JSON");
    }
  }

  // -----------------------------------------------------------------------
  // Validation helpers for account tools
  // -----------------------------------------------------------------------

  private static readonly EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  private static validateEmail(email: string): string {
    const trimmed = email.trim();
    if (!trimmed || !DominusNodeToolkit.EMAIL_RE.test(trimmed)) {
      throw new Error("Invalid email address.");
    }
    if (trimmed.length > 254) {
      throw new Error("Email address too long (max 254 characters).");
    }
    return trimmed;
  }

  private static validatePassword(password: string): string {
    if (!password || password.length < 8) {
      throw new Error("Password must be at least 8 characters.");
    }
    if (password.length > 128) {
      throw new Error("Password must be at most 128 characters.");
    }
    return password;
  }

  // -----------------------------------------------------------------------
  // Tool 27: getProxyStatus
  // -----------------------------------------------------------------------

  async getProxyStatus(): Promise<PiToolResult> {
    try {
      const data = await this._req("GET", "/api/proxy/status");
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 28: getTransactions
  // -----------------------------------------------------------------------

  async getTransactions(limit = 20): Promise<PiToolResult> {
    try {
      const rawLim = Number(limit);
      if (!Number.isFinite(rawLim)) return err("limit must be a finite number");
      const lim = Math.max(1, Math.min(100, Math.floor(rawLim)));
      const data = await this._req("GET", `/api/wallet/transactions?limit=${lim}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 29: getForecast
  // -----------------------------------------------------------------------

  async getForecast(): Promise<PiToolResult> {
    try {
      const data = await this._req("GET", "/api/wallet/forecast");
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 30: checkPayment
  // -----------------------------------------------------------------------

  async checkPayment(invoiceId: string): Promise<PiToolResult> {
    try {
      const id = validateUuid(invoiceId, "invoiceId");
      const data = await this._req("GET", `/api/wallet/topup/crypto/${encodeURIComponent(id)}/status`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 31: getDailyUsage
  // -----------------------------------------------------------------------

  async getDailyUsage(days = 7): Promise<PiToolResult> {
    try {
      const rawDays = Number(days);
      if (!Number.isFinite(rawDays)) return err("days must be a finite number between 1 and 365");
      const d = Math.max(1, Math.min(365, Math.floor(rawDays)));
      const data = await this._req("GET", `/api/usage/daily?days=${d}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 32: getTopHosts
  // -----------------------------------------------------------------------

  async getTopHosts(limit = 10): Promise<PiToolResult> {
    try {
      const rawLim = Number(limit);
      if (!Number.isFinite(rawLim)) return err("limit must be a finite number");
      const lim = Math.max(1, Math.min(100, Math.floor(rawLim)));
      const data = await this._req("GET", `/api/usage/top-hosts?limit=${lim}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 33: register
  // -----------------------------------------------------------------------

  async register(email: string, password: string): Promise<PiToolResult> {
    try {
      const safeEmail = DominusNodeToolkit.validateEmail(email);
      const safePassword = DominusNodeToolkit.validatePassword(password);
      // Solve PoW for CAPTCHA-free registration
      const pow = await this._solvePoW();
      const regBody: Record<string, unknown> = { email: safeEmail, password: safePassword };
      if (pow) regBody.pow = pow;
      const data = await this._rawRequest("POST", "/api/auth/register", regBody);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 34: login
  // -----------------------------------------------------------------------

  async login(email: string, password: string): Promise<PiToolResult> {
    try {
      const safeEmail = DominusNodeToolkit.validateEmail(email);
      const safePassword = DominusNodeToolkit.validatePassword(password);
      const data = await this._rawRequest("POST", "/api/auth/login", { email: safeEmail, password: safePassword });
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 35: getAccountInfo
  // -----------------------------------------------------------------------

  async getAccountInfo(): Promise<PiToolResult> {
    try {
      const data = await this._req("GET", "/api/auth/me");
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 36: verifyEmail
  // -----------------------------------------------------------------------

  async verifyEmail(token: string): Promise<PiToolResult> {
    try {
      if (!token || typeof token !== "string" || token.trim().length === 0) {
        return err("Verification token is required.");
      }
      if (/[\x00-\x1f\x7f]/.test(token)) {
        return err("Token contains invalid control characters.");
      }
      const data = await this._rawRequest("POST", "/api/auth/verify-email", { token: token.trim() });
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 37: resendVerification
  // -----------------------------------------------------------------------

  async resendVerification(): Promise<PiToolResult> {
    try {
      const data = await this._req("POST", "/api/auth/resend-verification");
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 38: updatePassword
  // -----------------------------------------------------------------------

  async updatePassword(currentPassword: string, newPassword: string): Promise<PiToolResult> {
    try {
      DominusNodeToolkit.validatePassword(currentPassword);
      DominusNodeToolkit.validatePassword(newPassword);
      const data = await this._req("POST", "/api/auth/change-password", { currentPassword, newPassword });
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 39: listKeys
  // -----------------------------------------------------------------------

  async listKeys(): Promise<PiToolResult> {
    try {
      const data = await this._req("GET", "/api/keys");
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 40: createKey
  // -----------------------------------------------------------------------

  async createKey(label: string): Promise<PiToolResult> {
    try {
      const labelErr = validateLabel(label);
      if (labelErr) return err(labelErr);
      const data = await this._req("POST", "/api/keys", { label: label.trim() });
      return ok(JSON.stringify(data, null, 2) + "\n\nIMPORTANT: Store this API key securely — it will not be shown again.");
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 41: revokeKey
  // -----------------------------------------------------------------------

  async revokeKey(keyId: string): Promise<PiToolResult> {
    try {
      const id = validateUuid(keyId, "keyId");
      const data = await this._req("DELETE", `/api/keys/${encodeURIComponent(id)}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 42: getPlan
  // -----------------------------------------------------------------------

  async getPlan(): Promise<PiToolResult> {
    try {
      const data = await this._req("GET", "/api/plans/user/plan");
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 43: listPlans
  // -----------------------------------------------------------------------

  async listPlans(): Promise<PiToolResult> {
    try {
      const data = await this._req("GET", "/api/plans");
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 44: changePlan
  // -----------------------------------------------------------------------

  async changePlan(planId: string): Promise<PiToolResult> {
    try {
      const id = validateUuid(planId, "planId");
      const data = await this._req("PUT", "/api/plans/user/plan", { planId: id });
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 45: teamDelete
  // -----------------------------------------------------------------------

  async teamDelete(teamId: string): Promise<PiToolResult> {
    try {
      const id = validateUuid(teamId, "teamId");
      const data = await this._req("DELETE", `/api/teams/${encodeURIComponent(id)}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 46: teamRevokeKey
  // -----------------------------------------------------------------------

  async teamRevokeKey(teamId: string, keyId: string): Promise<PiToolResult> {
    try {
      const tid = validateUuid(teamId, "teamId");
      const kid = validateUuid(keyId, "keyId");
      const data = await this._req("DELETE", `/api/teams/${encodeURIComponent(tid)}/keys/${encodeURIComponent(kid)}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 47: teamListKeys
  // -----------------------------------------------------------------------

  async teamListKeys(teamId: string): Promise<PiToolResult> {
    try {
      const id = validateUuid(teamId, "teamId");
      const data = await this._req("GET", `/api/teams/${encodeURIComponent(id)}/keys`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 48: teamListMembers
  // -----------------------------------------------------------------------

  async teamListMembers(teamId: string): Promise<PiToolResult> {
    try {
      const id = validateUuid(teamId, "teamId");
      const data = await this._req("GET", `/api/teams/${encodeURIComponent(id)}/members`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 49: teamAddMember
  // -----------------------------------------------------------------------

  async teamAddMember(teamId: string, userId: string, role = "member"): Promise<PiToolResult> {
    try {
      const tid = validateUuid(teamId, "teamId");
      const uid = validateUuid(userId, "userId");
      if (role !== "member" && role !== "admin") return err("role must be 'member' or 'admin'");
      const data = await this._req("POST", `/api/teams/${encodeURIComponent(tid)}/members`, { userId: uid, role });
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 50: teamRemoveMember
  // -----------------------------------------------------------------------

  async teamRemoveMember(teamId: string, userId: string): Promise<PiToolResult> {
    try {
      const tid = validateUuid(teamId, "teamId");
      const uid = validateUuid(userId, "userId");
      const data = await this._req("DELETE", `/api/teams/${encodeURIComponent(tid)}/members/${encodeURIComponent(uid)}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 51: teamInviteMember
  // -----------------------------------------------------------------------

  async teamInviteMember(teamId: string, email: string, role = "member"): Promise<PiToolResult> {
    try {
      const id = validateUuid(teamId, "teamId");
      const safeEmail = DominusNodeToolkit.validateEmail(email);
      if (role !== "member" && role !== "admin") return err("role must be 'member' or 'admin'");
      const data = await this._req("POST", `/api/teams/${encodeURIComponent(id)}/invites`, { email: safeEmail, role });
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 52: teamListInvites
  // -----------------------------------------------------------------------

  async teamListInvites(teamId: string): Promise<PiToolResult> {
    try {
      const id = validateUuid(teamId, "teamId");
      const data = await this._req("GET", `/api/teams/${encodeURIComponent(id)}/invites`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }

  // -----------------------------------------------------------------------
  // Tool 53: teamCancelInvite
  // -----------------------------------------------------------------------

  async teamCancelInvite(teamId: string, inviteId: string): Promise<PiToolResult> {
    try {
      const tid = validateUuid(teamId, "teamId");
      const iid = validateUuid(inviteId, "inviteId");
      const data = await this._req("DELETE", `/api/teams/${encodeURIComponent(tid)}/invites/${encodeURIComponent(iid)}`);
      return ok(JSON.stringify(data, null, 2));
    } catch (e) { return err(e); }
  }
}
