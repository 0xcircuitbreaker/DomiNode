import { USER_AGENT, MAX_RATE_LIMIT_RETRIES } from "./constants.js";
import {
  DomiNodeError, AuthenticationError, AuthorizationError, RateLimitError,
  InsufficientBalanceError, ValidationError, NotFoundError, ConflictError,
  ServerError, NetworkError,
} from "./errors.js";
import type { TokenManager } from "./token-manager.js";

// R15 H-3: Sanitize parsed JSON to prevent prototype pollution from untrusted API responses
function safeJsonParse<T>(text: string): T {
  const parsed = JSON.parse(text);
  if (parsed && typeof parsed === "object") {
    delete (parsed as Record<string, unknown>)["__proto__"];
    delete (parsed as Record<string, unknown>)["constructor"];
    delete (parsed as Record<string, unknown>)["prototype"];
  }
  return parsed as T;
}

// R15 H-5: Add jitter to retry delays to prevent thundering-herd on rate-limited endpoints
function addJitter(ms: number): number {
  const jitter = ms * 0.2 * (Math.random() - 0.5); // ±10% jitter
  return Math.max(100, Math.round(ms + jitter));
}

export interface HttpOptions {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  requiresAuth?: boolean;
}

function throwForStatus(status: number, body: string, headers: Headers): never {
  let message: string;
  try {
    const parsed = JSON.parse(body);
    message = parsed.error ?? parsed.message ?? body;
  } catch {
    message = body;
  }

  switch (status) {
    case 400: throw new ValidationError(message);
    case 401: throw new AuthenticationError(message);
    case 402: throw new InsufficientBalanceError(message);
    case 403: throw new AuthorizationError(message);
    case 404: throw new NotFoundError(message);
    case 409: throw new ConflictError(message);
    case 429: {
      const retryAfter = parseInt(headers.get("retry-after") ?? "60", 10);
      throw new RateLimitError(message, retryAfter);
    }
    default:
      if (status >= 500) throw new ServerError(message);
      throw new DomiNodeError(message, status);
  }
}

export class HttpClient {
  constructor(
    private baseUrl: string,
    private tokenManager: TokenManager,
  ) {}

  async request<T>(opts: HttpOptions): Promise<T> {
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
    let response: Response;

    const timeoutMs = 30_000; // 30s request timeout

    try {
      response = await fetch(url, {
        method: opts.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new NetworkError(err instanceof Error ? err.message : "Network request failed");
    }

    if (response.status === 429) {
      // Auto-retry once on rate limit (cap wait at 10s to avoid client-side DoS)
      const retryAfter = parseInt(response.headers.get("retry-after") ?? "5", 10);
      await response.text(); // consume body
      await new Promise((resolve) => setTimeout(resolve, addJitter(Math.min(retryAfter * 1000, 10_000))));

      // Refresh token before retry in case it expired during the wait
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
        });
      } catch (err) {
        throw new NetworkError(err instanceof Error ? err.message : "Network request failed");
      }
    }

    if (response.status === 401 && opts.requiresAuth !== false) {
      // Force a token refresh (don't reuse the rejected token) and retry once
      try {
        const newToken = await this.tokenManager.forceRefresh();
        headers["Authorization"] = `Bearer ${newToken}`;
        const retry = await fetch(url, {
          method: opts.method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (retry.ok) {
          const text = await retry.text();
          return text ? safeJsonParse<T>(text) : ({} as T);
        }
        const retryBody = await retry.text();
        throwForStatus(retry.status, retryBody, retry.headers);
      } catch (err) {
        if (err instanceof DomiNodeError) throw err;
        // Refresh failed — fall through to original 401 handling
      }
    }

    const responseText = await response.text();

    if (!response.ok) {
      throwForStatus(response.status, responseText, response.headers);
    }

    return responseText ? safeJsonParse<T>(responseText) : ({} as T);
  }

  async get<T>(path: string, requiresAuth = true): Promise<T> {
    return this.request<T>({ method: "GET", path, requiresAuth });
  }

  async post<T>(path: string, body?: unknown, requiresAuth = true): Promise<T> {
    return this.request<T>({ method: "POST", path, body, requiresAuth });
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>({ method: "PUT", path, body });
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>({ method: "DELETE", path });
  }
}
