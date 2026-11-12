import {
  USER_AGENT, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, MAX_RATE_LIMIT_RETRIES, MAX_RETRY_WAIT_MS, MIN_RETRY_WAIT_MS,
} from "./constants.js";
import {
  DominusNodeError, AuthenticationError, AuthorizationError, RateLimitError, InsufficientBalanceError,
  ValidationError, NotFoundError, ConflictError, ServerError, NetworkError, scrubCredentials,
} from "./errors.js";
import type { TokenManager } from "./token-manager.js";
import { inspectSymbol } from "./secret.js";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Recursively delete prototype-pollution keys (depth-limited). */
export function stripDangerousKeys(obj: unknown, depth = 0): void {
  if (depth > 50 || !obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripDangerousKeys(item, depth + 1);
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (DANGEROUS_KEYS.has(key)) delete record[key];
    else if (record[key] && typeof record[key] === "object") stripDangerousKeys(record[key], depth + 1);
  }
}

export function safeJsonParse<T>(text: string): T {
  const parsed = JSON.parse(text);
  stripDangerousKeys(parsed);
  return parsed as T;
}

/** min(retryAfter, 10s), +/-10% jitter, floor 100ms. */
export function retryDelayMs(retryAfterSeconds: number): number {
  const base = Math.min(Math.max(retryAfterSeconds, 0) * 1000, MAX_RETRY_WAIT_MS);
  const jitter = base * 0.2 * (Math.random() - 0.5);
  return Math.max(MIN_RETRY_WAIT_MS, Math.round(base + jitter));
}

