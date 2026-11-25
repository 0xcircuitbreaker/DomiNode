import * as http from "node:http";
import { verifyProxySessionToken, userRepo, proxyTokenRepo, createLogger } from "@dominusnode/shared";
import type { User, ExitClass } from "@dominusnode/shared";

const log = createLogger("proxy:auth");

export interface ProxyOptions {
  country?: string;   // 2-letter country code (e.g., "US", "DE")
  state?: string;     // lowercase state name; parsed only to refuse it (no geo DB)
  city?: string;      // lowercase city name; parsed only to refuse it (no geo DB)
  /** asn-<n>: exit only through a node whose gateway-derived egress ASN is n. */
  asn?: number;
  /** Targeting flags the gateway cannot honor (city-, state-, or a malformed asn-); the request is refused. */
  unsupportedTargeting?: Array<"city" | "state" | "asn">;
  sessionId?: string; // sticky session ID (alphanumeric)
  /** @deprecated legacy dc-/residential-/auto- prefix; mapped to ipClass. */
  proxyType?: "dc" | "residential" | "auto";
  /**
   * Relay exit class: class-residential|dc|mobile|masked (or legacy prefix).
   * masked (anonymizer egress) is only ever served when requested explicitly.
   */
  ipClass?: ExitClass;
  /** allowhttp-1: opt in to plaintext HTTP through the exit node. */
  allowHttp?: boolean;
  walletId?: string;  // agentic wallet UUID for policy enforcement
}

export interface AuthResult {
  userId: string;
  user: User;
  proxyOptions: ProxyOptions;
  teamId: string | null;
  /** Opaque dn_proxy_ token id when the request used one; its caps apply. */
  proxyTokenId?: string | null;
}

// ─── Opaque dn_proxy_ tokens (proxy_tokens table) ─────────────────────
// Looked up by SHA-256 hash with a short positive cache, so revocation
// (and expiry) takes effect within PROXY_TOKEN_CACHE_TTL_MS.
export const PROXY_TOKEN_CACHE_TTL_MS = 5_000;
const PROXY_TOKEN_CACHE_MAX = 10_000;
interface CachedToken { tokenId: string; userId: string; expiresAt: number; fetchedAt: number }
const tokenCache = new Map<string, CachedToken>();

export function clearProxyTokenCache(): void { tokenCache.clear(); }

async function lookupProxyToken(hash: string): Promise<CachedToken | null> {
  const now = Date.now();
  const hit = tokenCache.get(hash);
  if (hit && now - hit.fetchedAt < PROXY_TOKEN_CACHE_TTL_MS && hit.expiresAt > now) return hit;
  tokenCache.delete(hash);
  const t = await proxyTokenRepo.findUsableByHash(hash);
  if (!t) return null;
  if (tokenCache.size >= PROXY_TOKEN_CACHE_MAX) {
    for (const [k, v] of tokenCache) if (now - v.fetchedAt >= PROXY_TOKEN_CACHE_TTL_MS) tokenCache.delete(k);
    while (tokenCache.size >= PROXY_TOKEN_CACHE_MAX) {
      const oldest = tokenCache.keys().next().value;
      if (oldest === undefined) break;
      tokenCache.delete(oldest);
    }
  }
  const entry = { tokenId: t.id, userId: t.userId, expiresAt: t.expiresAt.getTime(), fetchedAt: now };
  tokenCache.set(hash, entry);
  return entry;
}

/**
 * Count settled, gateway-metered usage against a token's caps. When a cap is
 * reached the cached entry is dropped so the next request re-reads the row and
 * is refused. Never throws.
 */
