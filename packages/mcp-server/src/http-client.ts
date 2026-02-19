import type { TokenManager } from "./token-manager.js";

const USER_AGENT = "dominusnode-mcp-server/1.0.0";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// R20 H-6: Depth limit prevents stack overflow on deeply nested JSON
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

function addJitter(ms: number): number {
  const jitter = ms * 0.2 * (Math.random() - 0.5);
  return Math.max(100, Math.round(ms + jitter));
}

// ─── MCP Tool Rate Limiter ────────────────────────────────────────
// Prevents MCP clients from spamming API requests.
// Token bucket: MAX_REQUESTS_PER_MINUTE refill rate, burst up to BUCKET_SIZE.
const MCP_RATE_LIMIT_PER_MINUTE = 120; // 2 req/sec sustained
const MCP_BUCKET_SIZE = 20; // Allow bursts up to 20

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private maxTokens: number,
    private refillRate: number, // tokens per ms
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// R18-C3: Maximum response body size for API calls (10MB)
const MAX_API_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface HttpRequestOptions {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  requiresAuth?: boolean;
}

export class HttpClient {
  private rateLimiter: TokenBucket;

  constructor(
    private baseUrl: string,
    private tokenManager: TokenManager,
  ) {
    this.rateLimiter = new TokenBucket(
      MCP_BUCKET_SIZE,
      MCP_RATE_LIMIT_PER_MINUTE / 60_000, // tokens per ms
    );
  }

  async request<T>(opts: HttpRequestOptions): Promise<T> {
    // Token bucket rate limiting: prevents MCP clients from spamming API
    if (!this.rateLimiter.tryConsume()) {
      throw new Error("MCP rate limit exceeded — too many requests. Please slow down.");
    }

    // R22 H-1: Protect base headers from user override
    const PROTECTED_HEADERS = new Set(["user-agent", "content-type", "authorization", "host", "connection", "content-length", "x-dominusnode-agent"]);
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
      "X-DominusNode-Agent": "mcp",
    };
    if (opts.headers) {
      for (const [key, value] of Object.entries(opts.headers)) {
        if (!PROTECTED_HEADERS.has(key.toLowerCase())) {
          headers[key] = value;
        }
      }
    }

    if (opts.requiresAuth !== false) {
      const token = await this.tokenManager.getValidToken();
      headers["Authorization"] = `Bearer ${token}`;
    }

    const url = `${this.baseUrl}${opts.path}`;
    const timeoutMs = 30_000;
    let response: Response;

    try {
      response = await fetch(url, {
        method: opts.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error", // R17: Reject redirects — prevents HTTPS→HTTP credential leakage
      });
    } catch (err) {
      throw new Error(`Network error: ${err instanceof Error ? err.message : "request failed"}`);
    }

    // 429 retry with jitter, cap 10s
    if (response.status === 429) {
      const retryAfterRaw = parseInt(response.headers.get("retry-after") ?? "5", 10);
      const retryAfter = isNaN(retryAfterRaw) ? 5 : retryAfterRaw;
      // R22 C-1: Cancel body instead of buffering — prevents OOM from oversized 429 response
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, addJitter(Math.min(retryAfter * 1000, 10_000))));

      if (opts.requiresAuth !== false) {
        const freshToken = await this.tokenManager.getValidToken();
        headers["Authorization"] = `Bearer ${freshToken}`;
      }

      try {
        response = await fetch(url, {
          method: opts.method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
      } catch (err) {
        throw new Error(`Network error on retry: ${err instanceof Error ? err.message : "request failed"}`);
      }

      // R30 H-2: Prevent fall-through to 401 handler after 429 retry
      if (response.ok) {
        const responseText = await response.text();
        if (responseText.length > MAX_API_RESPONSE_BYTES) {
          throw new Error("Response too large");
        }
        return responseText ? safeJsonParse<T>(responseText) : ({} as T);
      }
      // If retry still failed (non-2xx, non-401), throw immediately
      // R31 C-1: Cancel body instead of buffering — prevents OOM from oversized error response
      if (response.status !== 401) {
        await response.body?.cancel();
        throw new Error(`API error ${response.status} after rate-limit retry`);
      }
      // Only fall through to 401 handler if retry returned 401
    }

    // 401 retry with force refresh
    if (response.status === 401 && opts.requiresAuth !== false) {
      // R26 C-1: Cancel unconsumed 401 response body to free connection + memory
      await response.body?.cancel();
      const newToken = await this.tokenManager.forceRefresh();
      headers["Authorization"] = `Bearer ${newToken}`;
      const retry = await fetch(url, {
        method: opts.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (retry.ok) {
        const text = await retry.text();
        if (text.length > MAX_API_RESPONSE_BYTES) throw new Error("API response exceeded maximum allowed size");
        return text ? safeJsonParse<T>(text) : ({} as T);
      }
      // R22 C-1: Read limited error body to prevent OOM on oversized response
      const retryBody = await retry.text();
      if (retryBody.length > MAX_API_RESPONSE_BYTES) {
        throw new Error("API error response exceeded maximum allowed size");
      }
      let retryMessage = retryBody.slice(0, 500);
      try {
        // R31 H-1: Use safeJsonParse to prevent prototype pollution on error paths
        const parsed = safeJsonParse<Record<string, unknown>>(retryBody);
        retryMessage = (parsed.error as string) ?? (parsed.message as string) ?? retryBody.slice(0, 500);
      } catch { /* use raw text */ }
      throw new Error(`API error ${retry.status}: ${retryMessage}`);
    }

    const responseText = await response.text();
    // R18-C3: Prevent OOM from oversized API response
    if (responseText.length > MAX_API_RESPONSE_BYTES) {
      throw new Error("API response exceeded maximum allowed size");
    }

    if (!response.ok) {
      let message = responseText.slice(0, 500);
      try {
        // R31 H-1: Use safeJsonParse to prevent prototype pollution on error paths
        const parsed = safeJsonParse<Record<string, unknown>>(responseText);
        message = (parsed.error as string) ?? (parsed.message as string) ?? responseText.slice(0, 500);
      } catch { /* use raw text */ }
      throw new Error(`API error ${response.status}: ${message}`);
    }

    return responseText ? safeJsonParse<T>(responseText) : ({} as T);
  }

  /** Store tokens from an external auth flow (e.g., registration in bootstrap mode) */
  storeTokens(accessToken: string, refreshToken: string): void {
    this.tokenManager.setTokens(accessToken, refreshToken);
  }

  async get<T>(path: string, requiresAuth = true): Promise<T> {
    return this.request<T>({ method: "GET", path, requiresAuth });
  }

  async post<T>(path: string, body?: unknown, requiresAuth = true): Promise<T> {
    return this.request<T>({ method: "POST", path, body, requiresAuth });
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>({ method: "DELETE", path });
  }
}
