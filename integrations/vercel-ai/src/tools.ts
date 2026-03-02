import { tool } from "ai";
import { z } from "zod";
import dns from "dns/promises";
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import type { DominusNodeClient } from "@dominusnode/sdk";

// ---------------------------------------------------------------------------
// SSRF protection helpers
// ---------------------------------------------------------------------------

/** RFC-1918, loopback, link-local, and other non-routable CIDRs. */
function isPrivateIp(hostname: string): boolean {
  // Strip IPv6 brackets if present
  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  // Strip IPv6 zone ID (%...) before validation
  const noZone = bare.replace(/%.*$/, "");

  // IPv4 patterns
  if (/^127\./.test(noZone)) return true;
  if (/^10\./.test(noZone)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(noZone)) return true;
  if (/^192\.168\./.test(noZone)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(noZone)) return true; // CGNAT
  if (/^(22[4-9]|2[3-5]\d)\./.test(noZone)) return true; // multicast + reserved
  if (/^169\.254\./.test(noZone)) return true; // link-local
  if (/^0\./.test(noZone)) return true; // 0.0.0.0/8
  if (noZone === "255.255.255.255") return true;

  // Decimal/octal/hex IP obfuscation — reject anything that looks numeric but isn't a normal dotted-quad
  if (/^0x[0-9a-fA-F]+$/.test(noZone)) return true; // hex single-int
  if (/^0\d+$/.test(noZone)) return true; // octal single-int
  if (/^\d+$/.test(noZone) && !noZone.includes(".")) return true; // decimal single-int

  // IPv6 patterns
  if (noZone === "::1") return true;
  if (/^::ffff:/i.test(noZone)) {
    const embedded = noZone.slice(7);
    if (embedded.includes(".")) return isPrivateIp(embedded);
    return true;
  }
  // IPv4-compatible (::x.x.x.x) — deprecated but still parsed
  const ipv4CompatMatch = noZone.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4CompatMatch) {
    return isPrivateIp(ipv4CompatMatch[1]);
  }
  if (/^fd[0-9a-fA-F]{2}:/i.test(noZone)) return true; // ULA fd00::/8
  if (/^fc[0-9a-fA-F]{2}:/i.test(noZone)) return true; // ULA fc00::/7
  if (/^fe[89abAB][0-9a-fA-F]:/i.test(noZone)) return true; // link-local fe80::/10
  if (noZone === "::") return true; // unspecified

  // Teredo (2001:0000::/32) — block unconditionally
  if (noZone.startsWith("2001:0000:") || noZone.startsWith("2001:0:")) return true;

  // 6to4 (2002::/16) — block unconditionally
  if (noZone.startsWith("2002:")) return true;

  // IPv6 multicast (ff00::/8)
  if (noZone.startsWith("ff")) return true;

  return false;
}

/** Validate a URL is safe to fetch through the proxy. */
function validateUrl(urlStr: string): { valid: true; url: URL } | { valid: false; error: string } {
  // Length limit
  if (urlStr.length > 2048) {
    return { valid: false, error: "URL exceeds maximum length of 2048 characters" };
  }

  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  // Protocol check — only http(s)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { valid: false, error: `Unsupported protocol: ${url.protocol} — only http and https are allowed` };
  }

  // Hostname must be present
  if (!url.hostname) {
    return { valid: false, error: "URL must contain a hostname" };
  }

  // Block localhost variants
  const lowerHost = url.hostname.toLowerCase();
  if (
    lowerHost === "localhost" ||
    lowerHost === "localhost." ||
    lowerHost.endsWith(".localhost") ||
    lowerHost.endsWith(".localhost.")
  ) {
    return { valid: false, error: "Requests to localhost are not allowed" };
  }

  // Block internal network TLDs
  if (lowerHost.endsWith(".local") || lowerHost.endsWith(".internal") || lowerHost.endsWith(".arpa")) {
    return { valid: false, error: "Requests to internal network hostnames are not allowed" };
  }

  // Block private/reserved IPs
  if (isPrivateIp(url.hostname)) {
    return { valid: false, error: "Requests to private/reserved IP addresses are not allowed" };
  }

  // Block credentials in URL (user:pass@host)
  if (url.username || url.password) {
    return { valid: false, error: "URLs with embedded credentials are not allowed" };
  }

  return { valid: true, url };
}

