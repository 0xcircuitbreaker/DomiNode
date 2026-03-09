/**
 * Dominus Node Flowise Toolkit
 *
 * Provides 53 LangChain-compatible DynamicStructuredTool instances for use
 * inside Flowise AI workflows. Covers proxied fetching, wallet management,
 * agentic wallets, teams, Stripe/PayPal/crypto top-up, x402 micropayment info,
 * account management, API key management, plans, sessions, and usage analytics.
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
 */

// @ts-ignore
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
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

/** OFAC sanctioned countries -- must never be used as geo-targeting destinations. */
export const SANCTIONED_COUNTRIES = new Set(["CU", "IR", "KP", "RU", "SY"]);

/** ISO 3166-1 alpha-2 country code pattern. */
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

/** UUID v4 pattern for wallet/team IDs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Skips check if the hostname is already an IP literal.
 */
export async function checkDnsRebinding(hostname: string): Promise<void> {
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

  constructor(options: DominusNodeToolkitOptions = {}) {
    this.apiKey = options.apiKey || process.env.DOMINUSNODE_API_KEY || "";
    this.baseUrl = (options.baseUrl || process.env.DOMINUSNODE_BASE_URL || "https://api.dominusnode.com").replace(/\/+$/, "");
    this.proxyHost = options.proxyHost || process.env.DOMINUSNODE_PROXY_HOST || "proxy.dominusnode.com";
    const portVal = Number(options.proxyPort || process.env.DOMINUSNODE_PROXY_PORT || 8080);
    this.proxyPort = isNaN(portVal) || portVal < 1 || portVal > 65535 ? 8080 : portVal;
    this.timeout = options.timeout || 30000;
    this.agentSecret = options.agentSecret || process.env.DOMINUSNODE_AGENT_SECRET;
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
    if (!this.apiKey) {
      throw new Error(
        "Dominus Node API key is required. Pass apiKey in options or set DOMINUSNODE_API_KEY env var.",
      );
    }
    if (!this.apiKey.startsWith("dn_live_") && !this.apiKey.startsWith("dn_test_")) {
      throw new Error('DOMINUSNODE_API_KEY must start with "dn_live_" or "dn_test_".');
    }

    const authHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "dominusnode-flowise/1.0.0",
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
      const text = await res.text().catch(() => "");
      throw new Error(`Auth failed (${res.status}): ${scrubCredentials(text.slice(0, 500))}`);
    }

    const data = (await res.json()) as { token: string };
    stripDangerousKeys(data);
    this.token = data.token;
    // JWT expires in 15 min, refresh at 14 min for safety
    this.tokenExpiresAt = Date.now() + 14 * 60 * 1000;
    return this.token;
  }

  private async _ensureAuth(): Promise<void> {
    if (!this.token || Date.now() >= this.tokenExpiresAt) {
      await this._authenticate();
    }
  }

  // -----------------------------------------------------------------------
  // API request helpers
  // -----------------------------------------------------------------------

  private async _apiRequest<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    await this._ensureAuth();

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "User-Agent": "dominusnode-flowise/1.0.0",
    };
    if (this.agentSecret) {
      headers["X-DominusNode-Agent"] = "mcp";
      headers["X-DominusNode-Agent-Secret"] = this.agentSecret;
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

  private async _requestWithRetry<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this._apiRequest<T>(method, path, body);
    } catch (err) {
      if (err instanceof Error && err.message.includes("401")) {
        this.token = null;
        this.tokenExpiresAt = 0;
        return await this._apiRequest<T>(method, path, body);
      }
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Unauthenticated request helper (register, login, verifyEmail)
  // -----------------------------------------------------------------------

  private async _unauthenticatedRequest<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "dominusnode-flowise/1.0.0",
    };
    if (this.agentSecret) {
      headers["X-DominusNode-Agent"] = "mcp";
      headers["X-DominusNode-Agent-Secret"] = this.agentSecret;
    }

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    };

    if (body) {
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new Error(`Request failed: ${safeError(err)}`);
    }

    let rawText: string;
    try {
      rawText = await res.text();
    } catch {
      rawText = "";
    }

    if (new TextEncoder().encode(rawText).length > MAX_RESPONSE_BYTES) {
      throw new Error("Response too large");
    }

    if (!res.ok) {
      let errorMsg = `Error ${res.status}`;
      if (rawText) {
        try {
          const parsed = JSON.parse(rawText);
          stripDangerousKeys(parsed);
          if (parsed.error) {
            errorMsg = `Error ${res.status}: ${scrubCredentials(String(parsed.error))}`;
          } else if (parsed.message) {
            errorMsg = `Error ${res.status}: ${scrubCredentials(String(parsed.message))}`;
          }
        } catch {
          errorMsg = `Error ${res.status}: ${scrubCredentials(rawText.slice(0, 200))}`;
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
      throw new Error("Failed to parse response as JSON");
    }
  }

  // -----------------------------------------------------------------------
  // Tool 1: proxiedFetch
  // -----------------------------------------------------------------------

  async proxiedFetch(
    url: string,
    method: string = "GET",
    country?: string,
    proxyType: string = "dc",
  ): Promise<string> {
    try {
      if (!url) return "Error: url parameter is required.";

      const parsedUrl = validateTargetUrl(url);
      await checkDnsRebinding(parsedUrl.hostname);
      const validCountry = validateCountry(country);

      const methodUpper = (method || "GET").toUpperCase();
      const ALLOWED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
      if (!ALLOWED_METHODS.has(methodUpper)) {
        return `Error: HTTP method "${methodUpper}" is not allowed. Only GET, HEAD, and OPTIONS are permitted.`;
      }

      if (proxyType !== "dc" && proxyType !== "residential" && proxyType !== "auto") {
        return "Error: proxyType must be 'dc', 'residential', or 'auto'.";
      }

      const apiKey = this.apiKey;
      if (!apiKey) return "Error: API key is required for proxied fetch.";

      const parts: string[] = [];
      if (proxyType && proxyType !== "auto") parts.push(proxyType);
      if (validCountry) parts.push(`country-${validCountry.toUpperCase()}`);
      const username = parts.length > 0 ? parts.join("-") : "auto";
      const proxyAuth = "Basic " + Buffer.from(`${username}:${apiKey}`).toString("base64");

      const parsed = new URL(url);

      const result = await new Promise<{
        status: number;
        headers: Record<string, string>;
        body: string;
      }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Proxy request timed out")), REQUEST_TIMEOUT_MS);

        if (parsed.protocol === "https:") {
          const connectHost = parsed.hostname.includes(":")
            ? `[${parsed.hostname}]`
            : parsed.hostname;
          const connectReq = http.request({
            hostname: this.proxyHost,
            port: this.proxyPort,
            method: "CONNECT",
            path: `${connectHost}:${parsed.port || 443}`,
            headers: {
              "Proxy-Authorization": proxyAuth,
              Host: `${connectHost}:${parsed.port || 443}`,
            },
          });

          connectReq.on("connect", (_res, sock) => {
            if (_res.statusCode !== 200) {
              clearTimeout(timer);
              sock.destroy();
              reject(new Error(`CONNECT failed: ${_res.statusCode}`));
              return;
            }
            const tlsSock = tls.connect(
              {
                host: parsed.hostname,
                socket: sock as net.Socket,
                servername: parsed.hostname,
                minVersion: "TLSv1.2",
              },
              () => {
                const reqLine =
                  `${methodUpper} ${parsed.pathname + parsed.search} HTTP/1.1\r\n` +
                  `Host: ${parsed.host}\r\n` +
                  `User-Agent: dominusnode-flowise/1.0.0\r\n` +
                  `Connection: close\r\n\r\n`;
                tlsSock.write(reqLine);

                const chunks: Buffer[] = [];
                let bytes = 0;
                tlsSock.on("data", (c: Buffer) => {
                  bytes += c.length;
                  if (bytes <= MAX_PROXY_RESPONSE_BYTES + 16384) chunks.push(c);
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
                  const respBody = raw.substring(hEnd + 4).substring(0, MAX_PROXY_RESPONSE_BYTES);
                  const sm = hdr.split("\r\n")[0].match(/^HTTP\/\d\.\d\s+(\d+)/);
                  const hdrs: Record<string, string> = {};
                  for (const l of hdr.split("\r\n").slice(1)) {
                    const ci = l.indexOf(":");
                    if (ci > 0) hdrs[l.substring(0, ci).trim().toLowerCase()] = l.substring(ci + 1).trim();
                  }
                  resolve({
                    status: sm ? parseInt(sm[1], 10) : 0,
                    headers: hdrs,
                    body: respBody,
                  });
                };
                tlsSock.on("end", fin);
                tlsSock.on("close", fin);
                tlsSock.on("error", (e) => {
                  clearTimeout(timer);
                  reject(e);
                });
              },
            );
            tlsSock.on("error", (e) => {
              clearTimeout(timer);
              reject(e);
            });
          });

          connectReq.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
          connectReq.end();
        } else {
          // HTTP (non-TLS)
          const req = http.request(
            {
              hostname: this.proxyHost,
              port: this.proxyPort,
              method: methodUpper,
              path: url,
              headers: {
                "Proxy-Authorization": proxyAuth,
                Host: parsed.host ?? "",
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              let bytes = 0;
              res.on("data", (c: Buffer) => {
                bytes += c.length;
                if (bytes <= MAX_PROXY_RESPONSE_BYTES) chunks.push(c);
              });
              let done = false;
              const fin = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                const respBody = Buffer.concat(chunks).toString("utf-8").substring(0, MAX_PROXY_RESPONSE_BYTES);
                const hdrs: Record<string, string> = {};
                for (const [k, v] of Object.entries(res.headers)) {
                  if (v) hdrs[k] = Array.isArray(v) ? v.join(", ") : v;
                }
                resolve({ status: res.statusCode ?? 0, headers: hdrs, body: respBody });
              };
              res.on("end", fin);
              res.on("close", fin);
              res.on("error", (e) => {
                clearTimeout(timer);
                reject(e);
              });
            },
          );
          req.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
          req.end();
        }
      });

      const lines = [
        `HTTP ${result.status}`,
        `Pool: ${proxyType} | Country: ${validCountry ?? "auto"}`,
        "",
      ];

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
  }

  // -----------------------------------------------------------------------
  // Tool 2: checkBalance
  // -----------------------------------------------------------------------

  async checkBalance(): Promise<string> {
    try {
      const data = await this._requestWithRetry<{
        balanceCents: number;
        balanceUsd: number;
      }>("GET", "/api/wallet");

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
  }

  // -----------------------------------------------------------------------
  // Tool 3: checkUsage
  // -----------------------------------------------------------------------

  async checkUsage(days: number = 30): Promise<string> {
    try {
      const d = Math.min(Math.max(Math.floor(days), 1), 365);
      const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
      const until = new Date().toISOString();

      const data = await this._requestWithRetry<{
        summary: {
          totalBytes: number;
          totalCostUsd: number;
          requestCount: number;
        };
      }>("GET", `/api/usage?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`);

      const s = data.summary;
      return [
        `Usage Summary (last ${d} days):`,
        `  Total Bandwidth: ${formatBytes(s.totalBytes)}`,
        `  Total Cost: $${s.totalCostUsd.toFixed(2)}`,
        `  Total Requests: ${s.requestCount}`,
        "",
        "Use check_balance to see remaining funds.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 4: getProxyConfig
  // -----------------------------------------------------------------------

  async getProxyConfig(): Promise<string> {
    try {
      const data = await this._requestWithRetry<{
        pools: Array<{
          name: string;
          type: string;
          pricePerGbCents: number;
          countries?: string[];
        }>;
        httpProxyPort: number;
        socks5ProxyPort: number;
        proxyHost: string;
      }>("GET", "/api/proxy/config");

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
            lines.push(
              `    Countries: ${pool.countries.slice(0, 20).join(", ")}${pool.countries.length > 20 ? "..." : ""}`,
            );
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
  }

  // -----------------------------------------------------------------------
  // Tool 5: listSessions
  // -----------------------------------------------------------------------

  async listSessions(): Promise<string> {
    try {
      const data = await this._requestWithRetry<{
        sessions: Array<{
          id: string;
          status: string;
          startedAt: string;
          targetHost?: string;
          bytesIn?: number;
          bytesOut?: number;
        }>;
      }>("GET", "/api/sessions/active");

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
        lines.push(
          `  ${s.id.substring(0, 8)}... | ${s.status} | Since: ${s.startedAt}${target}${bw}`,
        );
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 6: createAgenticWallet
  // -----------------------------------------------------------------------

  async createAgenticWallet(
    label: string,
    spendingLimitCents: number = 10000,
    dailyLimitCents?: number,
    allowedDomains?: string[],
  ): Promise<string> {
    try {
      if (!label || label.trim().length === 0 || label.length > 100) {
        return "Error: label is required and must be 1-100 characters.";
      }
      if (/[\x00-\x1f\x7f]/.test(label)) {
        return "Error: label contains invalid control characters.";
      }

      const limitCents = Math.min(Math.max(Math.floor(spendingLimitCents), 0), 1000000);

      const body: Record<string, unknown> = {
        label: label.trim(),
        spendingLimitCents: limitCents,
      };

      if (dailyLimitCents !== undefined && dailyLimitCents !== null) {
        if (!Number.isInteger(dailyLimitCents) || dailyLimitCents < 1 || dailyLimitCents > 1000000) {
          return "Error: daily_limit_cents must be an integer between 1 and 1,000,000.";
        }
        body.dailyLimitCents = dailyLimitCents;
      }

      if (allowedDomains !== undefined && allowedDomains !== null) {
        if (!Array.isArray(allowedDomains) || allowedDomains.length > 100) {
          return "Error: allowed_domains must be an array of at most 100 entries.";
        }
        for (const d of allowedDomains) {
          if (typeof d !== "string" || d.length > 253) {
            return `Error: invalid domain "${d}". Must be a string of at most 253 characters.`;
          }
        }
        body.allowedDomains = allowedDomains;
      }

      const data = await this._requestWithRetry<{
        id: string;
        label: string;
        balanceCents: number;
        spendingLimitCents: number;
        dailyLimitCents: number | null;
        allowedDomains: string[] | null;
        status: string;
        createdAt: string;
      }>("POST", "/api/agent-wallet", body);

      const lines = [
        "Agentic Wallet Created",
        "",
        `Wallet ID: ${data.id}`,
        `Label: ${data.label}`,
        `Balance: ${formatCents(data.balanceCents)}`,
        `Spending Limit: ${data.spendingLimitCents > 0 ? `${formatCents(data.spendingLimitCents)} per transaction` : "No limit"}`,
      ];
      if (data.dailyLimitCents != null) {
        lines.push(`Daily Limit: ${formatCents(data.dailyLimitCents)}`);
      }
      if (data.allowedDomains && data.allowedDomains.length > 0) {
        lines.push(`Allowed Domains: ${data.allowedDomains.join(", ")}`);
      }
      lines.push(`Status: ${data.status}`, "", "Next: Use fund_agentic_wallet to add funds from your main wallet.");

      return lines.join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 6b: updateWalletPolicy
  // -----------------------------------------------------------------------

  async updateWalletPolicy(
    walletId: string,
    dailyLimitCents?: number | null,
    allowedDomains?: string[] | null,
  ): Promise<string> {
    try {
      const wid = validateUuid(walletId, "wallet_id");

      const body: Record<string, unknown> = {};

      if (dailyLimitCents !== undefined) {
        if (dailyLimitCents === null) {
          body.dailyLimitCents = null;
        } else {
          if (!Number.isInteger(dailyLimitCents) || dailyLimitCents < 1 || dailyLimitCents > 1000000) {
            return "Error: daily_limit_cents must be an integer between 1 and 1,000,000, or null to remove.";
          }
          body.dailyLimitCents = dailyLimitCents;
        }
      }

      if (allowedDomains !== undefined) {
        if (allowedDomains === null) {
          body.allowedDomains = null;
        } else {
          if (!Array.isArray(allowedDomains) || allowedDomains.length > 100) {
            return "Error: allowed_domains must be an array of at most 100 entries, or null to remove.";
          }
          for (const d of allowedDomains) {
            if (typeof d !== "string" || d.length > 253) {
              return `Error: invalid domain "${d}". Must be a string of at most 253 characters.`;
            }
          }
          body.allowedDomains = allowedDomains;
        }
      }

      if (Object.keys(body).length === 0) {
        return "Error: at least one of daily_limit_cents or allowed_domains must be provided.";
      }

      const data = await this._requestWithRetry<{
        id: string;
        label: string;
        dailyLimitCents: number | null;
        allowedDomains: string[] | null;
        status: string;
      }>("PATCH", `/api/agent-wallet/${encodeURIComponent(wid)}/policy`, body);

      const lines = [
        "Wallet Policy Updated",
        "",
        `Wallet ID: ${data.id}`,
        `Label: ${data.label}`,
      ];
      if (data.dailyLimitCents != null) {
        lines.push(`Daily Limit: ${formatCents(data.dailyLimitCents)}`);
      } else {
        lines.push("Daily Limit: None");
      }
      if (data.allowedDomains && data.allowedDomains.length > 0) {
        lines.push(`Allowed Domains: ${data.allowedDomains.join(", ")}`);
      } else {
        lines.push("Allowed Domains: None (unrestricted)");
      }
      lines.push(`Status: ${data.status}`);

      return lines.join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 7: fundAgenticWallet
  // -----------------------------------------------------------------------

  async fundAgenticWallet(walletId: string, amountCents: number): Promise<string> {
    try {
      const wid = validateUuid(walletId, "wallet_id");
      if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > 1000000) {
        return "Error: amount_cents must be an integer between 100 ($1) and 1000000 ($10,000).";
      }

      const data = await this._requestWithRetry<{
        transaction: {
          id: string;
          walletId: string;
          type: string;
          amountCents: number;
          description: string;
          createdAt: string;
        };
      }>("POST", `/api/agent-wallet/${encodeURIComponent(wid)}/fund`, {
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
        "Funds transferred from main wallet. Use check_agentic_balance to verify.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 8: agenticWalletBalance
  // -----------------------------------------------------------------------

  async agenticWalletBalance(walletId: string): Promise<string> {
    try {
      const wid = validateUuid(walletId, "wallet_id");

      const data = await this._requestWithRetry<{
        id: string;
        label: string;
        balanceCents: number;
        spendingLimitCents: number;
        status: string;
        createdAt: string;
      }>("GET", `/api/agent-wallet/${encodeURIComponent(wid)}`);

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
  }

  // -----------------------------------------------------------------------
  // Tool 9: listAgenticWallets
  // -----------------------------------------------------------------------

  async listAgenticWallets(): Promise<string> {
    try {
      const data = await this._requestWithRetry<{
        wallets: Array<{
          id: string;
          label: string;
          balanceCents: number;
          spendingLimitCents: number;
          status: string;
          createdAt: string;
        }>;
      }>("GET", "/api/agent-wallet");

      const wallets = data.wallets ?? [];
      if (wallets.length === 0) {
        return "No agentic wallets found. Use create_agentic_wallet to create one.";
      }

      const lines = [`Agentic Wallets (${wallets.length})`, ""];
      for (const w of wallets) {
        const limit = w.spendingLimitCents > 0 ? `${formatCents(w.spendingLimitCents)}/tx` : "none";
        lines.push(`  ${w.label} (${w.id.slice(0, 8)}...)`);
        lines.push(`    Balance: ${formatCents(w.balanceCents)} | Limit: ${limit} | Status: ${w.status}`);
        lines.push("");
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 10: agenticTransactions
  // -----------------------------------------------------------------------

  async agenticTransactions(walletId: string, limit: number = 20): Promise<string> {
    try {
      const wid = validateUuid(walletId, "wallet_id");
      const lim = Math.min(Math.max(Math.floor(limit), 1), 100);

      const data = await this._requestWithRetry<{
        transactions: Array<{
          id: string;
          walletId: string;
          type: string;
          amountCents: number;
          description: string;
          sessionId: string | null;
          createdAt: string;
        }>;
      }>("GET", `/api/agent-wallet/${encodeURIComponent(wid)}/transactions?limit=${lim}`);

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
  }

  // -----------------------------------------------------------------------
  // Tool 11: freezeAgenticWallet
  // -----------------------------------------------------------------------

  async freezeAgenticWallet(walletId: string): Promise<string> {
    try {
      const wid = validateUuid(walletId, "wallet_id");

      const data = await this._requestWithRetry<{
        id: string;
        label: string;
        balanceCents: number;
        spendingLimitCents: number;
        status: string;
      }>("POST", `/api/agent-wallet/${encodeURIComponent(wid)}/freeze`);

      return [
        "Agentic Wallet Frozen",
        "",
        `Wallet ID: ${data.id}`,
        `Label: ${data.label}`,
        `Balance: ${formatCents(data.balanceCents)}`,
        `Status: ${data.status}`,
        "",
        "Spending is paused. Use unfreeze_agentic_wallet to re-enable.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 12: unfreezeAgenticWallet
  // -----------------------------------------------------------------------

  async unfreezeAgenticWallet(walletId: string): Promise<string> {
    try {
      const wid = validateUuid(walletId, "wallet_id");

      const data = await this._requestWithRetry<{
        id: string;
        label: string;
        balanceCents: number;
        spendingLimitCents: number;
        status: string;
      }>("POST", `/api/agent-wallet/${encodeURIComponent(wid)}/unfreeze`);

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
  }

  // -----------------------------------------------------------------------
  // Tool 13: deleteAgenticWallet
  // -----------------------------------------------------------------------

  async deleteAgenticWallet(walletId: string): Promise<string> {
    try {
      const wid = validateUuid(walletId, "wallet_id");

      await this._requestWithRetry("DELETE", `/api/agent-wallet/${encodeURIComponent(wid)}`);

      return [
        "Agentic Wallet Deleted",
        "",
        `Wallet ID: ${wid}`,
        "",
        "Any remaining balance has been refunded to your main wallet.",
        "Use check_balance to verify the refund.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 14: createTeam
  // -----------------------------------------------------------------------

  async createTeam(name: string, maxMembers?: number): Promise<string> {
    try {
      if (!name || name.trim().length === 0 || name.length > 100) {
        return "Error: name is required and must be 1-100 characters.";
      }
      if (/[\x00-\x1f\x7f]/.test(name)) {
        return "Error: team name contains invalid control characters.";
      }

      const body: Record<string, unknown> = { name: name.trim() };
      if (maxMembers !== undefined) {
        if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 100) {
          return "Error: max_members must be an integer between 1 and 100.";
        }
        body.maxMembers = maxMembers;
      }

      const data = await this._requestWithRetry<{
        id: string;
        name: string;
        ownerId: string;
        maxMembers: number | null;
        status: string;
        walletId: string;
        createdAt: string;
        balanceCents?: number;
      }>("POST", "/api/teams", body);

      return [
        "Team Created",
        "",
        `Team ID: ${data.id}`,
        `Name: ${data.name}`,
        `Max Members: ${data.maxMembers ?? "Unlimited"}`,
        `Balance: ${formatCents(data.balanceCents ?? 0)}`,
        `Created: ${data.createdAt}`,
        "",
        "Next: Use team_fund to add funds, then team_create_key for a shared API key.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 15: listTeams
  // -----------------------------------------------------------------------

  async listTeams(): Promise<string> {
    try {
      const data = await this._requestWithRetry<{
        teams: Array<{
          id: string;
          name: string;
          role: string;
          balanceCents: number;
          memberCount?: number;
          createdAt: string;
        }>;
      }>("GET", "/api/teams");

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
  }

  // -----------------------------------------------------------------------
  // Tool 16: teamDetails
  // -----------------------------------------------------------------------

  async teamDetails(teamId: string): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");

      const data = await this._requestWithRetry<{
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
      }>("GET", `/api/teams/${encodeURIComponent(tid)}`);

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
  }

  // -----------------------------------------------------------------------
  // Tool 17: teamFund
  // -----------------------------------------------------------------------

  async teamFund(teamId: string, amountCents: number): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");
      if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > 1000000) {
        return "Error: amount_cents must be an integer between 100 ($1) and 1000000 ($10,000).";
      }

      const data = await this._requestWithRetry<{
        transaction: {
          id: string;
          walletId: string;
          type: string;
          amountCents: number;
          description: string;
          createdAt: string;
        };
      }>("POST", `/api/teams/${encodeURIComponent(tid)}/wallet/fund`, {
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
        "Funds transferred from your personal wallet.",
        "Use team_details to check the new team balance.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 18: teamCreateKey
  // -----------------------------------------------------------------------

  async teamCreateKey(teamId: string, label: string): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");
      if (!label || label.trim().length === 0 || label.length > 100) {
        return "Error: label is required and must be 1-100 characters.";
      }
      if (/[\x00-\x1f\x7f]/.test(label)) {
        return "Error: label contains invalid control characters.";
      }

      const data = await this._requestWithRetry<{
        id: string;
        key: string;
        prefix: string;
        label: string;
        createdAt: string;
      }>("POST", `/api/teams/${encodeURIComponent(tid)}/keys`, {
        label: label.trim(),
      });

      return [
        "Team API Key Created",
        "",
        `Key ID: ${data.id}`,
        `API Key: ${data.key}`,
        `Prefix: ${data.prefix}`,
        `Label: ${data.label}`,
        `Team ID: ${tid}`,
        `Created: ${data.createdAt}`,
        "",
        "IMPORTANT: Save this API key now -- it will not be shown again.",
        "Usage is billed against the team wallet.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 19: teamUsage
  // -----------------------------------------------------------------------

  async teamUsage(teamId: string, limit: number = 20): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");
      const lim = Math.min(Math.max(Math.floor(limit), 1), 100);

      const data = await this._requestWithRetry<{
        transactions: Array<{
          id: string;
          walletId: string;
          type: string;
          amountCents: number;
          description: string;
          createdAt: string;
        }>;
      }>("GET", `/api/teams/${encodeURIComponent(tid)}/wallet/transactions?limit=${lim}`);

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
  }

  // -----------------------------------------------------------------------
  // Tool 20: updateTeam
  // -----------------------------------------------------------------------

  async updateTeam(teamId: string, name?: string, maxMembers?: number): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");

      const body: Record<string, unknown> = {};

      if (name !== undefined) {
        if (!name || name.trim().length === 0 || name.length > 100) {
          return "Error: name must be 1-100 characters.";
        }
        if (/[\x00-\x1f\x7f]/.test(name)) {
          return "Error: team name contains invalid control characters.";
        }
        body.name = name.trim();
      }

      if (maxMembers !== undefined) {
        if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 100) {
          return "Error: max_members must be an integer between 1 and 100.";
        }
        body.maxMembers = maxMembers;
      }

      if (Object.keys(body).length === 0) {
        return "Error: At least one of name or max_members must be provided.";
      }

      const data = await this._requestWithRetry<{
        id: string;
        name: string;
        maxMembers: number | null;
        status: string;
      }>("PATCH", `/api/teams/${encodeURIComponent(tid)}`, body);

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
  }

  // -----------------------------------------------------------------------
  // Tool 21: updateTeamMemberRole
  // -----------------------------------------------------------------------

  async updateTeamMemberRole(teamId: string, userId: string, role: string): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");
      const uid = validateUuid(userId, "user_id");

      if (role !== "member" && role !== "admin") {
        return "Error: role must be 'member' or 'admin'.";
      }

      const data = await this._requestWithRetry<{
        userId: string;
        role: string;
        teamId: string;
      }>("PATCH", `/api/teams/${encodeURIComponent(tid)}/members/${encodeURIComponent(uid)}`, {
        role,
      });

      return [
        "Team Member Role Updated",
        "",
        `Team ID: ${data.teamId ?? tid}`,
        `User ID: ${data.userId ?? uid}`,
        `New Role: ${data.role ?? role}`,
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 22: topupPaypal
  // -----------------------------------------------------------------------

  async topupPaypal(amountCents: number): Promise<string> {
    try {
      if (!Number.isInteger(amountCents) || amountCents < 500 || amountCents > 100000) {
        return "Error: amount_cents must be an integer between 500 ($5) and 100000 ($1,000).";
      }

      const data = await this._requestWithRetry<{
        orderId: string;
        approvalUrl: string;
        amountCents: number;
      }>("POST", "/api/wallet/topup/paypal", { amountCents });

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
  }

  // -----------------------------------------------------------------------
  // Tool 23: topupStripe
  // -----------------------------------------------------------------------

  async topupStripe(amountCents: number): Promise<string> {
    try {
      if (!Number.isInteger(amountCents) || amountCents < 500 || amountCents > 100000) {
        return "Error: amount_cents must be an integer between 500 ($5) and 100000 ($1,000).";
      }

      const data = await this._requestWithRetry<{
        sessionId: string;
        url: string;
      }>("POST", "/api/wallet/topup/stripe", { amountCents });

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
  }

  // -----------------------------------------------------------------------
  // Tool 24: topupCrypto
  // -----------------------------------------------------------------------

  private static readonly VALID_CRYPTO_CURRENCIES = new Set([
    "btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb", "link",
  ]);

  async topupCrypto(amountUsd: number, currency: string): Promise<string> {
    try {
      if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || amountUsd < 5 || amountUsd > 1000) {
        return "Error: amount_usd must be a number between 5 and 1,000.";
      }

      const cur = String(currency ?? "").toLowerCase();
      if (!DominusNodeToolkit.VALID_CRYPTO_CURRENCIES.has(cur)) {
        return `Error: currency must be one of: ${[...DominusNodeToolkit.VALID_CRYPTO_CURRENCIES].join(", ")}.`;
      }

      const data = await this._requestWithRetry<{
        invoiceId: string;
        invoiceUrl: string;
        payCurrency: string;
        priceAmount: number;
      }>("POST", "/api/wallet/topup/crypto", { amountUsd, currency: cur });

      return [
        "Crypto Payment Invoice Created",
        "",
        `Invoice ID: ${data.invoiceId}`,
        `Amount: $${amountUsd}`,
        `Pay: ${data.priceAmount} ${data.payCurrency?.toUpperCase() ?? cur.toUpperCase()}`,
        `Payment URL: ${data.invoiceUrl}`,
        "",
        "Open the payment URL to complete payment.",
        "Once confirmed on-chain, the funds will be credited to your wallet.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 25: x402Info
  // -----------------------------------------------------------------------

  async x402Info(): Promise<string> {
    try {
      const data = await this._requestWithRetry<Record<string, unknown>>("GET", "/api/x402/info");
      return JSON.stringify(data, null, 2);
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 26: getProxyStatus
  // -----------------------------------------------------------------------

  async getProxyStatus(): Promise<string> {
    try {
      const data = await this._requestWithRetry<Record<string, unknown>>("GET", "/api/proxy/status");

      const lines = [
        "Proxy Status",
        "",
      ];
      if (data.status) lines.push(`Status: ${data.status}`);
      if (data.uptime !== undefined) lines.push(`Uptime: ${data.uptime}`);
      if (data.activeConnections !== undefined) lines.push(`Active Connections: ${data.activeConnections}`);
      if (data.providerStatus) lines.push(`Provider Status: ${JSON.stringify(data.providerStatus)}`);
      if (Object.keys(data).length === 0) {
        lines.push("No status data available.");
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 27: getTransactions
  // -----------------------------------------------------------------------

  async getTransactions(limit: number = 20): Promise<string> {
    try {
      const lim = Math.min(Math.max(Math.floor(limit), 1), 100);

      const data = await this._requestWithRetry<{
        transactions: Array<{
          id: string;
          type: string;
          amountCents: number;
          description: string;
          createdAt: string;
        }>;
      }>("GET", `/api/wallet/transactions?limit=${lim}`);

      const txs = data.transactions ?? [];
      if (txs.length === 0) {
        return "No wallet transactions found.";
      }

      const lines = [`Wallet Transactions (${txs.length})`, ""];
      for (const tx of txs) {
        const sign = tx.type === "topup" || tx.type === "fund" || tx.type === "refund" ? "+" : "-";
        lines.push(`  ${sign}${formatCents(tx.amountCents)} [${tx.type}] ${tx.description}`);
        lines.push(`    ${tx.createdAt}`);
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 28: getForecast
  // -----------------------------------------------------------------------

  async getForecast(): Promise<string> {
    try {
      const data = await this._requestWithRetry<{
        daysRemaining: number;
        avgDailySpendCents: number;
        balanceCents: number;
        estimatedDepletionDate: string;
      }>("GET", "/api/wallet/forecast");

      const lines = [
        "Wallet Balance Forecast",
        "",
        `Current Balance: ${formatCents(data.balanceCents ?? 0)}`,
        `Average Daily Spend: ${formatCents(data.avgDailySpendCents ?? 0)}`,
        `Estimated Days Remaining: ${data.daysRemaining ?? "N/A"}`,
      ];
      if (data.estimatedDepletionDate) {
        lines.push(`Estimated Depletion Date: ${data.estimatedDepletionDate}`);
      }

      return lines.join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 29: checkPayment
  // -----------------------------------------------------------------------

  async checkPayment(invoiceId: string): Promise<string> {
    try {
      if (!invoiceId || invoiceId.trim().length === 0) {
        return "Error: invoice_id is required.";
      }
      if (/[\x00-\x1f\x7f]/.test(invoiceId)) {
        return "Error: invoice_id contains invalid control characters.";
      }

      const data = await this._requestWithRetry<{
        invoiceId: string;
        status: string;
        amountUsd: number;
        payCurrency: string;
        paidAt: string | null;
      }>("GET", `/api/wallet/topup/crypto/${encodeURIComponent(invoiceId.trim())}/status`);

      const lines = [
        "Crypto Payment Status",
        "",
        `Invoice ID: ${data.invoiceId ?? invoiceId}`,
        `Status: ${data.status ?? "unknown"}`,
        `Amount: $${data.amountUsd ?? "N/A"}`,
        `Currency: ${data.payCurrency?.toUpperCase() ?? "N/A"}`,
      ];
      if (data.paidAt) {
        lines.push(`Paid At: ${data.paidAt}`);
      }

      return lines.join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 30: getDailyUsage
  // -----------------------------------------------------------------------

  async getDailyUsage(days: number = 7): Promise<string> {
    try {
      const d = Math.min(Math.max(Math.floor(days), 1), 365);

      const data = await this._requestWithRetry<{
        days: Array<{
          date: string;
          bytes: number;
          costCents: number;
          requests: number;
        }>;
      }>("GET", `/api/usage/daily?days=${d}`);

      const dayEntries = data.days ?? [];
      if (dayEntries.length === 0) {
        return "No daily usage data available.";
      }

      const lines = [`Daily Usage (last ${d} days)`, ""];
      for (const day of dayEntries) {
        lines.push(`  ${day.date}: ${formatBytes(day.bytes)} | ${formatCents(day.costCents)} | ${day.requests} reqs`);
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 31: getTopHosts
  // -----------------------------------------------------------------------

  async getTopHosts(limit: number = 10): Promise<string> {
    try {
      const lim = Math.min(Math.max(Math.floor(limit), 1), 100);

      const data = await this._requestWithRetry<{
        hosts: Array<{
          host: string;
          bytes: number;
          requests: number;
          costCents: number;
        }>;
      }>("GET", `/api/usage/top-hosts?limit=${lim}`);

      const hosts = data.hosts ?? [];
      if (hosts.length === 0) {
        return "No top hosts data available.";
      }

      const lines = [`Top Hosts by Bandwidth (${hosts.length})`, ""];
      for (const h of hosts) {
        lines.push(`  ${h.host}: ${formatBytes(h.bytes)} | ${formatCents(h.costCents)} | ${h.requests} reqs`);
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 32: register (unauthenticated)
  // -----------------------------------------------------------------------

  async register(email: string, password: string): Promise<string> {
    try {
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return "Error: a valid email address is required.";
      }
      if (!password || password.length < 8 || password.length > 128) {
        return "Error: password must be between 8 and 128 characters.";
      }

      // Solve PoW for CAPTCHA-free registration
      const pow = await this._solvePoW();
      const regBody: Record<string, unknown> = { email, password };
      if (pow) regBody.pow = pow;
      const data = await this._unauthenticatedRequest<{
        user: { id: string; email: string };
        accessToken?: string;
        refreshToken?: string;
      }>("POST", "/api/auth/register", regBody);

      return [
        "Account Created",
        "",
        `User ID: ${data.user?.id ?? "N/A"}`,
        `Email: ${data.user?.email ?? email}`,
        "",
        "Verify your email to unlock financial features.",
        "MCP agents are auto-verified via agent headers.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 33: login (unauthenticated)
  // -----------------------------------------------------------------------

  async login(email: string, password: string): Promise<string> {
    try {
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return "Error: a valid email address is required.";
      }
      if (!password || password.length < 1) {
        return "Error: password is required.";
      }

      const data = await this._unauthenticatedRequest<{
        accessToken?: string;
        refreshToken?: string;
        mfaRequired?: boolean;
        challengeToken?: string;
      }>("POST", "/api/auth/login", { email, password });

      if (data.mfaRequired) {
        return [
          "MFA Required",
          "",
          `Challenge Token: ${data.challengeToken ?? "N/A"}`,
          "",
          "Multi-factor authentication is required. Complete the MFA challenge to proceed.",
        ].join("\n");
      }

      return [
        "Login Successful",
        "",
        "Access and refresh tokens have been issued.",
        "Use get_account_info to view your account details.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 34: getAccountInfo
  // -----------------------------------------------------------------------

  async getAccountInfo(): Promise<string> {
    try {
      const data = await this._requestWithRetry<{
        user: {
          id: string;
          email: string;
          plan: string;
          emailVerified: boolean;
          status: string;
          createdAt: string;
        };
      }>("GET", "/api/auth/me");

      const user = data.user;
      return [
        "Account Information",
        "",
        `User ID: ${user?.id ?? "N/A"}`,
        `Email: ${user?.email ?? "N/A"}`,
        `Plan: ${user?.plan ?? "N/A"}`,
        `Email Verified: ${user?.emailVerified ?? false}`,
        `Status: ${user?.status ?? "N/A"}`,
        `Created: ${user?.createdAt ?? "N/A"}`,
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 35: verifyEmail (unauthenticated)
  // -----------------------------------------------------------------------

  async verifyEmail(token: string): Promise<string> {
    try {
      if (!token || token.trim().length === 0) {
        return "Error: verification token is required.";
      }
      if (/[\x00-\x1f\x7f]/.test(token)) {
        return "Error: token contains invalid control characters.";
      }

      await this._unauthenticatedRequest("POST", "/api/auth/verify-email", {
        token: token.trim(),
      });

      return "Email verified successfully. Financial features are now unlocked.";
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 36: resendVerification
  // -----------------------------------------------------------------------

  async resendVerification(): Promise<string> {
    try {
      await this._requestWithRetry("POST", "/api/auth/resend-verification");
      return "Verification email sent. Check your inbox for the verification link.";
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 37: updatePassword
  // -----------------------------------------------------------------------

  async updatePassword(currentPassword: string, newPassword: string): Promise<string> {
    try {
      if (!currentPassword || currentPassword.length < 1) {
        return "Error: current password is required.";
      }
      if (!newPassword || newPassword.length < 8 || newPassword.length > 128) {
        return "Error: new password must be between 8 and 128 characters.";
      }

      await this._requestWithRetry("POST", "/api/auth/change-password", {
        currentPassword,
        newPassword,
      });

      return "Password updated successfully.";
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 38: listKeys
  // -----------------------------------------------------------------------

  async listKeys(): Promise<string> {
    try {
      const data = await this._requestWithRetry<{
        keys: Array<{
          id: string;
          label: string;
          prefix: string;
          createdAt: string;
        }>;
      }>("GET", "/api/keys");

      const keys = data.keys ?? [];
      if (keys.length === 0) {
        return "No API keys found. Use create_key to create one.";
      }

      const lines = [`API Keys (${keys.length})`, ""];
      for (const k of keys) {
        lines.push(`  ${k.label ?? "unlabeled"} (${k.id.slice(0, 8)}...)`);
        lines.push(`    Prefix: ${k.prefix} | Created: ${k.createdAt}`);
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 39: createKey
  // -----------------------------------------------------------------------

  async createKey(label?: string): Promise<string> {
    try {
      if (label !== undefined) {
        if (label.length === 0 || label.length > 100) {
          return "Error: label must be 1-100 characters.";
        }
        if (/[\x00-\x1f\x7f]/.test(label)) {
          return "Error: label contains invalid control characters.";
        }
      }

      const body: Record<string, unknown> = {};
      if (label) body.label = label.trim();

      const data = await this._requestWithRetry<{
        id: string;
        key: string;
        prefix: string;
        label: string;
        createdAt: string;
      }>("POST", "/api/keys", body);

      return [
        "API Key Created",
        "",
        `Key ID: ${data.id}`,
        `API Key: ${data.key}`,
        `Prefix: ${data.prefix}`,
        `Label: ${data.label ?? ""}`,
        `Created: ${data.createdAt}`,
        "",
        "IMPORTANT: Save this API key now -- it will not be shown again.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 40: revokeKey
  // -----------------------------------------------------------------------

  async revokeKey(keyId: string): Promise<string> {
    try {
      const kid = validateUuid(keyId, "key_id");

      await this._requestWithRetry("DELETE", `/api/keys/${encodeURIComponent(kid)}`);

      return [
        "API Key Revoked",
        "",
        `Key ID: ${kid}`,
        "",
        "The key is now permanently deactivated and cannot be used.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 41: getPlan
  // -----------------------------------------------------------------------

  async getPlan(): Promise<string> {
    try {
      const data = await this._requestWithRetry<{
        id: string;
        name: string;
        bandwidthLimitBytes: number;
        pricePerGbCents: number;
        features: string[];
      }>("GET", "/api/plans/user/plan");

      const lines = [
        "Current Plan",
        "",
        `Plan ID: ${data.id ?? "N/A"}`,
        `Name: ${data.name ?? "N/A"}`,
      ];
      if (data.bandwidthLimitBytes !== undefined) {
        lines.push(`Bandwidth Limit: ${formatBytes(data.bandwidthLimitBytes)}`);
      }
      if (data.pricePerGbCents !== undefined) {
        lines.push(`Price Per GB: ${formatCents(data.pricePerGbCents)}`);
      }
      if (data.features && data.features.length > 0) {
        lines.push(`Features: ${data.features.join(", ")}`);
      }

      return lines.join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 42: listPlans
  // -----------------------------------------------------------------------

  async listPlans(): Promise<string> {
    try {
      const data = await this._requestWithRetry<{
        plans: Array<{
          id: string;
          name: string;
          bandwidthLimitBytes: number;
          pricePerGbCents: number;
          features: string[];
        }>;
      }>("GET", "/api/plans");

      const plans = data.plans ?? [];
      if (plans.length === 0) {
        return "No plans available.";
      }

      const lines = [`Available Plans (${plans.length})`, ""];
      for (const p of plans) {
        lines.push(`  ${p.name} (${p.id})`);
        if (p.bandwidthLimitBytes !== undefined) {
          lines.push(`    Bandwidth: ${formatBytes(p.bandwidthLimitBytes)} | Price: ${formatCents(p.pricePerGbCents)}/GB`);
        }
        if (p.features && p.features.length > 0) {
          lines.push(`    Features: ${p.features.join(", ")}`);
        }
        lines.push("");
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 43: changePlan
  // -----------------------------------------------------------------------

  async changePlan(planId: string): Promise<string> {
    try {
      if (!planId || planId.trim().length === 0) {
        return "Error: plan_id is required.";
      }
      if (/[\x00-\x1f\x7f]/.test(planId)) {
        return "Error: plan_id contains invalid control characters.";
      }

      const data = await this._requestWithRetry<{
        id: string;
        name: string;
        message: string;
      }>("PUT", "/api/plans/user/plan", { planId: planId.trim() });

      return [
        "Plan Changed",
        "",
        `New Plan: ${data.name ?? data.id ?? planId}`,
        data.message ? `Message: ${data.message}` : "",
      ].filter(Boolean).join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 44: teamDelete
  // -----------------------------------------------------------------------

  async teamDelete(teamId: string): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");

      await this._requestWithRetry("DELETE", `/api/teams/${encodeURIComponent(tid)}`);

      return [
        "Team Deleted",
        "",
        `Team ID: ${tid}`,
        "",
        "The team has been permanently deleted.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 45: teamRevokeKey
  // -----------------------------------------------------------------------

  async teamRevokeKey(teamId: string, keyId: string): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");
      const kid = validateUuid(keyId, "key_id");

      await this._requestWithRetry(
        "DELETE",
        `/api/teams/${encodeURIComponent(tid)}/keys/${encodeURIComponent(kid)}`,
      );

      return [
        "Team API Key Revoked",
        "",
        `Team ID: ${tid}`,
        `Key ID: ${kid}`,
        "",
        "The team key is now permanently deactivated.",
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 46: teamListKeys
  // -----------------------------------------------------------------------

  async teamListKeys(teamId: string): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");

      const data = await this._requestWithRetry<{
        keys: Array<{
          id: string;
          label: string;
          prefix: string;
          createdAt: string;
        }>;
      }>("GET", `/api/teams/${encodeURIComponent(tid)}/keys`);

      const keys = data.keys ?? [];
      if (keys.length === 0) {
        return "No API keys found for this team. Use team_create_key to create one.";
      }

      const lines = [`Team API Keys (${keys.length})`, ""];
      for (const k of keys) {
        lines.push(`  ${k.label ?? "unlabeled"} (${k.id.slice(0, 8)}...)`);
        lines.push(`    Prefix: ${k.prefix} | Created: ${k.createdAt}`);
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 47: teamListMembers
  // -----------------------------------------------------------------------

  async teamListMembers(teamId: string): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");

      const data = await this._requestWithRetry<{
        members: Array<{
          userId: string;
          email: string;
          role: string;
          joinedAt: string;
        }>;
      }>("GET", `/api/teams/${encodeURIComponent(tid)}/members`);

      const members = data.members ?? [];
      if (members.length === 0) {
        return "No members found for this team.";
      }

      const lines = [`Team Members (${members.length})`, ""];
      for (const m of members) {
        lines.push(`  ${m.email} -- ${m.role}`);
        lines.push(`    User ID: ${m.userId} | Joined: ${m.joinedAt}`);
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 48: teamAddMember
  // -----------------------------------------------------------------------

  async teamAddMember(teamId: string, email: string, role?: string): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return "Error: a valid email address is required.";
      }

      if (role !== undefined && role !== "member" && role !== "admin") {
        return "Error: role must be 'member' or 'admin'.";
      }

      const body: Record<string, unknown> = { email };
      if (role) body.role = role;

      const data = await this._requestWithRetry<{
        userId: string;
        email: string;
        role: string;
        teamId: string;
      }>("POST", `/api/teams/${encodeURIComponent(tid)}/members`, body);

      return [
        "Team Member Added",
        "",
        `Team ID: ${tid}`,
        `Email: ${data.email ?? email}`,
        `Role: ${data.role ?? role ?? "member"}`,
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 49: teamRemoveMember
  // -----------------------------------------------------------------------

  async teamRemoveMember(teamId: string, userId: string): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");
      const uid = validateUuid(userId, "user_id");

      await this._requestWithRetry(
        "DELETE",
        `/api/teams/${encodeURIComponent(tid)}/members/${encodeURIComponent(uid)}`,
      );

      return [
        "Team Member Removed",
        "",
        `Team ID: ${tid}`,
        `User ID: ${uid}`,
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 50: teamInviteMember
  // -----------------------------------------------------------------------

  async teamInviteMember(teamId: string, email: string, role?: string): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return "Error: a valid email address is required.";
      }

      if (role !== undefined && role !== "member" && role !== "admin") {
        return "Error: role must be 'member' or 'admin'.";
      }

      const body: Record<string, unknown> = { email };
      if (role) body.role = role;

      const data = await this._requestWithRetry<{
        id: string;
        email: string;
        role: string;
        teamId: string;
        expiresAt: string;
      }>("POST", `/api/teams/${encodeURIComponent(tid)}/invites`, body);

      return [
        "Team Invitation Sent",
        "",
        `Invite ID: ${data.id ?? "N/A"}`,
        `Team ID: ${tid}`,
        `Email: ${data.email ?? email}`,
        `Role: ${data.role ?? role ?? "member"}`,
        data.expiresAt ? `Expires: ${data.expiresAt}` : "",
      ].filter(Boolean).join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 51: teamListInvites
  // -----------------------------------------------------------------------

  async teamListInvites(teamId: string): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");

      const data = await this._requestWithRetry<{
        invites: Array<{
          id: string;
          email: string;
          role: string;
          status: string;
          createdAt: string;
          expiresAt: string;
        }>;
      }>("GET", `/api/teams/${encodeURIComponent(tid)}/invites`);

      const invites = data.invites ?? [];
      if (invites.length === 0) {
        return "No pending invitations for this team.";
      }

      const lines = [`Team Invitations (${invites.length})`, ""];
      for (const inv of invites) {
        lines.push(`  ${inv.email} -- ${inv.role} [${inv.status}]`);
        lines.push(`    Invite ID: ${inv.id.slice(0, 8)}... | Created: ${inv.createdAt}`);
      }

      return truncate(lines.join("\n"));
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Tool 52: teamCancelInvite
  // -----------------------------------------------------------------------

  async teamCancelInvite(teamId: string, inviteId: string): Promise<string> {
    try {
      const tid = validateUuid(teamId, "team_id");
      const iid = validateUuid(inviteId, "invite_id");

      await this._requestWithRetry(
        "DELETE",
        `/api/teams/${encodeURIComponent(tid)}/invites/${encodeURIComponent(iid)}`,
      );

      return [
        "Team Invitation Cancelled",
        "",
        `Team ID: ${tid}`,
        `Invite ID: ${iid}`,
      ].join("\n");
    } catch (err) {
      return `Error: ${safeError(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // getTools() -- returns LangChain DynamicStructuredTool[] for Flowise
  // -----------------------------------------------------------------------

  getTools(): DynamicStructuredTool[] {
    return [
      // 1. proxied_fetch
      new DynamicStructuredTool({
        name: "dominusnode_proxied_fetch",
        description:
          "Fetch a URL through Dominus Node's rotating proxy network. Supports geo-targeting " +
          "by country. Returns status code, headers, and response body (truncated).",
        schema: z.object({
          url: z.string().describe("The target URL to fetch (http or https)"),
          method: z.enum(["GET", "HEAD", "OPTIONS"]).default("GET").describe("HTTP method"),
          country: z.string().optional().describe("ISO 3166-1 alpha-2 country code for geo-targeting (e.g., US, GB, DE)"),
          proxyType: z.enum(["dc", "residential"]).default("dc").describe("Proxy pool: dc ($3/GB) or residential ($5/GB)"),
        }),
        func: async ({  url, method, country, proxyType }: Record<string, any>) => {
          return this.proxiedFetch(url, method, country, proxyType);
        },
      }),

      // 2. check_balance
      new DynamicStructuredTool({
        name: "dominusnode_check_balance",
        description:
          "Check your Dominus Node wallet balance and estimated remaining bandwidth at current pricing.",
        schema: z.object({}),
        func: async () => {
          return this.checkBalance();
        },
      }),

      // 3. check_usage
      new DynamicStructuredTool({
        name: "dominusnode_check_usage",
        description:
          "View bandwidth usage statistics for a specified time period. Shows total bytes, cost, and request count.",
        schema: z.object({
          days: z.number().min(1).max(365).default(30).describe("Number of days to look back (1-365)"),
        }),
        func: async ({  days }: Record<string, any>) => {
          return this.checkUsage(days);
        },
      }),

      // 4. get_proxy_config
      new DynamicStructuredTool({
        name: "dominusnode_get_proxy_config",
        description:
          "Get available proxy pools, pricing, supported countries, and endpoint configuration.",
        schema: z.object({}),
        func: async () => {
          return this.getProxyConfig();
        },
      }),

      // 5. list_sessions
      new DynamicStructuredTool({
        name: "dominusnode_list_sessions",
        description: "List all active proxy sessions showing target hosts, bandwidth used, and status.",
        schema: z.object({}),
        func: async () => {
          return this.listSessions();
        },
      }),

      // 6. create_agentic_wallet
      new DynamicStructuredTool({
        name: "dominusnode_create_agentic_wallet",
        description:
          "Create a server-side custodial agentic wallet for autonomous proxy billing. " +
          "Set a spending limit per transaction for safety. Optionally set a daily budget cap and domain allowlist.",
        schema: z.object({
          label: z.string().min(1).max(100).describe('Label for this wallet (e.g., "scraper-bot")'),
          spendingLimitCents: z
            .number()
            .int()
            .min(0)
            .max(1000000)
            .default(10000)
            .describe("Max spend per transaction in cents (0 = no limit, default $100)"),
          dailyLimitCents: z
            .number()
            .int()
            .positive()
            .max(1000000)
            .optional()
            .describe("Optional daily budget cap in cents (max 1,000,000 = $10,000)"),
          allowedDomains: z
            .array(z.string().max(253))
            .max(100)
            .optional()
            .describe("Optional list of allowed domains for proxy access (max 100 entries)"),
        }),
        func: async ({  label, spendingLimitCents, dailyLimitCents, allowedDomains }: Record<string, any>) => {
          return this.createAgenticWallet(label, spendingLimitCents, dailyLimitCents, allowedDomains);
        },
      }),

      // 7. fund_agentic_wallet
      new DynamicStructuredTool({
        name: "dominusnode_fund_agentic_wallet",
        description:
          "Transfer funds from your main wallet to an agentic wallet. Min $1, max $10,000.",
        schema: z.object({
          walletId: z.string().uuid().describe("Agentic wallet ID (UUID)"),
          amountCents: z.number().int().min(100).max(1000000).describe("Amount in cents to transfer"),
        }),
        func: async ({  walletId, amountCents }: Record<string, any>) => {
          return this.fundAgenticWallet(walletId, amountCents);
        },
      }),

      // 8. agentic_wallet_balance
      new DynamicStructuredTool({
        name: "dominusnode_agentic_wallet_balance",
        description: "Check the balance and details of an agentic wallet.",
        schema: z.object({
          walletId: z.string().uuid().describe("Agentic wallet ID (UUID)"),
        }),
        func: async ({  walletId }: Record<string, any>) => {
          return this.agenticWalletBalance(walletId);
        },
      }),

      // 9. list_agentic_wallets
      new DynamicStructuredTool({
        name: "dominusnode_list_agentic_wallets",
        description: "List all your agentic wallets with balances and status.",
        schema: z.object({}),
        func: async () => {
          return this.listAgenticWallets();
        },
      }),

      // 10. agentic_transactions
      new DynamicStructuredTool({
        name: "dominusnode_agentic_transactions",
        description: "Get transaction history for an agentic wallet.",
        schema: z.object({
          walletId: z.string().uuid().describe("Agentic wallet ID (UUID)"),
          limit: z.number().int().min(1).max(100).default(20).describe("Number of transactions to return"),
        }),
        func: async ({  walletId, limit }: Record<string, any>) => {
          return this.agenticTransactions(walletId, limit);
        },
      }),

      // 11. freeze_agentic_wallet
      new DynamicStructuredTool({
        name: "dominusnode_freeze_agentic_wallet",
        description:
          "Freeze an agentic wallet to prevent spending. Balance is preserved until unfrozen.",
        schema: z.object({
          walletId: z.string().uuid().describe("Agentic wallet ID (UUID)"),
        }),
        func: async ({  walletId }: Record<string, any>) => {
          return this.freezeAgenticWallet(walletId);
        },
      }),

      // 12. unfreeze_agentic_wallet
      new DynamicStructuredTool({
        name: "dominusnode_unfreeze_agentic_wallet",
        description: "Unfreeze a previously frozen agentic wallet to re-enable spending.",
        schema: z.object({
          walletId: z.string().uuid().describe("Agentic wallet ID (UUID)"),
        }),
        func: async ({  walletId }: Record<string, any>) => {
          return this.unfreezeAgenticWallet(walletId);
        },
      }),

      // 13. delete_agentic_wallet
      new DynamicStructuredTool({
        name: "dominusnode_delete_agentic_wallet",
        description:
          "Delete an agentic wallet. Must be unfrozen first. Remaining balance refunded to main wallet.",
        schema: z.object({
          walletId: z.string().uuid().describe("Agentic wallet ID (UUID)"),
        }),
        func: async ({  walletId }: Record<string, any>) => {
          return this.deleteAgenticWallet(walletId);
        },
      }),

      // 13b. update_wallet_policy
      new DynamicStructuredTool({
        name: "dominusnode_update_wallet_policy",
        description:
          "Update spending policy for an agentic wallet. Set or remove daily budget caps and domain restrictions.",
        schema: z.object({
          walletId: z.string().uuid().describe("Agentic wallet ID (UUID)"),
          dailyLimitCents: z
            .number()
            .int()
            .positive()
            .max(1000000)
            .nullable()
            .optional()
            .describe("Daily budget cap in cents (max 1,000,000). Set null to remove."),
          allowedDomains: z
            .array(z.string().max(253))
            .max(100)
            .nullable()
            .optional()
            .describe("List of allowed domains (max 100). Set null to remove restriction."),
        }),
        func: async ({  walletId, dailyLimitCents, allowedDomains }: Record<string, any>) => {
          return this.updateWalletPolicy(walletId, dailyLimitCents, allowedDomains);
        },
      }),

      // 14. create_team
      new DynamicStructuredTool({
        name: "dominusnode_create_team",
        description:
          "Create a new team with shared wallet billing. Teams let multiple users share proxy access.",
        schema: z.object({
          name: z.string().min(1).max(100).describe("Team name (1-100 characters)"),
          maxMembers: z.number().int().min(1).max(100).optional().describe("Maximum team members (1-100, optional)"),
        }),
        func: async ({  name, maxMembers }: Record<string, any>) => {
          return this.createTeam(name, maxMembers);
        },
      }),

      // 15. list_teams
      new DynamicStructuredTool({
        name: "dominusnode_list_teams",
        description: "List all teams you belong to, with your role and team balance.",
        schema: z.object({}),
        func: async () => {
          return this.listTeams();
        },
      }),

      // 16. team_details
      new DynamicStructuredTool({
        name: "dominusnode_team_details",
        description: "Get detailed info about a team including balance, members, settings, and your role.",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID)"),
        }),
        func: async ({  teamId }: Record<string, any>) => {
          return this.teamDetails(teamId);
        },
      }),

      // 17. team_fund
      new DynamicStructuredTool({
        name: "dominusnode_team_fund",
        description: "Transfer funds from your personal wallet to a team wallet. Min $1, max $10,000.",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID)"),
          amountCents: z.number().int().min(100).max(1000000).describe("Amount in cents to transfer"),
        }),
        func: async ({  teamId, amountCents }: Record<string, any>) => {
          return this.teamFund(teamId, amountCents);
        },
      }),

      // 18. team_create_key
      new DynamicStructuredTool({
        name: "dominusnode_team_create_key",
        description:
          "Create a shared API key for a team. Usage is billed against the team wallet. " +
          "The key is shown only once.",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID)"),
          label: z.string().min(1).max(100).describe('Label for the API key (e.g., "production")'),
        }),
        func: async ({  teamId, label }: Record<string, any>) => {
          return this.teamCreateKey(teamId, label);
        },
      }),

      // 19. team_usage
      new DynamicStructuredTool({
        name: "dominusnode_team_usage",
        description: "Get the team wallet transaction history (funding, usage charges, refunds).",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID)"),
          limit: z.number().int().min(1).max(100).default(20).describe("Number of transactions to return"),
        }),
        func: async ({  teamId, limit }: Record<string, any>) => {
          return this.teamUsage(teamId, limit);
        },
      }),

      // 20. update_team
      new DynamicStructuredTool({
        name: "dominusnode_update_team",
        description: "Update a team's settings (name and/or max member count). Owners and admins only.",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID)"),
          name: z.string().min(1).max(100).optional().describe("New team name"),
          maxMembers: z.number().int().min(1).max(100).optional().describe("New max member count"),
        }),
        func: async ({  teamId, name, maxMembers }: Record<string, any>) => {
          return this.updateTeam(teamId, name, maxMembers);
        },
      }),

      // 21. update_team_member_role
      new DynamicStructuredTool({
        name: "dominusnode_update_team_member_role",
        description: "Update a team member's role (member or admin). Owners and admins only.",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID)"),
          userId: z.string().uuid().describe("User ID (UUID) of the member"),
          role: z.enum(["member", "admin"]).describe("New role for the member"),
        }),
        func: async ({  teamId, userId, role }: Record<string, any>) => {
          return this.updateTeamMemberRole(teamId, userId, role);
        },
      }),

      // 22. topup_paypal
      new DynamicStructuredTool({
        name: "dominusnode_topup_paypal",
        description:
          "Top up your Dominus Node wallet via PayPal. Creates a PayPal order and returns an " +
          "approval URL. Minimum $5, maximum $1,000.",
        schema: z.object({
          amountCents: z.number().int().min(500).max(100000).describe("Amount in cents to top up (min 500 = $5)"),
        }),
        func: async ({  amountCents }: Record<string, any>) => {
          return this.topupPaypal(amountCents);
        },
      }),

      // 23. topup_stripe
      new DynamicStructuredTool({
        name: "dominusnode_topup_stripe",
        description:
          "Top up your Dominus Node wallet via Stripe. Creates a Stripe checkout session and returns " +
          "a checkout URL. Minimum $5 (500 cents), maximum $1,000 (100000 cents).",
        schema: z.object({
          amountCents: z.number().int().min(500).max(100000).describe("Amount in cents to top up (min 500 = $5)"),
        }),
        func: async ({  amountCents }: Record<string, any>) => {
          return this.topupStripe(amountCents);
        },
      }),

      // 24. topup_crypto
      new DynamicStructuredTool({
        name: "dominusnode_topup_crypto",
        description:
          "Top up your Dominus Node wallet via cryptocurrency. Creates a crypto payment invoice. " +
          "Supports BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK. " +
          "Minimum $5, maximum $1,000.",
        schema: z.object({
          amountUsd: z.number().min(5).max(1000).describe("Amount in USD to top up (5-1000)"),
          currency: z.enum(["btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb", "link"])
            .describe("Cryptocurrency to pay with"),
        }),
        func: async ({  amountUsd, currency }: Record<string, any>) => {
          return this.topupCrypto(amountUsd, currency);
        },
      }),

      // 25. x402_info
      new DynamicStructuredTool({
        name: "dominusnode_x402_info",
        description:
          "Get x402 micropayment protocol information including supported facilitators, " +
          "pricing, and payment options for AI agent micropayments.",
        schema: z.object({}),
        func: async () => {
          return this.x402Info();
        },
      }),

      // 26. get_proxy_status
      new DynamicStructuredTool({
        name: "dominusnode_get_proxy_status",
        description:
          "Get proxy health and status information including uptime, active connections, and provider status.",
        schema: z.object({}),
        func: async () => {
          return this.getProxyStatus();
        },
      }),

      // 27. get_transactions
      new DynamicStructuredTool({
        name: "dominusnode_get_transactions",
        description:
          "Get wallet transaction history including top-ups, usage charges, and refunds.",
        schema: z.object({
          limit: z.number().int().min(1).max(100).default(20).describe("Number of transactions to return (1-100)"),
        }),
        func: async ({ limit }: Record<string, any>) => {
          return this.getTransactions(limit);
        },
      }),

      // 28. get_forecast
      new DynamicStructuredTool({
        name: "dominusnode_get_forecast",
        description:
          "Get a wallet balance forecast based on recent usage patterns. Shows estimated days until balance depletion.",
        schema: z.object({}),
        func: async () => {
          return this.getForecast();
        },
      }),

      // 29. check_payment
      new DynamicStructuredTool({
        name: "dominusnode_check_payment",
        description:
          "Check the status of a cryptocurrency payment invoice. Use after creating a crypto top-up.",
        schema: z.object({
          invoiceId: z.string().min(1).describe("The invoice ID from the crypto top-up creation"),
        }),
        func: async ({ invoiceId }: Record<string, any>) => {
          return this.checkPayment(invoiceId);
        },
      }),

      // 30. get_daily_usage
      new DynamicStructuredTool({
        name: "dominusnode_get_daily_usage",
        description:
          "Get daily usage breakdown showing bandwidth, cost, and request count per day.",
        schema: z.object({
          days: z.number().int().min(1).max(365).default(7).describe("Number of days to look back (1-365)"),
        }),
        func: async ({ days }: Record<string, any>) => {
          return this.getDailyUsage(days);
        },
      }),

      // 31. get_top_hosts
      new DynamicStructuredTool({
        name: "dominusnode_get_top_hosts",
        description:
          "Get the top accessed hosts ranked by bandwidth usage. Useful for understanding proxy usage patterns.",
        schema: z.object({
          limit: z.number().int().min(1).max(100).default(10).describe("Number of top hosts to return (1-100)"),
        }),
        func: async ({ limit }: Record<string, any>) => {
          return this.getTopHosts(limit);
        },
      }),

      // 32. register
      new DynamicStructuredTool({
        name: "dominusnode_register",
        description:
          "Register a new Dominus Node account. Returns user info. " +
          "After registering, verify email or rely on MCP agent auto-verification.",
        schema: z.object({
          email: z.string().email().describe("Email address for the new account"),
          password: z.string().min(8).max(128).describe("Password (min 8, max 128 characters)"),
        }),
        func: async ({ email, password }: Record<string, any>) => {
          return this.register(email, password);
        },
      }),

      // 33. login
      new DynamicStructuredTool({
        name: "dominusnode_login",
        description:
          "Log into an existing Dominus Node account. Returns login status. " +
          "Detects MFA requirements and surfaces challenge tokens.",
        schema: z.object({
          email: z.string().email().describe("Account email address"),
          password: z.string().min(1).describe("Account password"),
        }),
        func: async ({ email, password }: Record<string, any>) => {
          return this.login(email, password);
        },
      }),

      // 34. get_account_info
      new DynamicStructuredTool({
        name: "dominusnode_get_account_info",
        description:
          "Get the current authenticated account information including email, plan, verification status, and creation date.",
        schema: z.object({}),
        func: async () => {
          return this.getAccountInfo();
        },
      }),

      // 35. verify_email
      new DynamicStructuredTool({
        name: "dominusnode_verify_email",
        description:
          "Verify email address using the verification token sent to email. " +
          "MCP agents are auto-verified via agent headers.",
        schema: z.object({
          token: z.string().min(1).describe("Email verification token from the verification email"),
        }),
        func: async ({ token }: Record<string, any>) => {
          return this.verifyEmail(token);
        },
      }),

      // 36. resend_verification
      new DynamicStructuredTool({
        name: "dominusnode_resend_verification",
        description:
          "Resend the email verification token to the account's email address.",
        schema: z.object({}),
        func: async () => {
          return this.resendVerification();
        },
      }),

      // 37. update_password
      new DynamicStructuredTool({
        name: "dominusnode_update_password",
        description:
          "Change the password for the current Dominus Node account. Requires the current password.",
        schema: z.object({
          currentPassword: z.string().min(1).describe("Current account password"),
          newPassword: z.string().min(8).max(128).describe("New password (min 8, max 128 characters)"),
        }),
        func: async ({ currentPassword, newPassword }: Record<string, any>) => {
          return this.updatePassword(currentPassword, newPassword);
        },
      }),

      // 38. list_keys
      new DynamicStructuredTool({
        name: "dominusnode_list_keys",
        description:
          "List all API keys for the current account. Shows key ID, label, prefix, and creation date.",
        schema: z.object({}),
        func: async () => {
          return this.listKeys();
        },
      }),

      // 39. create_key
      new DynamicStructuredTool({
        name: "dominusnode_create_key",
        description:
          "Create a new API key for the current account. The key is shown only once on creation.",
        schema: z.object({
          label: z.string().min(1).max(100).optional().describe('Optional label for the API key (e.g., "production")'),
        }),
        func: async ({ label }: Record<string, any>) => {
          return this.createKey(label);
        },
      }),

      // 40. revoke_key
      new DynamicStructuredTool({
        name: "dominusnode_revoke_key",
        description:
          "Revoke (permanently delete) an API key. The key will immediately stop working.",
        schema: z.object({
          keyId: z.string().uuid().describe("UUID of the API key to revoke"),
        }),
        func: async ({ keyId }: Record<string, any>) => {
          return this.revokeKey(keyId);
        },
      }),

      // 41. get_plan
      new DynamicStructuredTool({
        name: "dominusnode_get_plan",
        description:
          "Get the current user's plan details including bandwidth limits, pricing tier, and features.",
        schema: z.object({}),
        func: async () => {
          return this.getPlan();
        },
      }),

      // 42. list_plans
      new DynamicStructuredTool({
        name: "dominusnode_list_plans",
        description:
          "List all available Dominus Node plans with pricing, bandwidth limits, and features.",
        schema: z.object({}),
        func: async () => {
          return this.listPlans();
        },
      }),

      // 43. change_plan
      new DynamicStructuredTool({
        name: "dominusnode_change_plan",
        description:
          "Change the current user's plan. Provide the plan ID of the desired plan from list_plans.",
        schema: z.object({
          planId: z.string().min(1).describe("ID of the plan to switch to"),
        }),
        func: async ({ planId }: Record<string, any>) => {
          return this.changePlan(planId);
        },
      }),

      // 44. team_delete
      new DynamicStructuredTool({
        name: "dominusnode_team_delete",
        description:
          "Delete a team permanently. Requires owner role. All team keys are revoked and members removed.",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID) to delete"),
        }),
        func: async ({ teamId }: Record<string, any>) => {
          return this.teamDelete(teamId);
        },
      }),

      // 45. team_revoke_key
      new DynamicStructuredTool({
        name: "dominusnode_team_revoke_key",
        description:
          "Revoke (delete) a team API key. Requires owner or admin role.",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID)"),
          keyId: z.string().uuid().describe("UUID of the team key to revoke"),
        }),
        func: async ({ teamId, keyId }: Record<string, any>) => {
          return this.teamRevokeKey(teamId, keyId);
        },
      }),

      // 46. team_list_keys
      new DynamicStructuredTool({
        name: "dominusnode_team_list_keys",
        description:
          "List all API keys for a team. Shows key ID, label, prefix, and creation date.",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID)"),
        }),
        func: async ({ teamId }: Record<string, any>) => {
          return this.teamListKeys(teamId);
        },
      }),

      // 47. team_list_members
      new DynamicStructuredTool({
        name: "dominusnode_team_list_members",
        description:
          "List all members of a team with their roles and join dates.",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID)"),
        }),
        func: async ({ teamId }: Record<string, any>) => {
          return this.teamListMembers(teamId);
        },
      }),

      // 48. team_add_member
      new DynamicStructuredTool({
        name: "dominusnode_team_add_member",
        description:
          "Add a member to a team by email address. Optionally specify their role (member or admin).",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID)"),
          email: z.string().email().describe("Email address of the user to add"),
          role: z.enum(["member", "admin"]).optional().describe("Role for the new member (default: member)"),
        }),
        func: async ({ teamId, email, role }: Record<string, any>) => {
          return this.teamAddMember(teamId, email, role);
        },
      }),

      // 49. team_remove_member
      new DynamicStructuredTool({
        name: "dominusnode_team_remove_member",
        description:
          "Remove a member from a team. Requires owner or admin role. Cannot remove the owner.",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID)"),
          userId: z.string().uuid().describe("User ID (UUID) of the member to remove"),
        }),
        func: async ({ teamId, userId }: Record<string, any>) => {
          return this.teamRemoveMember(teamId, userId);
        },
      }),

      // 50. team_invite_member
      new DynamicStructuredTool({
        name: "dominusnode_team_invite_member",
        description:
          "Send a team invitation to an email address. Invited users can accept to join the team.",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID)"),
          email: z.string().email().describe("Email address to invite"),
          role: z.enum(["member", "admin"]).optional().describe("Role for the invited member (default: member)"),
        }),
        func: async ({ teamId, email, role }: Record<string, any>) => {
          return this.teamInviteMember(teamId, email, role);
        },
      }),

      // 51. team_list_invites
      new DynamicStructuredTool({
        name: "dominusnode_team_list_invites",
        description:
          "List all pending invitations for a team. Shows invite ID, email, role, and status.",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID)"),
        }),
        func: async ({ teamId }: Record<string, any>) => {
          return this.teamListInvites(teamId);
        },
      }),

      // 52. team_cancel_invite
      new DynamicStructuredTool({
        name: "dominusnode_team_cancel_invite",
        description:
          "Cancel a pending team invitation. Requires owner or admin role.",
        schema: z.object({
          teamId: z.string().uuid().describe("Team ID (UUID)"),
          inviteId: z.string().uuid().describe("UUID of the invitation to cancel"),
        }),
        func: async ({ teamId, inviteId }: Record<string, any>) => {
          return this.teamCancelInvite(teamId, inviteId);
        },
      }),
    ];
  }
}
