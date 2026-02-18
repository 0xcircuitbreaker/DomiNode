import { getApiBase } from "../shared/api-client.js";
import type { ProxyAdapterConfig as ProxyConfig } from "../shared/types.js";

const HOSTNAME_RE = /^[a-zA-Z0-9.\-]+$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function sanitizeHostname(host: string): string {
  // Allow IPv6 addresses (colons + hex digits)
  if (IPV6_RE.test(host)) return host;
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

let active = false;
let authListener: ((
  details: chrome.webRequest.WebAuthenticationChallengeDetails,
  callback: (response: chrome.webRequest.BlockingResponse) => void,
) => void) | null = null;

// R30 C-1: Rate limit credential submissions to prevent harvesting
let authAttempts = 0;
const MAX_AUTH_ATTEMPTS = 3;
const AUTH_RESET_MS = 60_000;

function buildBypassList(): string[] {
  // Bypass proxy for API host, localhost, and private IP ranges
  const apiUrl = new URL(getApiBase());
  return [
    apiUrl.hostname,
    "localhost",
    "127.0.0.1",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "::1",
  ];
}

function buildPacScript(config: ProxyConfig): string {
  const safeHost = sanitizeHostname(config.host);
  const safePort = sanitizePort(config.port);
  const bypassList = buildBypassList();
  // Build host-matching conditions for bypass
  const conditions = bypassList
    .map((h) => {
      if (h.includes("/")) {
        // CIDR — use isInNet for common private ranges
        if (h === "10.0.0.0/8") return `isInNet(dnsResolve(host), "10.0.0.0", "255.0.0.0")`;
        if (h === "172.16.0.0/12") return `isInNet(dnsResolve(host), "172.16.0.0", "255.240.0.0")`;
        if (h === "192.168.0.0/16") return `isInNet(dnsResolve(host), "192.168.0.0", "255.255.0.0")`;
        return "false";
      }
      // Sanitize bypass hostnames too
      const safeBypass = sanitizeHostname(h);
      // R18-H12: Use JSON.stringify for PAC script string interpolation to prevent
      // injection if values ever become user-configurable
      // IPv6 addresses: exact match only (dnsDomainIs doesn't apply)
      if (IPV6_RE.test(h)) {
        return `host === ${JSON.stringify("[" + safeBypass + "]")} || host === ${JSON.stringify(safeBypass)}`;
      }
      return `host === ${JSON.stringify(safeBypass)} || dnsDomainIs(host, ${JSON.stringify("." + safeBypass)})`;
    })
    .join(" ||\n      ");

  return `function FindProxyForURL(url, host) {
    if (${conditions}) {
      return "DIRECT";
    }
    return ${JSON.stringify("PROXY " + safeHost + ":" + safePort)};
  }`;
}

export function enable(config: ProxyConfig): void {
  if (config.protocol === "socks5") {
    // R29 H-4: Validate host/port for SOCKS5 mode (parity with PAC script path)
    const safeHost = sanitizeHostname(config.host);
    const safePort = sanitizePort(config.port);
    chrome.proxy.settings.set({
      value: {
        mode: "fixed_servers",
        rules: {
          singleProxy: {
            scheme: "socks5",
            host: safeHost,
            port: safePort,
          },
          bypassList: buildBypassList(),
        },
      },
      scope: "regular",
    });
  } else {
    // HTTP mode: use PAC script for bypass rules
    chrome.proxy.settings.set({
      value: {
        mode: "pac_script",
        pacScript: {
          data: buildPacScript(config),
        },
      },
      scope: "regular",
    });
  }

  // Set up auth handler for proxy 407 challenges
  if (authListener) {
    chrome.webRequest.onAuthRequired.removeListener(authListener);
  }

  const expectedHost = config.host;
  const expectedPort = config.port;
  authAttempts = 0; // R30 C-1: Reset on re-enable

  authListener = (details, callback) => {
    // Reject auth requests from other extensions (tabId === -1 for background requests)
    if (details.tabId === -1) {
      callback({});
      return;
    }
    // R30 C-1: Rate limit credential submissions to prevent harvesting
    if (authAttempts >= MAX_AUTH_ATTEMPTS) {
      callback({ cancel: true });
      return;
    }

    if (
      details.isProxy &&
      details.challenger &&
      details.challenger.host === expectedHost &&
      details.challenger.port === expectedPort
    ) {
      authAttempts++;
      setTimeout(() => { authAttempts = Math.max(0, authAttempts - 1); }, AUTH_RESET_MS);
      callback({
        authCredentials: {
          username: config.username,
          password: config.password,
        },
      });
    } else {
      callback({});
    }
  };

  chrome.webRequest.onAuthRequired.addListener(authListener, { urls: ["<all_urls>"] }, [
    "asyncBlocking",
  ]);

  active = true;
}

export function disable(): void {
  chrome.proxy.settings.clear({ scope: "regular" });

  if (authListener) {
    chrome.webRequest.onAuthRequired.removeListener(authListener);
    authListener = null;
  }

  authAttempts = 0; // R30 C-1: Reset rate limit on disable
  active = false;
}

export function isActive(): boolean {
  return active;
}