/** Maximum response body length returned to the AI model. */
const MAX_BODY_LENGTH = 4000;

/** Truncate a string and append a notice if it exceeds the limit. */
function truncateBody(body: string): string {
  if (body.length <= MAX_BODY_LENGTH) return body;
  return body.slice(0, MAX_BODY_LENGTH) + `\n...[truncated, ${body.length - MAX_BODY_LENGTH} chars omitted]`;
}

// ---------------------------------------------------------------------------
// Safe header subset — never forward sensitive headers to the AI
// ---------------------------------------------------------------------------
const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "date",
  "server",
  "cache-control",
  "etag",
  "last-modified",
  "x-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
]);

function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SAFE_RESPONSE_HEADERS.has(key.toLowerCase())) {
      result[key.toLowerCase()] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// OFAC sanctioned countries
// ---------------------------------------------------------------------------

const SANCTIONED_COUNTRIES = new Set(["CU", "IR", "KP", "RU", "SY"]);

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
// Credential sanitization for error messages
// ---------------------------------------------------------------------------

const CREDENTIAL_RE = /dn_(live|test)_[a-zA-Z0-9]+|eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g;

function sanitizeError(message: string): string {
  return message.replace(CREDENTIAL_RE, "***");
}

// ---------------------------------------------------------------------------
// Prototype pollution prevention
// ---------------------------------------------------------------------------

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function stripDangerousKeys(obj: unknown, depth = 0): void {
  if (depth > 50 || obj == null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripDangerousKeys(item, depth + 1);
  } else {
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(key)) {
        delete (obj as Record<string, unknown>)[key];
      } else {
        stripDangerousKeys((obj as Record<string, unknown>)[key], depth + 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Agentic wallet validation helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

// ---------------------------------------------------------------------------
// Response body size limit (10 MB)
// ---------------------------------------------------------------------------

const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * Creates the `proxiedFetch` tool that makes HTTP requests through Dominus Node's
 * rotating proxy network.
 */
export function createProxiedFetchTool(client: DominusNodeClient, apiKey: string) {
  return (tool as any)({
    description:
      "Make an HTTP request through Dominus Node's rotating proxy network. " +
      "Supports geo-targeting by country and choice of datacenter (dc) or residential proxy. " +
      "Use this to fetch web pages, APIs, or any HTTP resource through a proxy IP.",
    parameters: z.object({
      url: z.string().max(2048).url().describe("The URL to fetch through the proxy"),
      method: z
        .enum(["GET", "HEAD", "OPTIONS"])
        .default("GET")
        .describe("HTTP method to use (only read-only methods allowed)"),
      country: z
        .string()
        .max(2)
        .optional()
        .describe("ISO 3166-1 alpha-2 country code for geo-targeting (e.g. 'US', 'GB', 'DE')"),
      proxyType: z
        .enum(["dc", "residential"])
        .default("dc")
        .describe("Proxy pool type: 'dc' for datacenter ($3/GB) or 'residential' ($5/GB)"),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional HTTP headers to include in the request"),
    }),
    execute: async ({ url, method, country, proxyType, headers }: { url: string; method: "GET" | "HEAD" | "OPTIONS"; country?: string; proxyType: "dc" | "residential"; headers?: Record<string, string> }) => {
      // SSRF validation
      const validation = validateUrl(url);
      if (!validation.valid) {
        return { error: validation.error };
      }

      // OFAC sanctioned country check
      if (country && SANCTIONED_COUNTRIES.has(country.toUpperCase())) {
        return { error: `Country '${country.toUpperCase()}' is blocked (OFAC sanctioned)` };
      }

      // DNS rebinding protection
      try {
        await checkDnsRebinding(validation.url.hostname);
      } catch (err) {
        return { error: err instanceof Error ? err.message : "DNS validation failed" };
      }

      // Build the proxy URL using the SDK
      const proxyUrl = client.proxy.buildUrl(apiKey, {
        protocol: "http",
        country,
      });

      try {
        const proxyUrlObj = new URL(proxyUrl);
        const proxyHost = proxyUrlObj.hostname;
        const proxyPort = parseInt(proxyUrlObj.port || "8080", 10);
        const proxyAuth =
          "Basic " +
          Buffer.from(`${proxyUrlObj.username}:${proxyUrlObj.password}`).toString("base64");

        // Validate custom headers for CRLF injection
        const STRIPPED_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "proxy-authorization", "authorization", "user-agent"]);
        const safeHeaders: Record<string, string> = {};
        if (headers) {
          for (const [k, v] of Object.entries(headers)) {
            if (/[\r\n\0]/.test(k) || /[\r\n\0]/.test(v)) {
              return { error: `Header "${k.replace(/[\r\n\0]/g, "")}" contains invalid characters` };
            }
            if (!STRIPPED_HEADERS.has(k.toLowerCase())) {
              safeHeaders[k] = v;
            }
          }
        }

        const targetUrl = validation.url;
        const MAX_RESP = 1_048_576; // 1MB

        const result = await new Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Proxy request timed out")), 30_000);

          const customHeaderLines = Object.entries(safeHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join("");

          if (targetUrl.protocol === "https:") {
            // HTTPS: use CONNECT tunnel through proxy
            const connectHost = targetUrl.hostname.includes(":") ? `[${targetUrl.hostname}]` : targetUrl.hostname;
            const connectReq = http.request({
              hostname: proxyHost, port: proxyPort, method: "CONNECT",
              path: `${connectHost}:${targetUrl.port || 443}`,
              headers: { "Proxy-Authorization": proxyAuth, Host: `${connectHost}:${targetUrl.port || 443}` },
            });
            connectReq.on("connect", (_res, sock) => {
              if (_res.statusCode !== 200) { clearTimeout(timer); sock.destroy(); reject(new Error(`CONNECT failed: ${_res.statusCode}`)); return; }
              const tlsSock = tls.connect({ host: targetUrl.hostname, socket: sock as net.Socket, servername: targetUrl.hostname, minVersion: "TLSv1.2" }, () => {
                const reqLine = `${method} ${targetUrl.pathname + targetUrl.search} HTTP/1.1\r\nHost: ${targetUrl.host}\r\nUser-Agent: dominusnode-vercel-ai/1.0.0\r\n${customHeaderLines}Connection: close\r\n\r\n`;
                tlsSock.write(reqLine);
                const chunks: Buffer[] = []; let bytes = 0;
                tlsSock.on("data", (c: Buffer) => { bytes += c.length; if (bytes <= MAX_RESP + 16384) chunks.push(c); });
                let done = false;
                const fin = () => { if (done) return; done = true; clearTimeout(timer);
                  const raw = Buffer.concat(chunks).toString("utf-8");
                  const hEnd = raw.indexOf("\r\n\r\n");
                  if (hEnd === -1) { reject(new Error("Malformed response")); return; }
                  const hdr = raw.substring(0, hEnd); const body = raw.substring(hEnd + 4).substring(0, MAX_RESP);
                  const sm = hdr.split("\r\n")[0].match(/^HTTP\/\d\.\d\s+(\d+)\s*(.*)/);
                  const hdrs: Record<string, string> = {};
                  for (const l of hdr.split("\r\n").slice(1)) { const ci = l.indexOf(":"); if (ci > 0) hdrs[l.substring(0, ci).trim().toLowerCase()] = l.substring(ci + 1).trim(); }
                  stripDangerousKeys(hdrs);
                  resolve({ status: sm ? parseInt(sm[1], 10) : 0, statusText: sm ? sm[2] ?? "" : "", headers: hdrs, body });
                };
                tlsSock.on("end", fin); tlsSock.on("close", fin);
                tlsSock.on("error", (e) => { clearTimeout(timer); reject(e); });
              });
              tlsSock.on("error", (e) => { clearTimeout(timer); reject(e); });
            });
            connectReq.on("error", (e) => { clearTimeout(timer); reject(e); });
            connectReq.end();
          } else {
            // HTTP: route through proxy with full URL as request path
            const req = http.request({
              hostname: proxyHost, port: proxyPort, method, path: targetUrl.toString(),
              headers: { "Proxy-Authorization": proxyAuth, Host: targetUrl.host ?? "", ...safeHeaders },
            }, (res) => {
              const chunks: Buffer[] = []; let bytes = 0;
              res.on("data", (c: Buffer) => { bytes += c.length; if (bytes <= MAX_RESP) chunks.push(c); });
              let done = false;
              const fin = () => { if (done) return; done = true; clearTimeout(timer);
                const body = Buffer.concat(chunks).toString("utf-8").substring(0, MAX_RESP);
                const hdrs: Record<string, string> = {};
                for (const [k, v] of Object.entries(res.headers)) { if (v) hdrs[k] = Array.isArray(v) ? v.join(", ") : v; }
                stripDangerousKeys(hdrs);
                resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers: hdrs, body });
              };
              res.on("end", fin); res.on("close", fin);
              res.on("error", (e) => { clearTimeout(timer); reject(e); });
            });
            req.on("error", (e) => { clearTimeout(timer); reject(e); });
            req.end();
          }
        });

        // Check response size
        if (result.body.length > MAX_RESPONSE_BODY_BYTES) {
          return { error: "Response too large (exceeds 10MB limit)" };
        }

        return {
          status: result.status,
          statusText: result.statusText,
          headers: filterHeaders(result.headers),
          body: truncateBody(result.body),
          proxyType,
          country: country ?? "auto",
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          error: `Proxy request failed: ${sanitizeError(message)}`,
        };
      }
    },
  });
}

