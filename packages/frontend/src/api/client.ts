// Simplified API client — auth is handled via httpOnly cookies.
// No token management needed on the client side.

// Response size limit to prevent OOM from oversized server responses
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB

// Prototype pollution protection — strip dangerous keys from parsed JSON
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
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

async function safeJson<T>(res: Response): Promise<T> {
  // Pre-flight Content-Length check before buffering (prevents OOM on oversized responses)
  const contentLength = parseInt(res.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_RESPONSE_BYTES) {
    await res.body?.cancel();
    throw new Error("Response too large");
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error("Response too large");
  }
  // Throw on empty body rather than returning undefined as T (bypasses type safety)
  if (!text) throw new Error("Empty response from server");
  const parsed = JSON.parse(text);
  stripDangerousKeys(parsed);
  return parsed as T;
}

// Singleton refresh lock prevents multiple concurrent 401-triggered refreshes
// from racing against each other and causing token rotation confusion.
let refreshPromise: Promise<boolean> | null = null;

interface ApiRequestOptions extends RequestInit {
  redirectOnUnauthorized?: boolean;
}

function silentRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetch("/api/auth/refresh", {
    method: "POST",
    credentials: "include",
    redirect: "error", // Prevent credential leakage via redirect
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

// Validate API paths to prevent CRLF injection and path traversal
function validateApiPath(path: string): string {
  // Block CRLF injection
  if (/[\r\n]/.test(path)) {
    throw new Error("Invalid API path");
  }
  // Block path traversal sequences
  if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(path)) {
    throw new Error("Invalid API path");
  }
  // Must be a relative path starting with /
  if (!path.startsWith("/")) {
    throw new Error("Invalid API path");
  }
  return path;
}

async function apiFetch<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const safePath = validateApiPath(path);
  const { redirectOnUnauthorized = true, ...fetchOptions } = options;
  const headers: Record<string, string> = {
    ...(fetchOptions.headers as Record<string, string>),
  };

  if (fetchOptions.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000); // 30s timeout
  let res: Response;
  try {
    res = await fetch(safePath, {
      ...fetchOptions,
      headers,
      credentials: "include",
      signal: controller.signal,
      redirect: "error", // Prevent credential leakage via redirect
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 401) {
    // Deduplicated silent refresh — only one in-flight at a time
    const refreshed = await silentRefresh();

    if (refreshed) {
      // Retry with same 30s timeout as original request
      const retryController = new AbortController();
      const retryTimeoutId = setTimeout(() => retryController.abort(), 30_000);
      let retryRes: Response;
      try {
        retryRes = await fetch(safePath, {
          ...fetchOptions,
          headers,
          credentials: "include",
          signal: retryController.signal,
          redirect: "error", // Prevent credential leakage via redirect
        });
      } finally {
        clearTimeout(retryTimeoutId);
      }

      if (retryRes.status === 401) {
        if (redirectOnUnauthorized) {
          window.location.href = "/login";
        }
        throw new Error("Unauthorized");
      }

      if (retryRes.status === 204) return undefined as T;
      if (!retryRes.ok) {
        const body = await safeJson<{ error?: string }>(retryRes).catch(() => ({ error: retryRes.statusText }));
        throw new Error(body.error || `Request failed: ${retryRes.status}`);
      }
      return safeJson<T>(retryRes);
    }

    if (redirectOnUnauthorized) {
      window.location.href = "/login";
    }
    throw new Error("Unauthorized");
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    // Guard against NaN from non-numeric header values
    const seconds = retryAfter ? (parseInt(retryAfter, 10) || 60) : 60;
    throw new Error(`Too many requests. Please try again in ${seconds} seconds.`);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  if (!res.ok) {
    const body = await safeJson<{ error?: string }>(res).catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  return safeJson<T>(res);
}

export function get<T>(path: string, options?: ApiRequestOptions): Promise<T> {
  return apiFetch<T>(path, options);
}

export function post<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
  return apiFetch<T>(path, {
    ...options,
    method: "POST",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export function put<T>(path: string, body: unknown, options?: ApiRequestOptions): Promise<T> {
  return apiFetch<T>(path, {
    ...options,
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function patch<T>(path: string, body: unknown, options?: ApiRequestOptions): Promise<T> {
  return apiFetch<T>(path, {
    ...options,
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function del(path: string, options?: ApiRequestOptions): Promise<void> {
  return apiFetch<void>(path, { ...options, method: "DELETE" });
}