export async function recordProxyTokenUsage(tokenId: string, bytes: bigint, spendMusd: bigint): Promise<void> {
  try {
    const r = await proxyTokenRepo.recordUsage(tokenId, bytes, spendMusd);
    if (!r.withinCaps) {
      for (const [k, v] of tokenCache) if (v.tokenId === tokenId) tokenCache.delete(k);
      log.info("proxy token cap reached", { tokenId });
    }
  } catch (err) {
    log.error("proxy token usage update failed", { tokenId, error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
  }
}

export interface VerifiedCredential { user: User; teamId: string | null; proxyTokenId: string | null }

/**
 * Verify a proxy password: dn_live_ API key, opaque dn_proxy_ token, or a
 * legacy HMAC dn_proxy_ session token (accepted until it expires). Requires an
 * active, verified owner. Shared by the HTTP proxy and SOCKS5.
 */
export async function verifyProxyCredential(credential: string): Promise<VerifiedCredential | null> {
  if (credential.startsWith("dn_proxy_")) {
    if (proxyTokenRepo.OPAQUE_PROXY_TOKEN_RE.test(credential)) {
      const t = await lookupProxyToken(proxyTokenRepo.hashProxyToken(credential));
      if (!t) {
        log.warn("invalid, revoked, expired or exhausted proxy token");
        return null;
      }
      const user = await userRepo.findUserById(t.userId);
      if (!user || user.status !== "active" || !user.email_verified) {
        log.warn("rejected proxy token owner", { userId: t.userId });
        return null;
      }
      return { user, teamId: null, proxyTokenId: t.tokenId };
    }
    // Legacy stateless HMAC token (wallet-auth proxy session), until it expires.
    const session = verifyProxySessionToken(credential);
    if (!session) {
      log.warn("invalid proxy session token");
      return null;
    }
    const user = await userRepo.findUserById(session.userId);
    if (!user || user.status !== "active" || !user.email_verified) {
      log.warn("rejected proxy session user", { userId: session.userId });
      return null;
    }
    // Wallet still linked (case-insensitive)
    if (!user.wallet_address || user.wallet_address.toLowerCase() !== session.walletAddress.toLowerCase()) {
      log.warn("wallet address mismatch", { userId: user.id });
      return null;
    }
    return { user, teamId: null, proxyTokenId: null };
  }

  if (!credential.startsWith("dn_live_")) return null;
  const result = await userRepo.findUserByApiKey(credential);
  if (!result) {
    log.warn("invalid API key", { prefix: credential.slice(0, 8) });
    return null;
  }
  if (result.user.status !== "active") {
    log.warn("rejected non-active user", { userId: result.user.id, status: result.user.status });
    return null;
  }
  if (!result.user.email_verified) {
    log.warn("rejected unverified email", { userId: result.user.id });
    return null;
  }
  return { user: result.user, teamId: result.apiKey.team_id ?? null, proxyTokenId: null };
}

/**
 * Parse routing options from proxy username.
 * Format: `country-US-session-abc123` or just `user` or any combo.
 * Segments are dash-separated key-value pairs.
 */
export function parseProxyOptions(username: string): ProxyOptions {
  const options: ProxyOptions = {};

  // Deprecated proxyType prefix: dc-, residential-, auto- (maps to ipClass)
  const typeMatch = username.match(/^(dc|residential|auto)(?:-|$)/);
  if (typeMatch) {
    options.proxyType = typeMatch[1] as "dc" | "residential" | "auto";
    if (options.proxyType !== "auto") options.ipClass = options.proxyType;
  }

  // class-residential|dc|mobile|masked (overrides the legacy prefix)
  const classMatch = username.match(/(?:^|-)class-(residential|dc|mobile|masked)(?:-|$)/);
  if (classMatch) {
    options.ipClass = classMatch[1] as ExitClass;
  }

  // allowhttp-1: plaintext HTTP opt-in
  if (/(?:^|-)allowhttp-1(?:-|$)/.test(username)) {
    options.allowHttp = true;
  }

  // Match country-XX pattern
  const countryMatch = username.match(/(?:^|-)country-([A-Za-z]{2})(?:-|$)/);
  if (countryMatch) {
    options.country = countryMatch[1].toUpperCase();
  }

  // Match state-xxxx pattern
  const stateMatch = username.match(/(?:^|-)state-([a-zA-Z]{2,30})(?:-|$)/);
  if (stateMatch) {
    options.state = stateMatch[1].toLowerCase();
  }

  // Match city-xxxx pattern
  const cityMatch = username.match(/(?:^|-)city-([a-zA-Z]{2,50})(?:-|$)/);
  if (cityMatch) {
    options.city = cityMatch[1].toLowerCase();
  }

  const unsupported: Array<"city" | "state" | "asn"> = [];
  if (/(?:^|-)city-/.test(username)) unsupported.push("city");
  if (/(?:^|-)state-/.test(username)) unsupported.push("state");

  // Match asn-NNNNN pattern
  const asnMatch = username.match(/(?:^|-)asn-(\d{1,10})(?:-|$)/);
  if (asnMatch) {
    const asnNum = parseInt(asnMatch[1], 10);
    if (asnNum >= 1 && asnNum <= 4_294_967_295) {
      options.asn = asnNum;
    }
  }
  // A malformed or out-of-range asn- must fail closed, never drop the constraint.
  if (/(?:^|-)asn-/.test(username) && options.asn === undefined) unsupported.push("asn");
  if (unsupported.length > 0) options.unsupportedTargeting = unsupported;

  // Match session-XXXX pattern (cap at 255 chars to prevent log/memory abuse)
  const sessionMatch = username.match(/(?:^|-)session-([a-zA-Z0-9]+)(?:-|$)/);
  if (sessionMatch) {
    options.sessionId = sessionMatch[1].slice(0, 255);
  }

  // Match wallet-UUID pattern for agentic wallet policy enforcement
  const walletMatch = username.match(/(?:^|-)wallet-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-|$)/i);
  if (walletMatch) {
    options.walletId = walletMatch[1].toLowerCase();
  }

  return options;
}

export const UNSUPPORTED_TARGETING_CODE = "UNSUPPORTED_TARGETING";

/** Client-facing refusal text for city-/state-/malformed asn- flags, or null when none were sent. */
export function unsupportedTargetingMessage(o: ProxyOptions): string | null {
  const u = o.unsupportedTargeting;
  if (!u || u.length === 0) return null;
  const parts = u.filter((f) => f !== "asn").map((f) => `${f}-`);
  const msgs: string[] = [];
  if (parts.length > 0) msgs.push(`Unsupported targeting flag(s): ${parts.join(", ")}. Use country-XX or asn-<n>.`);
  if (u.includes("asn")) msgs.push("Invalid asn- flag: use asn-<n> with n from 1 to 4294967295.");
  return msgs.join(" ");
}

export async function authenticateRequest(
  req: http.IncomingMessage,
): Promise<AuthResult | null> {
  const authHeader = req.headers["proxy-authorization"];
  if (!authHeader) return null;

  // Parse "Basic <base64>"
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Basic") return null;

  let decoded: string;
  try {
    decoded = Buffer.from(parts[1], "base64").toString("utf-8");
  } catch {
    return null;
  }

  // Format: [options]:dn_live_xxxx (API key) or [options]:dn_proxy_xxxx (session token)
  const colonIdx = decoded.indexOf(":");
  if (colonIdx === -1) return null;

  const username = decoded.slice(0, colonIdx);
  const credential = decoded.slice(colonIdx + 1);

  try {
    const v = await verifyProxyCredential(credential);
    if (!v) return null;
    const proxyOptions = parseProxyOptions(username);
    return { userId: v.user.id, user: v.user, proxyOptions, teamId: v.teamId, proxyTokenId: v.proxyTokenId };
  } catch (err) {
    log.error("auth DB error", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
