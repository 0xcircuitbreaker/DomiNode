import type { TokenManager } from "./token-manager.js";

const USER_AGENT = "dominusnode-mcp-server/1.0.0";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function stripDangerousKeys(obj: unknown): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripDangerousKeys(item);
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (DANGEROUS_KEYS.has(key)) {
      delete record[key];
    } else if (record[key] && typeof record[key] === "object") {
      stripDangerousKeys(record[key]);
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

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
      ...opts.headers,
    };

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
      await response.text();
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
    }

    // 401 retry with force refresh
    if (response.status === 401 && opts.requiresAuth !== false) {
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
        return text ? safeJsonParse<T>(text) : ({} as T);
      }
      const retryBody = await retry.text();
      let retryMessage = retryBody;
      try {
        const parsed = JSON.parse(retryBody);
        retryMessage = parsed.error ?? parsed.message ?? retryBody;
      } catch { /* use raw text */ }
      throw new Error(`API error ${retry.status}: ${retryMessage}`);
    }

    const responseText = await response.text();

    if (!response.ok) {
      let message = responseText;
      try {
        const parsed = JSON.parse(responseText);
        message = parsed.error ?? parsed.message ?? responseText;
      } catch { /* use raw text */ }
      throw new Error(`API error ${response.status}: ${message}`);
    }

    return responseText ? safeJsonParse<T>(responseText) : ({} as T);
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
