/**
 * Revocable scoped proxy tokens (proxy_tokens, AGENT_API.md "Proxy tokens").
 *
 * A token is an opaque `dn_proxy_<43 base64url chars>` secret. Only its
 * SHA-256 hex is stored; the plaintext is returned once at creation. The
 * gateway looks a token up by hash, refuses it when revoked, expired or at a
 * cap, and adds gateway-metered bytes/spend with a conditional UPDATE so two
 * sessions cannot both pass the cap.
 */
import * as crypto from "node:crypto";
import { query, queryOn } from "../db.js";
import type { DbTxClient } from "../db.js";
import { withTx } from "./node-credit-repo.js";

export const PROXY_TOKEN_PREFIX = "dn_proxy_";
/** Opaque token shape: prefix + 32 random bytes in base64url (no "." — legacy HMAC tokens contain one). */
export const OPAQUE_PROXY_TOKEN_RE = /^dn_proxy_[A-Za-z0-9_-]{43}$/;

export const MAX_TOKEN_BYTES = 1_000_000_000_000_000n; // 1 PB (schema ceiling)
export const MAX_TOKEN_SPEND_MUSD = 10_000_000_000_000n; // $10M (schema ceiling)
export const MAX_LABEL_LEN = 64;
export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MIN_TTL_MS = 60_000; // 1 minute
export const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
export const DEFAULT_MAX_ACTIVE_PER_USER = 25;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;

const COLS = "id, user_id, label, expires_at, max_bytes, max_spend_musd, bytes_used, spend_used_musd, revoked_at, created_at";

interface Row {
  id: string;
  user_id: string;
  label: string;
  expires_at: Date;
  max_bytes: string | null;
  max_spend_musd: string | null;
  bytes_used: string;
  spend_used_musd: string;
  revoked_at: Date | null;
  created_at: Date;
}

/** Stored token metadata. Never includes the secret or its hash. */
export interface ProxyToken {
  id: string;
  userId: string;
  label: string;
  expiresAt: Date;
  maxBytes: bigint | null;
  maxSpendMusd: bigint | null;
  bytesUsed: bigint;
  spendUsedMusd: bigint;
  revokedAt: Date | null;
  createdAt: Date;
}

export type ProxyTokenStatus = "active" | "revoked" | "expired" | "exhausted";

function toToken(r: Row): ProxyToken {
  return {
    id: r.id,
    userId: r.user_id,
    label: r.label,
    expiresAt: r.expires_at,
    maxBytes: r.max_bytes === null ? null : BigInt(r.max_bytes),
    maxSpendMusd: r.max_spend_musd === null ? null : BigInt(r.max_spend_musd),
    bytesUsed: BigInt(r.bytes_used),
    spendUsedMusd: BigInt(r.spend_used_musd),
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
  };
}

/** True when a cap is set and usage has reached it. */
export function isExhausted(t: Pick<ProxyToken, "maxBytes" | "maxSpendMusd" | "bytesUsed" | "spendUsedMusd">): boolean {
  return (t.maxBytes !== null && t.bytesUsed >= t.maxBytes) || (t.maxSpendMusd !== null && t.spendUsedMusd >= t.maxSpendMusd);
}

export function tokenStatus(t: ProxyToken, now: number = Date.now()): ProxyTokenStatus {
  if (t.revokedAt) return "revoked";
  if (t.expiresAt.getTime() <= now) return "expired";
  if (isExhausted(t)) return "exhausted";
  return "active";
}

export function hashProxyToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateProxyToken(): { token: string; hash: string } {
  const token = PROXY_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashProxyToken(token) };
}

export interface CreateProxyTokenInput {
  label?: string;
  ttlMs?: number;
  maxBytes?: bigint | null;
  maxSpendMusd?: bigint | null;
}

export class ProxyTokenInputError extends Error {}

function validateInput(i: CreateProxyTokenInput): { label: string; ttlMs: number; maxBytes: bigint | null; maxSpendMusd: bigint | null } {
  const label = i.label ?? "";
  if (typeof label !== "string" || label.length > MAX_LABEL_LEN || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new ProxyTokenInputError(`label must be at most ${MAX_LABEL_LEN} printable characters`);
  }
  const ttlMs = i.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw new ProxyTokenInputError("ttl out of range");
  }
  const maxBytes = i.maxBytes ?? null;
  if (maxBytes !== null && (maxBytes < 1n || maxBytes > MAX_TOKEN_BYTES)) throw new ProxyTokenInputError("maxBytes out of range");
  const maxSpendMusd = i.maxSpendMusd ?? null;
  if (maxSpendMusd !== null && (maxSpendMusd < 1n || maxSpendMusd > MAX_TOKEN_SPEND_MUSD)) throw new ProxyTokenInputError("maxSpendMusd out of range");
  return { label, ttlMs, maxBytes, maxSpendMusd };
}

/**
 * Mint a token. Returns null when the user already has `maxActive` active
 * (unrevoked, unexpired) tokens or is not active. The count check and insert
 * run under a per-user row lock.
 */
