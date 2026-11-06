import { MAX_RESPONSE_BYTES } from "./constants.js";
import { safeParse } from "./json.js";
import { scrubCredentials } from "./scrub.js";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(scrubCredentials(message));
    this.name = "ApiError";
  }
}

function validatePath(path: string): string {
  if (!path.startsWith("/") || /[\r\n\\]/.test(path) || /(?:^|\/)\.\.(?:\/|$|\?)/.test(path)) {
    throw new ApiError("Invalid API path", 0);
  }
  return path;
}

/** Read a body with a hard byte cap (cancels the stream when exceeded). */
export async function readCapped(res: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  const len = parseInt(res.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(len) && len > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ApiError("Response too large", res.status);
  }
  if (!res.body) {
    const t = await res.text();
    if (t.length > maxBytes) throw new ApiError("Response too large", res.status);
    return t;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let tooLarge = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        tooLarge = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (tooLarge) throw new ApiError("Response too large", res.status);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export interface RequestOpts {
  method?: "GET" | "POST";
  bearer?: string | null;
  body?: unknown;
  timeoutMs?: number;
}

export async function apiRequest<T>(base: string, path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${base}${validatePath(path)}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(`Network error: ${scrubCredentials(err)}`, 0);
  }
  const text = await readCapped(res);
  let data: unknown = null;
  if (text) {
    try {
      data = safeParse(text, MAX_RESPONSE_BYTES);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: unknown; code?: unknown };
    const msg = typeof d.error === "string" ? d.error : `Request failed: ${res.status}`;
    throw new ApiError(msg, res.status, typeof d.code === "string" ? d.code : undefined);
  }
  if (data === null) throw new ApiError("Empty or invalid JSON response", res.status);
  return data as T;
}

// ─── Typed endpoints ─────────────────────────────────────────────

export interface Money {
  musd: string;
  usd: string;
}

export interface PricingResponse {
  currency: string;
  unit: string;
  prices: { ipClass: string; pricePerGbMusd: string }[];
  nodeShare: { tier: string; rank: number; nodeShareBps: number }[];
  maturationHours: number;
}

export interface NodeView {
  id: string;
  status: string;
  observedIp: string | null;
  country: string | null;
  ipClass: string | null;
  reputation: number | string | null;
  agentVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface TierView {
  id: string;
  name: string;
  rank: number;
  nodeShareBps: number;
  holdDays: number;
  maxNodes: number;
  dailyWithdrawLimitMusd: string;
}
export interface TierReq {
  required: number;
  current: number | null;
  met: boolean | null;
}
export interface TierResponse {
  tier: TierView;
  nextTier: TierView | null;
  progress: Record<string, TierReq | null> | null;
  demotionReason: string | null;
  uptimeGraceUntil: string | null;
}

export interface CreditsResponse {
  pending: Money;
  available: Money;
  frozen: boolean;
  payoutsEnabled: boolean;
  tier: { name: string; holdDays: number } | null;
}

/** A node counts as online when seen within this window. */
export const NODE_ONLINE_MS = 5 * 60 * 1000;
export function isNodeOnline(n: Pick<NodeView, "status" | "lastSeenAt">, now = Date.now()): boolean {
  if (n.status !== "active" || !n.lastSeenAt) return false;
  const t = Date.parse(n.lastSeenAt);
  return Number.isFinite(t) && now - t < NODE_ONLINE_MS;
}

/** µUSD integer string to "$1.234567" (at least 2 decimals, trailing zeros trimmed). */
export function fmtMusd(musd: string | null | undefined): string {
  if (!musd || !/^-?\d+$/.test(musd)) return "—";
  const neg = musd.startsWith("-");
  const digits = (neg ? musd.slice(1) : musd).padStart(7, "0");
  const whole = digits.slice(0, -6).replace(/^0+(?=\d)/, "");
  let frac = digits.slice(-6).replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}$${whole}.${frac}`;
}

export function fmtCents(c: number | null | undefined): string {
  if (c === null || c === undefined || !Number.isFinite(c)) return "—";
  return `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
}

/**
 * Account client. /api/wallet needs a JWT, so one is minted from the API key with
 * POST /api/auth/verify-key and kept only in memory (15 min lifetime, renewed at 12).
 * /v1 endpoints take the API key as a Bearer token directly.
 */
export class AccountClient {
  private jwt: { token: string; exp: number } | null = null;

  constructor(
    private readonly base: string,
    private readonly apiKey: string,
  ) {}

  private async token(): Promise<string> {
    if (this.jwt && this.jwt.exp > Date.now()) return this.jwt.token;
    const r = await apiRequest<{ token?: unknown }>(this.base, "/api/auth/verify-key", {
      method: "POST",
      body: { apiKey: this.apiKey },
    });
    if (typeof r.token !== "string") throw new ApiError("API key verification failed", 401);
    this.jwt = { token: r.token, exp: Date.now() + 12 * 60 * 1000 };
    return r.token;
  }

  async balanceCents(): Promise<number> {
    let r: { balanceCents?: unknown };
    try {
      r = await apiRequest(this.base, "/api/wallet", { bearer: await this.token() });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401 || !this.jwt) throw err;
      this.jwt = null;
      r = await apiRequest(this.base, "/api/wallet", { bearer: await this.token() });
    }
    if (typeof r.balanceCents !== "number" || !Number.isFinite(r.balanceCents)) {
      throw new ApiError("Invalid wallet response", 0);
    }
    return r.balanceCents;
  }

  pricing(): Promise<PricingResponse> {
    return apiRequest(this.base, "/v1/pricing");
  }
  nodes(): Promise<{ nodes: NodeView[] }> {
    return apiRequest(this.base, "/v1/nodes?limit=100&offset=0", { bearer: this.apiKey });
  }
  tier(): Promise<TierResponse> {
    return apiRequest(this.base, "/v1/node/tier", { bearer: this.apiKey });
  }
  credits(): Promise<CreditsResponse> {
    return apiRequest(this.base, "/v1/credits", { bearer: this.apiKey });
  }
}