function parseRetryAfter(h: string | null, fallback: number): number {
  const n = parseInt(h ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Auth mode per request:
 * - "jwt":   Bearer <access JWT> (refreshed automatically) — /api/* routes.
 * - "agent": Bearer <dn_live_ API key> if connected with a key, else the wallet JWT — /v1/* routes
 *            (requireAgentPrincipal rejects JWTs of non-wallet users, so the raw key is sent).
 * - "none":  no Authorization header.
 */
export type AuthMode = "jwt" | "agent" | "none";

export interface HttpOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  auth?: AuthMode;
  /** Return the body as a string instead of parsing JSON (CSV export). */
  raw?: boolean;
}

function throwForStatus(status: number, body: string, headers: Headers): never {
  let message = body;
  let code: string | undefined;
  let details: Record<string, number | string> | undefined;
  try {
    const parsed = safeJsonParse<Record<string, unknown>>(body);
    if (parsed && typeof parsed === "object") {
      const m = parsed["error"] ?? parsed["message"];
      if (typeof m === "string") message = m;
      if (typeof parsed["code"] === "string") code = parsed["code"];
      else if (parsed["mfaRequired"] === true) code = "MFA_REQUIRED";
      for (const k of ["max", "cap", "limitPerDay"]) {
        const v = parsed[k];
        if (typeof v === "number" || typeof v === "string") (details ??= {})[k] = v;
      }
    }
  } catch { /* not JSON */ }
  if (!message) message = `HTTP ${status}`;
  if (message.length > 500) message = message.slice(0, 500) + "... [truncated]";

  switch (status) {
    case 400: throw new ValidationError(message, 400, code, details);
    case 401: throw new AuthenticationError(message, code, details);
    case 402: throw new InsufficientBalanceError(message, code, details);
    case 403: throw new AuthorizationError(message, code, details);
    case 404: throw new NotFoundError(message, code, details);
    case 409: throw new ConflictError(message, code, details);
    case 429: throw new RateLimitError(message, parseRetryAfter(headers.get("retry-after"), 60), code, details);
    default:
      if (status >= 500) throw new ServerError(message, status, code, details);
      throw new DominusNodeError(message, status, code, details);
  }
}

/**
 * Read a response body as UTF-8, counting bytes as they stream in. Past maxBytes the
 * stream is cancelled and ServerError is raised, so a chunked (no Content-Length)
 * body is never buffered beyond the cap.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ServerError("Response body exceeds size limit", res.status);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof DominusNodeError) throw err;
    throw new NetworkError(scrubCredentials(`Failed to read response body: ${err instanceof Error ? err.message : String(err)}`));
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export interface Credentials {
  tokens: TokenManager;
  apiKey: () => string | null;
}

export class HttpClient {
  readonly #baseUrl: string;
  readonly #creds: Credentials;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, creds: Credentials, fetchImpl?: typeof fetch) {
    let u: URL;
    try { u = new URL(baseUrl); } catch { throw new ValidationError("baseUrl is not a valid URL", undefined); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new ValidationError("baseUrl must be http(s)", undefined);
    if (u.username || u.password) throw new ValidationError("baseUrl must not contain credentials", undefined);
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#creds = creds;
    this.#fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
  }

  async #bearer(mode: AuthMode, forceRefresh: boolean): Promise<string | null> {
    if (mode === "none") return null;
    if (mode === "agent") {
      const key = this.#creds.apiKey();
      if (key) return key;
    }
    if (!this.#creds.tokens.hasTokens()) {
      throw new AuthenticationError("Not authenticated. Call connectWithKey() or walletAuth.verify() first.");
    }
    return forceRefresh ? this.#creds.tokens.forceRefresh() : this.#creds.tokens.getValidToken();
  }

  async #send(opts: HttpOptions, bearer: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      ...opts.headers,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
    try {
      return await this.#fetch(`${this.#baseUrl}${opts.path}`, {
        method: opts.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error", // never follow redirects (credential leakage)
      });
    } catch (err) {
      throw new NetworkError(scrubCredentials(err instanceof Error ? err.message : "Network request failed"));
    }
  }

  async #readBody(res: Response): Promise<string> {
    const cl = parseInt(res.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(cl) && cl > MAX_RESPONSE_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw new ServerError("Response body too large", res.status);
    }
    return readCapped(res, MAX_RESPONSE_BYTES);
  }

  async request<T>(opts: HttpOptions): Promise<T> {
    const mode = opts.auth ?? "jwt";
    let bearer = await this.#bearer(mode, false);
    let res = await this.#send(opts, bearer);

    for (let i = 0; i < MAX_RATE_LIMIT_RETRIES && res.status === 429; i++) {
      const wait = retryDelayMs(parseRetryAfter(res.headers.get("retry-after"), 5));
      await res.body?.cancel().catch(() => undefined); // do not buffer the 429 body
      await new Promise((r) => setTimeout(r, wait));
      bearer = await this.#bearer(mode, false);
      res = await this.#send(opts, bearer);
    }

    const usedJwt = bearer !== null && !bearer.startsWith("dn_");
    if (res.status === 401 && usedJwt && this.#creds.tokens.getRefreshToken()) {
      await res.body?.cancel().catch(() => undefined);
      let refreshed: string | null = null;
      try { refreshed = await this.#bearer(mode, true); } catch { refreshed = null; }
      if (refreshed) res = await this.#send(opts, refreshed);
      else throw new AuthenticationError("Session expired and token refresh failed");
    }

    const text = await this.#readBody(res);
    if (!res.ok) throwForStatus(res.status, text, res.headers);
    if (opts.raw) return text as unknown as T;
    if (!text) return {} as T;
    try {
      return safeJsonParse<T>(text);
    } catch {
      throw new ServerError("Invalid JSON in response", res.status);
    }
  }

  get<T>(path: string, auth: AuthMode = "jwt"): Promise<T> { return this.request<T>({ method: "GET", path, auth }); }
  post<T>(path: string, body: unknown = {}, auth: AuthMode = "jwt", headers?: Record<string, string>): Promise<T> {
    return this.request<T>({ method: "POST", path, body, auth, headers });
  }
  put<T>(path: string, body: unknown, auth: AuthMode = "jwt"): Promise<T> { return this.request<T>({ method: "PUT", path, body, auth }); }
  patch<T>(path: string, body: unknown, auth: AuthMode = "jwt"): Promise<T> { return this.request<T>({ method: "PATCH", path, body, auth }); }
  delete<T>(path: string, auth: AuthMode = "jwt"): Promise<T> { return this.request<T>({ method: "DELETE", path, auth }); }

  toString(): string { return `HttpClient(${this.#baseUrl})`; }
  toJSON(): string { return this.toString(); }
  [inspectSymbol](): string { return this.toString(); }
}
