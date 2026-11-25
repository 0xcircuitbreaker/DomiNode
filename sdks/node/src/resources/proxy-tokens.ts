import type { HttpClient } from "../http.js";
import { invalidArg, ProtocolError } from "../errors.js";
import { Secret } from "../secret.js";
import { seg, validateIntRange, validateUuid } from "../validation.js";

/** Opaque proxy token shape returned by POST /v1/proxy-tokens. */
export const PROXY_TOKEN_RE = /^dn_proxy_[A-Za-z0-9_-]{43}$/;
export const PROXY_TOKEN_MIN_TTL_SECONDS = 60;
export const PROXY_TOKEN_MAX_TTL_SECONDS = 365 * 24 * 3600;
export const PROXY_TOKEN_MAX_BYTES = 1_000_000_000_000_000n;
export const PROXY_TOKEN_MAX_SPEND_MUSD = 10_000_000_000_000n;
const INT_RE = /^[1-9][0-9]{0,15}$/;

export type ProxyTokenStatus = "active" | "revoked" | "expired" | "exhausted";

export interface ProxyTokenInfo {
  id: string;
  label: string;
  status: ProxyTokenStatus;
  expiresAt: string;
  /** Integer strings; null means no cap. */
  maxBytes: string | null;
  maxSpendMusd: string | null;
  bytesUsed: string;
  spendUsedMusd: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedProxyToken extends ProxyTokenInfo {
  /** The dn_proxy_ token, returned ONCE. Redacted when printed; call token.reveal(). */
  token: Secret;
}

export interface CreateProxyTokenOptions {
  label?: string;
  /** Lifetime in seconds, 60 .. 31536000 (default server-side: 30 days). */
  ttlSeconds?: number;
  /** Byte cap (gateway-metered). */
  maxBytes?: bigint | string | number;
  /** Spend cap in µUSD. */
  maxSpendMusd?: bigint | string | number;
}

function toCap(v: bigint | string | number, max: bigint, name: string): string {
  let n: bigint;
  if (typeof v === "bigint") n = v;
  else if (typeof v === "number" && Number.isSafeInteger(v)) n = BigInt(v);
  else if (typeof v === "string" && INT_RE.test(v)) n = BigInt(v);
  else throw invalidArg(`${name} must be a positive integer (bigint, digit string or safe integer)`);
  if (n < 1n || n > max) throw invalidArg(`${name} must be between 1 and ${max}`);
  return n.toString();
}

/**
 * Scoped, revocable dn_proxy_ tokens (AGENT_API.md "Proxy tokens"). Use the
 * token as the proxy password instead of the dn_live_ key.
 */
export class ProxyTokensResource {
  constructor(private http: HttpClient) {}

  /** POST /v1/proxy-tokens */
  async create(opts: CreateProxyTokenOptions = {}): Promise<CreatedProxyToken> {
    const body: Record<string, unknown> = {};
    if (opts.label !== undefined) {
      if (typeof opts.label !== "string" || opts.label.length > 64 || /[\u0000-\u001f\u007f]/.test(opts.label)) {
        throw invalidArg("label must be at most 64 printable characters");
      }
      body["label"] = opts.label;
    }
    if (opts.ttlSeconds !== undefined) {
      body["ttlSeconds"] = validateIntRange(opts.ttlSeconds, "ttlSeconds", PROXY_TOKEN_MIN_TTL_SECONDS, PROXY_TOKEN_MAX_TTL_SECONDS);
    }
    if (opts.maxBytes !== undefined) body["maxBytes"] = toCap(opts.maxBytes, PROXY_TOKEN_MAX_BYTES, "maxBytes");
    if (opts.maxSpendMusd !== undefined) body["maxSpendMusd"] = toCap(opts.maxSpendMusd, PROXY_TOKEN_MAX_SPEND_MUSD, "maxSpendMusd");
    const r = await this.http.post<ProxyTokenInfo & { token: string }>("/v1/proxy-tokens", body, "agent");
    if (typeof r.token !== "string" || !PROXY_TOKEN_RE.test(r.token)) {
      throw new ProtocolError("server returned a malformed proxy token");
    }
    return { ...r, token: new Secret(r.token) };
  }

  /** GET /v1/proxy-tokens (metadata only). */
  async list(): Promise<{ tokens: ProxyTokenInfo[]; maxActive: number }> {
    return this.http.get("/v1/proxy-tokens", "agent");
  }

  /** DELETE /v1/proxy-tokens/:id */
  async revoke(id: string): Promise<{ id: string; revoked: boolean }> {
    return this.http.delete(`/v1/proxy-tokens/${seg(validateUuid(id, "id"))}`, "agent");
  }
}