export async function createProxyToken(
  userId: string,
  input: CreateProxyTokenInput,
  maxActive: number = DEFAULT_MAX_ACTIVE_PER_USER,
): Promise<{ token: string; record: ProxyToken } | null> {
  if (!UUID_RE.test(userId)) throw new ProxyTokenInputError("invalid user id");
  const v = validateInput(input);
  const { token, hash } = generateProxyToken();
  return withTx(async (client) => {
    const u = await client.query<{ id: string }>(`SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`, [userId]);
    if (u.rows.length === 0) return null;
    const c = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM proxy_tokens WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [userId],
    );
    if (Number(c.rows[0]?.n ?? "0") >= maxActive) return null;
    const r = await client.query<Row>(
      `INSERT INTO proxy_tokens (user_id, token_hash, label, expires_at, max_bytes, max_spend_musd)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5, $6)
       RETURNING ${COLS}`,
      [userId, hash, v.label, v.ttlMs / 1000, v.maxBytes?.toString() ?? null, v.maxSpendMusd?.toString() ?? null],
    );
    return { token, record: toToken(r.rows[0]) };
  });
}

/** The user's tokens, newest first (metadata only). */
export async function listProxyTokens(userId: string, limit = 100): Promise<ProxyToken[]> {
  if (!UUID_RE.test(userId)) return [];
  const lim = Math.min(Math.max(Math.trunc(limit) || 1, 1), 200);
  const r = await query<Row>(
    `SELECT ${COLS} FROM proxy_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, lim],
  );
  return r.rows.map(toToken);
}

/** Revoke one of the user's tokens. False when it does not exist, is not theirs, or is already revoked. */
export async function revokeProxyToken(userId: string, id: string): Promise<boolean> {
  if (!UUID_RE.test(userId) || !UUID_RE.test(id)) return false;
  const r = await query<{ id: string }>(
    `UPDATE proxy_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [id, userId],
  );
  return r.rows.length === 1;
}

/** Revoke every live token of a user (admin suspend, account erasure). Returns the count. */
export async function revokeAllForUser(userId: string, ext?: DbTxClient): Promise<number> {
  if (!UUID_RE.test(userId)) return 0;
  const r = await queryOn<{ id: string }>(ext, 
    `UPDATE proxy_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
    [userId],
  );
  return r.rows.length;
}

/**
 * Gateway lookup by hash. Returns the token only while it is usable:
 * unrevoked, unexpired and under both caps. The caller still checks the owner.
 */
export async function findUsableByHash(hash: string): Promise<ProxyToken | null> {
  if (!HEX64.test(hash)) return null;
  const r = await query<Row>(
    `SELECT ${COLS} FROM proxy_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       AND (max_bytes IS NULL OR bytes_used < max_bytes)
       AND (max_spend_musd IS NULL OR spend_used_musd < max_spend_musd)`,
    [hash],
  );
  return r.rows[0] ? toToken(r.rows[0]) : null;
}

/**
 * Add gateway-metered usage. The conditional UPDATE succeeds only while
 * used + delta stays within each cap. When it would cross a cap, usage is
 * saturated at the cap instead, so the token is refused from the next request.
 * Returns whether the usage fitted under the caps, and whether the token is
 * now exhausted (a cap reached exactly, or saturated).
 */
export async function recordUsage(id: string, bytes: bigint, spendMusd: bigint): Promise<{ withinCaps: boolean; exhausted: boolean }> {
  if (!UUID_RE.test(id)) return { withinCaps: false, exhausted: true };
  const b = bytes < 0n ? 0n : bytes > MAX_TOKEN_BYTES ? MAX_TOKEN_BYTES : bytes;
  const s = spendMusd < 0n ? 0n : spendMusd > MAX_TOKEN_SPEND_MUSD ? MAX_TOKEN_SPEND_MUSD : spendMusd;
  if (b === 0n && s === 0n) return { withinCaps: true, exhausted: false };
  const ok = await query<{ id: string; exhausted: boolean }>(
    `UPDATE proxy_tokens
       SET bytes_used = bytes_used + $2::bigint, spend_used_musd = spend_used_musd + $3::bigint
     WHERE id = $1
       AND bytes_used + $2::bigint <= COALESCE(max_bytes, ${MAX_TOKEN_BYTES.toString()})
       AND spend_used_musd + $3::bigint <= COALESCE(max_spend_musd, ${MAX_TOKEN_SPEND_MUSD.toString()})
     RETURNING id,
       ((max_bytes IS NOT NULL AND bytes_used >= max_bytes)
         OR (max_spend_musd IS NOT NULL AND spend_used_musd >= max_spend_musd)) AS exhausted`,
    [id, b.toString(), s.toString()],
  );
  if (ok.rows.length === 1) return { withinCaps: true, exhausted: ok.rows[0].exhausted === true };
  await query(
    `UPDATE proxy_tokens
       SET bytes_used = LEAST(bytes_used + $2::bigint, COALESCE(max_bytes, ${MAX_TOKEN_BYTES.toString()})),
           spend_used_musd = LEAST(spend_used_musd + $3::bigint, COALESCE(max_spend_musd, ${MAX_TOKEN_SPEND_MUSD.toString()}))
     WHERE id = $1`,
    [id, b.toString(), s.toString()],
  );
  return { withinCaps: false, exhausted: true };
}
