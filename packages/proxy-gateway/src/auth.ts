import * as http from "node:http";
import { hashApiKey, userRepo, createLogger } from "@dominode/shared";
import type { User } from "@dominode/shared";

const log = createLogger("proxy:auth");

export interface ProxyOptions {
  country?: string;   // 2-letter country code (e.g., "US", "DE")
  sessionId?: string; // sticky session ID (alphanumeric)
}

export interface AuthResult {
  userId: string;
  user: User;
  proxyOptions: ProxyOptions;
}

/**
 * Parse routing options from proxy username.
 * Format: `country-US-session-abc123` or just `user` or any combo.
 * Segments are dash-separated key-value pairs.
 */
function parseProxyOptions(username: string): ProxyOptions {
  const options: ProxyOptions = {};

  // Match country-XX pattern
  const countryMatch = username.match(/(?:^|-)country-([A-Za-z]{2})(?:-|$)/);
  if (countryMatch) {
    options.country = countryMatch[1].toUpperCase();
  }

  // Match session-XXXX pattern
  const sessionMatch = username.match(/(?:^|-)session-([a-zA-Z0-9]+)(?:-|$)/);
  if (sessionMatch) {
    options.sessionId = sessionMatch[1];
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

  // Format: [options]:dn_live_xxxx (password is the API key, username has routing options)
  const colonIdx = decoded.indexOf(":");
  if (colonIdx === -1) return null;

  const username = decoded.slice(0, colonIdx);
  const apiKey = decoded.slice(colonIdx + 1);
  if (!apiKey.startsWith("dn_live_")) return null;

  const keyHash = hashApiKey(apiKey);

  try {
    const result = await userRepo.findUserByApiKeyHash(keyHash);
    if (!result) {
      log.warn("invalid API key", { prefix: apiKey.slice(0, 16) });
      return null;
    }

    const proxyOptions = parseProxyOptions(username);

    return { userId: result.user.id, user: result.user, proxyOptions };
  } catch (err) {
    log.error("auth DB error", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
