import { DEFAULT_API_BASE } from "./constants.js";

// Default to production HTTPS URL — setApiBase() can override for development
let apiBase = DEFAULT_API_BASE;

export function setApiBase(base: string): void {
  const trimmed = base.replace(/\/$/, "");
  const parsed = new URL(trimmed);
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !isLocal) {
    throw new Error("API base URL must use HTTPS for non-local hosts");
  }
  apiBase = trimmed;
}

export function getApiBase(): string {
  return apiBase;
}

export async function apiGet<T>(path: string, token?: string | null): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${apiBase}${path}`, { headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

export async function apiPost<T>(path: string, body: unknown, token?: string | null): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }

  return res.json();
}
