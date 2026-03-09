import * as http from "node:http";
import { hashApiKey, verifyProxySessionToken, userRepo, createLogger } from "@dominusnode/shared";
import type { User } from "@dominusnode/shared";

const log = createLogger("proxy:auth");

export interface ProxyOptions {
  country?: string;   // 2-letter country code (e.g., "US", "DE")
  state?: string;     // lowercase state name (e.g., "california")
  city?: string;      // lowercase city name (e.g., "losangeles")
  asn?: number;       // ASN number (placeholder for future providers)
  sessionId?: string; // sticky session ID (alphanumeric)
  proxyType?: "dc" | "residential" | "auto"; // pool selection
  walletId?: string;  // agentic wallet UUID for policy enforcement
}

export interface AuthResult {
  userId: string;
  user: User;
  proxyOptions: ProxyOptions;
  teamId: string | null;
}

/**
 * Parse routing options from proxy username.
 * Format: `country-US-session-abc123` or just `user` or any combo.
 * Segments are dash-separated key-value pairs.
 */
function parseProxyOptions(username: string): ProxyOptions {
  const options: ProxyOptions = {};

  // Match proxyType prefix: dc-, residential-, auto- at the start of username
  const typeMatch = username.match(/^(dc|residential|auto)(?:-|$)/);
  if (typeMatch) {
    options.proxyType = typeMatch[1] as "dc" | "residential" | "auto";
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

  // Match asn-NNNNN pattern
  const asnMatch = username.match(/(?:^|-)asn-(\d{1,10})(?:-|$)/);
  if (asnMatch) {
    const asnNum = parseInt(asnMatch[1], 10);
    if (asnNum >= 1 && asnNum <= 4_294_967_295) {
      options.asn = asnNum;
    }
  }

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

  // ─── Path A: Wallet proxy session token (HMAC, ~3-5μs) ────────────
  if (credential.startsWith("dn_proxy_")) {
    const session = verifyProxySessionToken(credential);
    if (!session) {
      log.warn("invalid proxy session token");
      return null;
    }

    try {
      // Look up user by ID (from the HMAC-verified payload)
      const user = await userRepo.findUserById(session.userId);
      if (!user) {
        log.warn("proxy session user not found", { userId: session.userId });
        return null;
      }

      // Reject suspended/deleted users
      if (user.status !== "active") {
        log.warn("rejected non-active user (session)", { userId: user.id, status: user.status });
        return null;
      }

      // Reject users who haven't verified their email
      if (!user.email_verified) {
        log.warn("rejected unverified email (session)", { userId: user.id });
        return null;
      }

      // Verify wallet address still matches (user hasn't unlinked wallet)
      // Case-insensitive comparison for defense-in-depth
      if (!user.wallet_address || user.wallet_address.toLowerCase() !== session.walletAddress.toLowerCase()) {
        log.warn("wallet address mismatch", { userId: user.id });
        return null;
      }

      const proxyOptions = parseProxyOptions(username);
      return { userId: user.id, user, proxyOptions, teamId: null };
    } catch (err) {
      log.error("session auth DB error", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  // ─── Path B: Traditional API key (SHA-256 hash, ~5μs) ─────────────
  if (!credential.startsWith("dn_live_")) return null;

  const keyHash = hashApiKey(credential);

  try {
    const result = await userRepo.findUserByApiKeyHash(keyHash);
    if (!result) {
      // Only log static prefix — don't leak key material
      log.warn("invalid API key", { prefix: credential.slice(0, 8) });
      return null;
    }

    // Reject suspended/deleted users at proxy auth layer
    if (result.user.status !== "active") {
      log.warn("rejected non-active user", { userId: result.user.id, status: result.user.status });
      return null;
    }

    // Reject users who haven't verified their email (wallet-auth users are pre-verified)
    if (!result.user.email_verified) {
      log.warn("rejected unverified email", { userId: result.user.id });
      return null;
    }

    const proxyOptions = parseProxyOptions(username);

    return { userId: result.user.id, user: result.user, proxyOptions, teamId: result.apiKey.team_id ?? null };
  } catch (err) {
    log.error("auth DB error", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
