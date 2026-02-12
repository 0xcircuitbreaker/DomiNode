import * as crypto from "node:crypto";
import { BLOCKED_COUNTRY_CODES } from "@dominode/shared";

export interface PacketStreamConfig {
  gatewayHost: string;
  gatewayPort: number;
  username: string;
  password: string;
  resellerApiUrl: string;
  resellerApiKey: string;
}

export function getConfig(): PacketStreamConfig {
  return {
    gatewayHost: process.env["PACKETSTREAM_GATEWAY_HOST"] ?? "gw.packetstream.io",
    gatewayPort: parseInt(process.env["PACKETSTREAM_GATEWAY_PORT"] ?? "31112", 10),
    username: process.env["PACKETSTREAM_USERNAME"] ?? "",
    password: process.env["PACKETSTREAM_PASSWORD"] ?? "",
    resellerApiUrl: process.env["PACKETSTREAM_RESELLER_API_URL"] ?? "https://reseller.packetstream.io",
    resellerApiKey: process.env["PACKETSTREAM_RESELLER_API_KEY"] ?? "",
  };
}

export function validateConfig(): void {
  const config = getConfig();
  if (!config.username || !config.password) {
    throw new Error("PACKETSTREAM_USERNAME and PACKETSTREAM_PASSWORD are required");
  }
}

export interface ProxyOptions {
  country?: string;
  state?: string;   // lowercase, no spaces (e.g. "california")
  city?: string;    // lowercase, no spaces (e.g. "losangeles")
  asn?: number;     // placeholder — not supported by PacketStream
  sticky?: boolean;
  sessionId?: string;
}

export interface UpstreamProxy {
  host: string;
  port: number;
  username: string;
  password: string;
  proxyAuth: string; // base64-encoded "username:password"
}

export function generateStickySession(): string {
  return crypto.randomBytes(4).toString("hex");
}

export function buildUpstreamProxy(options?: ProxyOptions): UpstreamProxy {
  const config = getConfig();
  let password = config.password;

  if (options?.country) {
    const country = options.country.toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) {
      throw new Error("Invalid country code: must be exactly 2 ASCII letters");
    }
    if (BLOCKED_COUNTRY_CODES.has(country)) {
      throw new Error(`Country ${country} is sanctioned and cannot be used as proxy exit`);
    }
    password += `_country-${country}`;

    // State targeting (requires country)
    if (options.state) {
      const state = options.state.toLowerCase();
      if (!/^[a-z]{2,30}$/.test(state)) {
        throw new Error("Invalid state: must be 2-30 lowercase letters");
      }
      password += `_state-${state}`;
    }

    // City targeting (requires country)
    if (options.city) {
      const city = options.city.toLowerCase();
      if (!/^[a-z]{2,50}$/.test(city)) {
        throw new Error("Invalid city: must be 2-50 lowercase letters");
      }
      password += `_city-${city}`;
    }
  } else {
    // State/city require country
    if (options?.state) {
      throw new Error("State targeting requires a country code");
    }
    if (options?.city) {
      throw new Error("City targeting requires a country code");
    }
  }

  // ASN silently ignored for PacketStream (future providers may support it)

  if (options?.sticky || options?.sessionId) {
    const sessionId = options?.sessionId ?? generateStickySession();
    if (!/^[a-zA-Z0-9]+$/.test(sessionId)) {
      throw new Error("Invalid sessionId: must be alphanumeric only");
    }
    password += `_session-${sessionId}`;
  }

  const proxyAuth = Buffer.from(`${config.username}:${password}`).toString("base64");

  const proxy: UpstreamProxy = {
    host: config.gatewayHost,
    port: config.gatewayPort,
    username: config.username,
    password,
    proxyAuth,
  };

  // Make sensitive fields non-enumerable to prevent accidental logging/serialization
  Object.defineProperties(proxy, {
    password: { enumerable: false },
    proxyAuth: { enumerable: false },
  });

  return proxy;
}

// ─── Reseller API ────────────────────────────────────────────────────

export async function addBalance(username: string, dataGb: number): Promise<void> {
  const config = getConfig();
  const resp = await fetch(`${config.resellerApiUrl}/proxy_api/v1/basic/users/add_balance`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resellerApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, data_gb: dataGb }),
  });

  if (!resp.ok) {
    throw new Error(`PacketStream addBalance failed: ${resp.status} ${await resp.text()}`);
  }
}

export async function getUserInfo(username: string): Promise<unknown> {
  // Validate and encode username to prevent path traversal (R12 H-3)
  if (!username || !/^[a-zA-Z0-9_.-]+$/.test(username)) {
    throw new Error("Invalid username: must be alphanumeric, dots, hyphens, or underscores");
  }
  const config = getConfig();
  const resp = await fetch(`${config.resellerApiUrl}/proxy_api/v1/basic/users/get/${encodeURIComponent(username)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resellerApiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!resp.ok) {
    throw new Error(`PacketStream getUserInfo failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}
