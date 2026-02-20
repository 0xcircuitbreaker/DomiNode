import { DEFAULT_API_BASE } from "./constants.js";

// Default to production HTTPS URL — setApiBase() can override for development
let apiBase = DEFAULT_API_BASE;

export function setApiBase(base: string): void {
  const trimmed = base.replace(/\/$/, "");
  const parsed = new URL(trimmed);
  // R27 H-4: Expand localhost check to cover IPv6 loopback and 0.0.0.0
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]" || parsed.hostname === "0.0.0.0";
  if (parsed.protocol !== "https:" && !isLocal) {
    throw new Error("API base URL must use HTTPS for non-local hosts");
  }
  // R30 H-2: Validate API base URL against path traversal, credential injection, query/fragment
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("API base URL must not contain a path");
  }
  if (parsed.username || parsed.password) {
    throw new Error("API base URL must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("API base URL must not contain query or fragment");
  }
  apiBase = `${parsed.protocol}//${parsed.host}`;
}

export function getApiBase(): string {
  return apiBase;
}

// R22 H-2: Response size limit to prevent OOM from oversized server responses
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB

// R26 M-2: Prototype pollution protection — strip dangerous keys from parsed JSON
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

function mergeUint8Arrays(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function safeJson<T>(res: Response): Promise<T> {
  // R25 C-2: Pre-flight Content-Length check before buffering (prevents OOM)
  const contentLength = parseInt(res.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_RESPONSE_BYTES) {
    await res.body?.cancel();
    throw new Error("Response too large");
  }

  // R30 H-4: Enforce size limit for chunked responses (no Content-Length header)
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("Response too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const text = new TextDecoder().decode(
      chunks.length === 1 ? chunks[0] : mergeUint8Arrays(chunks, totalBytes)
    );
    if (!text) return {} as T;
    const parsed = JSON.parse(text);
    stripDangerousKeys(parsed);
    return parsed as T;
  }

  // Fallback for environments where res.body is not available
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error("Response too large");
  }
  if (!text) return {} as T;
  const parsed = JSON.parse(text);
  stripDangerousKeys(parsed);
  return parsed as T;
}

// R38 H-2: Validate API paths to prevent CRLF injection and path traversal
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

export async function apiGet<T>(path: string, token?: string | null): Promise<T> {
  const safePath = validateApiPath(path);
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${apiBase}${safePath}`, {
    headers,
    redirect: "error", // R18-C4: Prevent HTTPS→HTTP redirect leaking Bearer token
    signal: AbortSignal.timeout(30_000), // R18-C5: Prevent indefinite hang
  });

  if (!res.ok) {
    const body = await safeJson<{ error?: string }>(res).catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  return safeJson<T>(res);
}

export async function apiPost<T>(path: string, body: unknown, token?: string | null): Promise<T> {
  const safePath = validateApiPath(path);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${apiBase}${safePath}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "error", // R18-C4: Prevent HTTPS→HTTP redirect leaking Bearer token
    signal: AbortSignal.timeout(30_000), // R18-C5: Prevent indefinite hang
  });

  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    const data = await safeJson<{ error?: string }>(res).catch(() => ({ error: res.statusText }));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }

  return safeJson<T>(res);
}
