import type { TokenManager } from "./token-manager.js";

const USER_AGENT = "dominusnode-mcp-server/1.0.0";

// Scrub credential patterns from error messages before returning to MCP client
const CREDENTIAL_PATTERNS = [
  /dn_live_[A-Za-z0-9_-]+/g,
  /dn_test_[A-Za-z0-9_-]+/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
];

function scrubCredentials(msg: string): string {
  let result = msg;
  for (const pattern of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Depth limit prevents stack overflow on deeply nested JSON
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

// Maximum response body size for API calls (10MB)
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
  private mcpAgentSecret: string;

  constructor(
    private baseUrl: string,
    private tokenManager: TokenManager,
    mcpAgentSecret = "",
  ) {
    this.mcpAgentSecret = mcpAgentSecret;
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

    // Protect base headers from user override
    const PROTECTED_HEADERS = new Set(["user-agent", "content-type", "authorization", "host", "connection", "content-length", "x-dominusnode-agent", "x-dominusnode-agent-secret"]);
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
      "X-DominusNode-Agent": "mcp",
    };
    // Send shared secret for auto-verification (if configured)
    if (this.mcpAgentSecret) {
      headers["X-DominusNode-Agent-Secret"] = this.mcpAgentSecret;
    }
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
        redirect: "error", // Reject redirects — prevents HTTPS→HTTP credential leakage
      });
    } catch (err) {
      throw new Error(scrubCredentials(`Network error: ${err instanceof Error ? err.message : "request failed"}`));
    }

    // 429 retry with jitter, cap 10s
    // NOTE: Safe for POST/PATCH/DELETE because a 429 response means the backend
    // rate limiter rejected the request BEFORE processing — no mutation occurred.
    if (response.status === 429) {
      const retryAfterRaw = parseInt(response.headers.get("retry-after") ?? "5", 10);
      const retryAfter = isNaN(retryAfterRaw) ? 5 : retryAfterRaw;
      // Cancel body instead of buffering — prevents OOM from oversized 429 response
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
        throw new Error(scrubCredentials(`Network error on retry: ${err instanceof Error ? err.message : "request failed"}`));
      }

      // Prevent fall-through to 401 handler after 429 retry
      if (response.ok) {
        const responseText = await response.text();
        if (responseText.length > MAX_API_RESPONSE_BYTES) {
          throw new Error("Response too large");
        }
        return responseText ? safeJsonParse<T>(responseText) : ({} as T);
      }
      // If retry still failed (non-2xx, non-401), throw immediately
      // Cancel body instead of buffering — prevents OOM from oversized error response
      if (response.status !== 401) {
        await response.body?.cancel();
        throw new Error(`API error ${response.status} after rate-limit retry`);
      }
      // Only fall through to 401 handler if retry returned 401
    }

    // 401 retry with force refresh
    // NOTE: Safe for POST/PATCH/DELETE because a 401 means auth rejected BEFORE
    // processing — no mutation occurred. Retrying with a fresh token is the first actual attempt.
    if (response.status === 401 && opts.requiresAuth !== false) {
      // Cancel unconsumed 401 response body to free connection + memory
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
      // Read limited error body to prevent OOM on oversized response
      const retryBody = await retry.text();
      if (retryBody.length > MAX_API_RESPONSE_BYTES) {
        throw new Error("API error response exceeded maximum allowed size");
      }
      let retryMessage = retryBody.slice(0, 500);
      try {
        // Use safeJsonParse to prevent prototype pollution on error paths
        const parsed = safeJsonParse<Record<string, unknown>>(retryBody);
        retryMessage = (parsed.error as string) ?? (parsed.message as string) ?? retryBody.slice(0, 500);
      } catch { /* use raw text */ }
      throw new Error(scrubCredentials(`API error ${retry.status}: ${retryMessage}`));
    }

    const responseText = await response.text();
    // Prevent OOM from oversized API response
    if (responseText.length > MAX_API_RESPONSE_BYTES) {
      throw new Error("API response exceeded maximum allowed size");
    }

    if (!response.ok) {
      let message = responseText.slice(0, 500);
      try {
        // Use safeJsonParse to prevent prototype pollution on error paths
        const parsed = safeJsonParse<Record<string, unknown>>(responseText);
        message = (parsed.error as string) ?? (parsed.message as string) ?? responseText.slice(0, 500);
      } catch { /* use raw text */ }
      throw new Error(scrubCredentials(`API error ${response.status}: ${message}`));
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

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>({ method: "PATCH", path, body });
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>({ method: "PUT", path, body });
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>({ method: "DELETE", path });
  }
}