/**
 * Creates the `checkBalance` tool that retrieves the current wallet balance.
 */
export function createCheckBalanceTool(client: DominusNodeClient) {
  return (tool as any)({
    description:
      "Check the current Dominus Node wallet balance. " +
      "Returns balance in cents and USD. Use this before making proxy requests " +
      "to ensure sufficient funds.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const balance = await client.wallet.getBalance();
        return {
          balanceCents: balance.balanceCents,
          balanceUsd: balance.balanceUsd,
          currency: balance.currency,
          lastToppedUp: balance.lastToppedUp,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return { error: `Failed to check balance: ${sanitizeError(message)}` };
      }
    },
  });
}

/**
 * Creates the `checkUsage` tool that retrieves usage statistics.
 */
export function createCheckUsageTool(client: DominusNodeClient) {
  return (tool as any)({
    description:
      "Check Dominus Node proxy usage statistics for a given time period. " +
      "Returns total bytes transferred, cost, and request count.",
    parameters: z.object({
      period: z
        .enum(["day", "week", "month"])
        .optional()
        .describe("Time period for usage statistics: 'day' (last 24h), 'week' (last 7d), or 'month' (last 30d)"),
    }),
    execute: async ({ period }: { period?: "day" | "week" | "month" }) => {
      try {
        // Calculate date range based on period
        const now = new Date();
        let since: string | undefined;

        if (period === "day") {
          const d = new Date(now);
          d.setDate(d.getDate() - 1);
          since = d.toISOString();
        } else if (period === "week") {
          const d = new Date(now);
          d.setDate(d.getDate() - 7);
          since = d.toISOString();
        } else if (period === "month") {
          const d = new Date(now);
          d.setDate(d.getDate() - 30);
          since = d.toISOString();
        }

        const usage = await client.usage.get({
          from: since,
          to: now.toISOString(),
          limit: 100,
        });

        const summary = usage.summary as unknown as Record<string, unknown>;
        const records = usage.records as unknown[];

        return {
          summary: {
            totalBytes: summary.totalBytes,
            totalGB: summary.totalGB,
            totalCostCents: summary.totalCostCents,
            totalCostUsd: summary.totalCostUsd,
            requestCount: summary.requestCount,
          },
          period: usage.period,
          recordCount: records.length,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return { error: `Failed to check usage: ${sanitizeError(message)}` };
      }
    },
  });
}

/**
 * Creates the `getProxyConfig` tool that retrieves proxy endpoint configuration.
 */
export function createGetProxyConfigTool(client: DominusNodeClient) {
  return (tool as any)({
    description:
      "Get Dominus Node proxy endpoint configuration including supported countries, " +
      "geo-targeting capabilities, and connection details. Use this to discover " +
      "available proxy options before making requests.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const config = await client.proxy.getConfig();
        const httpProxy = config.httpProxy as Record<string, unknown>;
        const socks5Proxy = config.socks5Proxy as Record<string, unknown>;
        return {
          endpoints: {
            http: `${httpProxy.host}:${httpProxy.port}`,
            socks5: `${socks5Proxy.host}:${socks5Proxy.port}`,
          },
          supportedCountries: config.supportedCountries,
          blockedCountries: config.blockedCountries,
          geoTargeting: config.geoTargeting ?? {
            stateSupport: false,
            citySupport: false,
            asnSupport: false,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return { error: `Failed to get proxy config: ${sanitizeError(message)}` };
      }
    },
  });
}

/**
 * Creates the `listSessions` tool that lists active proxy sessions.
 */
export function createListSessionsTool(client: DominusNodeClient) {
  return (tool as any)({
    description:
      "List all currently active proxy sessions. Shows session ID, " +
      "start time, and status for each active connection.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const result = await client.sessions.getActive();
        return {
          sessions: result.sessions.map((s: any) => ({
            id: String(s.id ?? ""),
            startedAt: String(s.startedAt ?? ""),
            status: String(s.status ?? ""),
          })),
          count: result.sessions.length,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return { error: `Failed to list sessions: ${sanitizeError(message)}` };
      }
    },
  });
}

