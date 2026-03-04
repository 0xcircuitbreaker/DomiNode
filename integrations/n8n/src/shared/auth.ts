/**
 * Authentication and security utilities for the Dominus Node n8n integration.
 *
 * Provides:
 * - Credential sanitization (redact dn_live_/dn_test_ keys from errors)
 * - Prototype pollution prevention (strip dangerous keys from parsed JSON)
 * - DNS rebinding protection (resolve hostnames, check all IPs)
 * - Authenticated HTTP client for the Dominus Node REST API
 *
 * @module
 */

import dns from "dns/promises";
import { isPrivateIp } from "./ssrf";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CREDENTIAL_RE = /dn_(live|test)_[a-zA-Z0-9]+/g;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const SANCTIONED_COUNTRIES = new Set(["CU", "IR", "KP", "RU", "SY"]);

export { SANCTIONED_COUNTRIES };

// ---------------------------------------------------------------------------
// Credential sanitization
// ---------------------------------------------------------------------------

/**
 * Redact Dominus Node API keys from error messages to prevent credential leakage.
 */
export function sanitizeError(message: string): string {
  return message.replace(CREDENTIAL_RE, "***");
}

// ---------------------------------------------------------------------------
// Prototype pollution prevention
// ---------------------------------------------------------------------------

/**
 * Recursively remove __proto__, constructor, and prototype keys from an object.
 * Prevents prototype pollution when parsing untrusted JSON.
 */
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

/**
 * Parse JSON safely, stripping prototype pollution vectors.
 */
export function safeJsonParse<T>(text: string): T {
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
export async function checkDnsRebinding(hostname: string): Promise<void> {
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
  } catch (err) {
    // Re-throw if we detected a private IPv6 address
    if (err instanceof Error && err.message.includes("private IPv6")) throw err;
    // IPv6 resolution failure is acceptable
  }
}

// ---------------------------------------------------------------------------
// Period to date range helper
// ---------------------------------------------------------------------------

/**
 * Convert a human-readable period string to ISO date range.
 * Backend expects since/until ISO dates, NOT a days integer.
 */
export function periodToDateRange(period: string): { since: string; until: string } {
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
// DominusNodeAuth — authenticated HTTP client
// ---------------------------------------------------------------------------

/**
 * Authenticated HTTP client for the Dominus Node REST API.
 *
 * Lazily authenticates on first request using the API key via the
 * /api/auth/verify-key endpoint. Automatically retries on 401 (token expired).
 */
export class DominusNodeAuth {
  private token: string | null = null;
  private authPromise: Promise<void> | null = null;

  private agentSecret?: string;

  constructor(
    private apiKey: string,
    private baseUrl: string,
    private timeoutMs: number = 30000,
    agentSecret?: string,
  ) {
    if (!apiKey || typeof apiKey !== "string") {
      throw new Error("apiKey is required and must be a non-empty string");
    }
    this.agentSecret = agentSecret || process.env.DOMINUSNODE_AGENT_SECRET;
  }

  /**
   * Ensure the client is authenticated. Lazily authenticates on first call.
   * Concurrent calls share the same auth promise to avoid duplicate requests.
   */
  async ensureAuth(): Promise<void> {
    if (this.token) return;
    if (!this.authPromise) {
      this.authPromise = this.authenticate().finally(() => {
        this.authPromise = null;
      });
    }
    await this.authPromise;
  }

  /**
   * Make an authenticated API request.
   *
   * @param method - HTTP method (GET, POST, PATCH, DELETE)
   * @param path - API path (e.g., /api/wallet)
   * @param body - Optional request body (will be JSON-serialized)
   * @returns Parsed response body
   * @throws {Error} On HTTP errors or response size violations
   */
  async apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    await this.ensureAuth();

    if (!this.token) throw new Error("Not authenticated");

    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      "User-Agent": "n8n-nodes-dominusnode/1.0.0",
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
    };

    if (this.agentSecret) {
      headers["X-DominusNode-Agent"] = "mcp";
      headers["X-DominusNode-Agent-Secret"] = this.agentSecret;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
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
      // On 401, clear token so ensureAuth will re-authenticate
      if (response.status === 401) {
        this.token = null;
      }
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

  /**
   * Clear auth token, forcing re-authentication on next request.
   */
  clearToken(): void {
    this.token = null;
  }

  private async authenticate(): Promise<void> {
    const authHeaders: Record<string, string> = {
      "User-Agent": "n8n-nodes-dominusnode/1.0.0",
      "Content-Type": "application/json",
    };
    if (this.agentSecret) {
      authHeaders["X-DominusNode-Agent"] = "mcp";
      authHeaders["X-DominusNode-Agent-Secret"] = this.agentSecret;
    }

    const response = await fetch(`${this.baseUrl}/api/auth/verify-key`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ apiKey: this.apiKey }),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error",
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Authentication failed (${response.status}): ${sanitizeError(text.slice(0, 500))}`);
    }

    const data = safeJsonParse<{ token: string }>(await response.text());
    if (!data.token) {
      throw new Error("Authentication response missing token");
    }
    this.token = data.token;
  }
}
