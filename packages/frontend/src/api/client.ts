// Simplified API client — auth is handled via httpOnly cookies.
// No token management needed on the client side.

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
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

async function apiFetch<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
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
    res = await fetch(path, {
      ...fetchOptions,
      headers,
      credentials: "include",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 401) {
    // Deduplicated silent refresh — only one in-flight at a time
    const refreshed = await silentRefresh();

    if (refreshed) {
      // R16 F-2: Retry with same 30s timeout as original request
      const retryController = new AbortController();
      const retryTimeoutId = setTimeout(() => retryController.abort(), 30_000);
      let retryRes: Response;
      try {
        retryRes = await fetch(path, {
          ...fetchOptions,
          headers,
          credentials: "include",
          signal: retryController.signal,
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
        const body = await retryRes.json().catch(() => ({ error: retryRes.statusText }));
        throw new Error(body.error || `Request failed: ${retryRes.status}`);
      }
      return retryRes.json();
    }

    if (redirectOnUnauthorized) {
      window.location.href = "/login";
    }
    throw new Error("Unauthorized");
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    // R16 F-3: Guard against NaN from non-numeric header values
    const seconds = retryAfter ? (parseInt(retryAfter, 10) || 60) : 60;
    throw new Error(`Too many requests. Please try again in ${seconds} seconds.`);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  return res.json();
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

export function del(path: string, options?: ApiRequestOptions): Promise<void> {
  return apiFetch<void>(path, { ...options, method: "DELETE" });
}