/**
 * Creates the `topupPaypal` tool that initiates a PayPal wallet top-up.
 */
export function createTopupPaypalTool(client: DominusNodeClient) {
  return (tool as any)({
    description:
      "Top up your Dominus Node wallet balance via PayPal. " +
      "Creates a PayPal order and returns an approval URL to complete payment. " +
      "Minimum $5 (500 cents), maximum $1,000 (100,000 cents).",
    parameters: z.object({
      amount_cents: z
        .number()
        .int()
        .min(500)
        .max(100000)
        .describe("Amount in cents to top up (min 500 = $5, max 100000 = $1,000)"),
    }),
    execute: async ({ amount_cents }: { amount_cents: number }) => {
      try {
        const result = await (client as any).wallet.topupPaypal({ amountCents: amount_cents });
        return {
          orderId: result.orderId,
          approvalUrl: result.approvalUrl,
          amountCents: result.amountCents,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return { error: `Failed to create PayPal top-up: ${sanitizeError(message)}` };
      }
    },
  });
}

/**
 * Creates the `x402Info` tool that retrieves x402 micropayment protocol information.
 */
export function createX402InfoTool(client: DominusNodeClient) {
  return (tool as any)({
    description:
      "Get x402 micropayment protocol information including supported " +
      "facilitators, pricing, and payment options.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const result = await client.x402.getInfo();
        if (result && typeof result === "object") {
          stripDangerousKeys(result);
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return { error: `Failed to get x402 info: ${sanitizeError(message)}` };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Authenticated API request helper
// ---------------------------------------------------------------------------

/** Make an authenticated JSON request to the Dominus Node REST API. */
async function apiRequest(
  client: DominusNodeClient,
  method: "GET" | "POST" | "DELETE" | "PATCH",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Use client's baseUrl and apiKey for authentication
  const baseUrl = (client as any).baseUrl || "https://api.dominusnode.com";
  const apiKey = (client as any).apiKey || "";
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const fetchOptions: RequestInit = { method, headers, redirect: "error" };
  if (body && method !== "GET") {
    fetchOptions.body = JSON.stringify(body);
  }

  const resp = await fetch(url, fetchOptions);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API returned ${resp.status}: ${sanitizeError(text.slice(0, 200))}`);
  }

  const text = await resp.text();
  if (text.length > MAX_RESPONSE_BODY_BYTES) {
    throw new Error("Response body exceeds 10MB size limit");
  }

  const data = JSON.parse(text);
  stripDangerousKeys(data);
  return data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Agentic wallet tool definitions
// ---------------------------------------------------------------------------

/**
 * Creates a tool to create a new agentic sub-wallet with a spending limit.
 */
export function createCreateAgenticWalletTool(client: DominusNodeClient) {
  return (tool as any)({
    description:
      "Create a new agentic sub-wallet with a spending limit. " +
      "Agentic wallets are custodial sub-wallets for AI agents with per-transaction spending caps.",
    parameters: z.object({
      label: z.string().min(1).max(100).describe("Human-readable label for the wallet"),
      spending_limit_cents: z.number().int().min(1).max(2147483647).describe("Per-transaction spending limit in cents"),
      daily_limit_cents: z.number().int().min(1).max(1000000).optional().describe("Optional daily spending limit in cents"),
      allowed_domains: z.array(z.string().max(253).regex(DOMAIN_RE)).max(100).optional().describe("Optional list of allowed domains"),
    }),
    execute: async ({ label, spending_limit_cents, daily_limit_cents, allowed_domains }: {
      label: string; spending_limit_cents: number; daily_limit_cents?: number; allowed_domains?: string[];
    }) => {
      // Validate no control chars in label
      if (/[\x00-\x1F\x7F]/.test(label)) {
        return { error: "label contains invalid control characters" };
      }
      try {
        const body: Record<string, unknown> = { label, spendingLimitCents: spending_limit_cents };
        if (daily_limit_cents !== undefined) body.dailyLimitCents = daily_limit_cents;
        if (allowed_domains !== undefined) body.allowedDomains = allowed_domains;
        const result = await apiRequest(client, "POST", "/api/agent-wallet", body);
        return result;
      } catch (err) {
        return { error: `Failed to create agentic wallet: ${sanitizeError(err instanceof Error ? err.message : "Unknown error")}` };
      }
    },
  });
}

/**
 * Creates a tool to transfer funds from the main wallet to an agentic sub-wallet.
 */
export function createFundAgenticWalletTool(client: DominusNodeClient) {
  return (tool as any)({
    description: "Transfer funds from the main wallet to an agentic sub-wallet.",
    parameters: z.object({
      wallet_id: z.string().regex(UUID_RE, "Must be a valid UUID").describe("UUID of the agentic wallet"),
      amount_cents: z.number().int().min(1).max(2147483647).describe("Amount in cents to transfer"),
    }),
    execute: async ({ wallet_id, amount_cents }: { wallet_id: string; amount_cents: number }) => {
      try {
        return await apiRequest(client, "POST", `/api/agent-wallet/${encodeURIComponent(wallet_id)}/fund`, { amountCents: amount_cents });
      } catch (err) {
        return { error: `Failed to fund wallet: ${sanitizeError(err instanceof Error ? err.message : "Unknown error")}` };
      }
    },
  });
}

/**
 * Creates a tool to check the balance and details of an agentic sub-wallet.
 */
export function createAgenticWalletBalanceTool(client: DominusNodeClient) {
  return (tool as any)({
    description: "Check the balance and details of an agentic sub-wallet.",
    parameters: z.object({
      wallet_id: z.string().regex(UUID_RE, "Must be a valid UUID").describe("UUID of the agentic wallet"),
    }),
    execute: async ({ wallet_id }: { wallet_id: string }) => {
      try {
        return await apiRequest(client, "GET", `/api/agent-wallet/${encodeURIComponent(wallet_id)}`);
      } catch (err) {
        return { error: `Failed to get wallet balance: ${sanitizeError(err instanceof Error ? err.message : "Unknown error")}` };
      }
    },
  });
}

/**
 * Creates a tool to list all agentic sub-wallets for the current user.
 */
export function createListAgenticWalletsTool(client: DominusNodeClient) {
  return (tool as any)({
    description: "List all agentic sub-wallets for the current user.",
    parameters: z.object({}),
    execute: async () => {
      try {
        return await apiRequest(client, "GET", "/api/agent-wallet");
      } catch (err) {
        return { error: `Failed to list wallets: ${sanitizeError(err instanceof Error ? err.message : "Unknown error")}` };
      }
    },
  });
}

/**
 * Creates a tool to list recent transactions for an agentic sub-wallet.
 */
export function createAgenticTransactionsTool(client: DominusNodeClient) {
  return (tool as any)({
    description: "List recent transactions for an agentic sub-wallet.",
    parameters: z.object({
      wallet_id: z.string().regex(UUID_RE, "Must be a valid UUID").describe("UUID of the agentic wallet"),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum transactions to return (1-100)"),
    }),
    execute: async ({ wallet_id, limit }: { wallet_id: string; limit?: number }) => {
      try {
        const qs = limit ? `?limit=${limit}` : "";
        return await apiRequest(client, "GET", `/api/agent-wallet/${encodeURIComponent(wallet_id)}/transactions${qs}`);
      } catch (err) {
        return { error: `Failed to get transactions: ${sanitizeError(err instanceof Error ? err.message : "Unknown error")}` };
      }
    },
  });
}

/**
 * Creates a tool to freeze an agentic sub-wallet to prevent further spending.
 */
export function createFreezeAgenticWalletTool(client: DominusNodeClient) {
  return (tool as any)({
    description: "Freeze an agentic sub-wallet to prevent further spending.",
    parameters: z.object({
      wallet_id: z.string().regex(UUID_RE, "Must be a valid UUID").describe("UUID of the agentic wallet"),
    }),
    execute: async ({ wallet_id }: { wallet_id: string }) => {
      try {
        return await apiRequest(client, "POST", `/api/agent-wallet/${encodeURIComponent(wallet_id)}/freeze`);
      } catch (err) {
        return { error: `Failed to freeze wallet: ${sanitizeError(err instanceof Error ? err.message : "Unknown error")}` };
      }
    },
  });
}

/**
 * Creates a tool to unfreeze a previously frozen agentic sub-wallet.
 */
export function createUnfreezeAgenticWalletTool(client: DominusNodeClient) {
  return (tool as any)({
    description: "Unfreeze a previously frozen agentic sub-wallet to re-enable spending.",
    parameters: z.object({
      wallet_id: z.string().regex(UUID_RE, "Must be a valid UUID").describe("UUID of the agentic wallet"),
    }),
    execute: async ({ wallet_id }: { wallet_id: string }) => {
      try {
        return await apiRequest(client, "POST", `/api/agent-wallet/${encodeURIComponent(wallet_id)}/unfreeze`);
      } catch (err) {
        return { error: `Failed to unfreeze wallet: ${sanitizeError(err instanceof Error ? err.message : "Unknown error")}` };
      }
    },
  });
}

/**
 * Creates a tool to delete an agentic sub-wallet. Must be active (not frozen).
 * Remaining balance returns to main wallet.
 */
export function createDeleteAgenticWalletTool(client: DominusNodeClient) {
  return (tool as any)({
    description: "Delete an agentic sub-wallet. Must be active (not frozen). Remaining balance returns to main wallet.",
    parameters: z.object({
      wallet_id: z.string().regex(UUID_RE, "Must be a valid UUID").describe("UUID of the agentic wallet"),
    }),
    execute: async ({ wallet_id }: { wallet_id: string }) => {
      try {
        return await apiRequest(client, "DELETE", `/api/agent-wallet/${encodeURIComponent(wallet_id)}`);
      } catch (err) {
        return { error: `Failed to delete wallet: ${sanitizeError(err instanceof Error ? err.message : "Unknown error")}` };
      }
    },
  });
}

/**
 * Creates a tool to update the policy (daily limit, allowed domains) of an agentic sub-wallet.
 */
export function createUpdateWalletPolicyTool(client: DominusNodeClient) {
  return (tool as any)({
    description: "Update the policy (daily limit, allowed domains) of an agentic sub-wallet.",
    parameters: z.object({
      wallet_id: z.string().regex(UUID_RE, "Must be a valid UUID").describe("UUID of the agentic wallet"),
      daily_limit_cents: z.number().int().min(1).max(1000000).optional().describe("New daily spending limit in cents"),
      allowed_domains: z.array(z.string().max(253).regex(DOMAIN_RE)).max(100).optional().describe("New allowed domains list"),
    }),
    execute: async ({ wallet_id, daily_limit_cents, allowed_domains }: {
      wallet_id: string; daily_limit_cents?: number; allowed_domains?: string[];
    }) => {
      const body: Record<string, unknown> = {};
      if (daily_limit_cents !== undefined) body.dailyLimitCents = daily_limit_cents;
      if (allowed_domains !== undefined) body.allowedDomains = allowed_domains;
      if (Object.keys(body).length === 0) {
        return { error: "At least one of daily_limit_cents or allowed_domains must be provided" };
      }
      try {
        return await apiRequest(client, "PATCH", `/api/agent-wallet/${encodeURIComponent(wallet_id)}/policy`, body);
      } catch (err) {
        return { error: `Failed to update policy: ${sanitizeError(err instanceof Error ? err.message : "Unknown error")}` };
      }
    },
  });
}

// Re-export validation helpers for testing
export { validateUrl, isPrivateIp, truncateBody, filterHeaders, apiRequest, UUID_RE, DOMAIN_RE };
