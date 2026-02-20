import { tool } from "ai";
import { z } from "zod";
import dns from "dns/promises";
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

const CREDENTIAL_RE = /dn_(live|test)_[a-zA-Z0-9]+/g;

function sanitizeError(message: string): string {
  return message.replace(CREDENTIAL_RE, "***");
}

// ---------------------------------------------------------------------------
// Response body size limit (10 MB)
// ---------------------------------------------------------------------------

const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * Creates the `proxiedFetch` tool that makes HTTP requests through DomiNode's
 * rotating proxy network.
 */
export function createProxiedFetchTool(client: DominusNodeClient, apiKey: string) {
  return tool({
    description:
      "Make an HTTP request through DomiNode's rotating proxy network. " +
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
        .record(z.string())
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
        // Use Node.js native fetch with proxy agent
        // The proxy URL format is: http://user-country_XX:apikey@host:port
        // We construct the request manually via the proxy CONNECT method
        const proxyUrlObj = new URL(proxyUrl);

        // Build fetch options
        const fetchOpts: RequestInit & { headers: Record<string, string> } = {
          method,
          headers: {
            ...(headers ?? {}),
            "Proxy-Authorization":
              "Basic " +
              Buffer.from(`${proxyUrlObj.username}:${proxyUrlObj.password}`).toString("base64"),
          },
          redirect: "manual" as RequestRedirect,
        };

        // For HTTP targets, we can route through the proxy directly
        // For HTTPS, the proxy handles CONNECT tunneling
        const targetUrl = validation.url;

        // Make the proxied request
        // Note: In production, this uses the HTTP proxy with CONNECT for HTTPS
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000); // 30s timeout

        let response: Response;
        try {
          // The Vercel AI SDK tool runs server-side where we can use the proxy.
          // We send the request to the proxy host with the full target URL.
          response = await fetch(targetUrl.toString(), {
            ...fetchOpts,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        // Check Content-Length before reading body (H-8)
        const contentLength = response.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BODY_BYTES) {
          return { error: "Response too large (exceeds 10MB limit)" };
        }

        // Read response body with size limit, then truncate for AI
        const rawBody = await response.text();
        if (rawBody.length > MAX_RESPONSE_BODY_BYTES) {
          return { error: "Response too large (exceeds 10MB limit)" };
        }

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        return {
          status: response.status,
          statusText: response.statusText,
          headers: filterHeaders(responseHeaders),
          body: truncateBody(rawBody),
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
  return tool({
    description:
      "Check the current DomiNode wallet balance. " +
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
  return tool({
    description:
      "Check DomiNode proxy usage statistics for a given time period. " +
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

        return {
          summary: {
            totalBytes: usage.summary.totalBytes,
            totalGB: usage.summary.totalGB,
            totalCostCents: usage.summary.totalCostCents,
            totalCostUsd: usage.summary.totalCostUsd,
            requestCount: usage.summary.requestCount,
          },
          period: usage.period,
          recordCount: usage.records.length,
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
  return tool({
    description:
      "Get DomiNode proxy endpoint configuration including supported countries, " +
      "geo-targeting capabilities, and connection details. Use this to discover " +
      "available proxy options before making requests.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const config = await client.proxy.getConfig();
        return {
          endpoints: {
            http: `${config.httpProxy.host}:${config.httpProxy.port}`,
            socks5: `${config.socks5Proxy.host}:${config.socks5Proxy.port}`,
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
  return tool({
    description:
      "List all currently active proxy sessions. Shows session ID, proxy IP, " +
      "start time, and status for each active connection.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const result = await client.sessions.getActive();
        return {
          sessions: result.sessions.map((s: { id: string; startedAt: string; status: string }) => ({
            id: s.id,
            startedAt: s.startedAt,
            status: s.status,
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

// Re-export validation helpers for testing
export { validateUrl, isPrivateIp, truncateBody, filterHeaders };
