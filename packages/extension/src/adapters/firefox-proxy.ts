import { getApiBase } from "../shared/api-client.js";
import type { ProxyAdapterConfig as ProxyConfig } from "../shared/types.js";

// Validate host/port to prevent injection via proxy config
const HOSTNAME_RE = /^[a-zA-Z0-9.\-]+$/;

function sanitizeHostname(host: string): string {
  if (!HOSTNAME_RE.test(host)) {
    throw new Error(`Invalid proxy hostname: ${host}`);
  }
  return host;
}

function sanitizePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid proxy port: ${port}`);
  }
  return port;
}

type ProxyInfo =
  | { type: "http"; host: string; port: number; username: string; password: string }
  | { type: "socks"; host: string; port: number; username: string; password: string; proxyDNS: boolean }
  | { type: "direct" };

const BYPASS_HOSTS = new Set([
  "localhost", "127.0.0.1", "::1",
  "169.254.169.254",
  "metadata.google.internal",
]);

function isPrivateIP(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const first = parseInt(parts[0], 10);
  const second = parseInt(parts[1], 10);
  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 0) return true;
  return false;
}

let currentConfig: ProxyConfig | null = null;
let listenerRegistered = false;

function handleRequest(details: { url: string }): ProxyInfo {
  if (!currentConfig) return { type: "direct" };

  // Proxy loop prevention: don't proxy requests to our own API
  const apiBase = getApiBase();
  if (details.url.startsWith(apiBase)) {
    return { type: "direct" };
  }

  // Bypass private IPs, localhost, and cloud metadata endpoints
  try {
    const parsed = new URL(details.url);
    if (BYPASS_HOSTS.has(parsed.hostname) || isPrivateIP(parsed.hostname)) {
      return { type: "direct" };
    }
  } catch {
    // If URL parsing fails, go direct for safety
    return { type: "direct" };
  }

  if (currentConfig.protocol === "socks5") {
    return {
      type: "socks",
      host: currentConfig.host,
      port: currentConfig.port,
      username: currentConfig.username,
      password: currentConfig.password,
      proxyDNS: true,
    };
  }

  return {
    type: "http",
    host: currentConfig.host,
    port: currentConfig.port,
    username: currentConfig.username,
    password: currentConfig.password,
  };
}

export function enable(config: ProxyConfig): void {
  // Validate host/port before storing config
  const safeHost = sanitizeHostname(config.host);
  const safePort = sanitizePort(config.port);
  currentConfig = { ...config, host: safeHost, port: safePort };

  if (!listenerRegistered) {
    // @ts-expect-error Firefox proxy API uses browser.proxy.onRequest
    browser.proxy.onRequest.addListener(handleRequest, { urls: ["<all_urls>"] });
    listenerRegistered = true;
  }
}

export function disable(): void {
  currentConfig = null;

  if (listenerRegistered) {
    try {
      // @ts-expect-error Firefox proxy API
      browser.proxy.onRequest.removeListener(handleRequest);
    } catch {
      // Listener may already be removed
    }
    listenerRegistered = false;
  }
}

export function isActive(): boolean {
  return currentConfig !== null && listenerRegistered;
}
