import type { ProxyAdapterConfig as ProxyConfig } from "../shared/types.js";
import { loadState, updateState } from "../shared/state.js";
import { buildProxyUsername } from "../shared/proxy-config.js";
import { ALARM_NAMES, PROXY_DEFAULTS } from "../shared/constants.js";
import { updateBadge } from "./badge-manager.js";

// ─── Adapter interface ───────────────────────────────────────────
interface ProxyAdapter {
  enable(config: ProxyConfig): void;
  disable(): void;
  isActive(): boolean;
}

type BrowserType = "firefox" | "chromium";

function detectBrowser(): BrowserType {
  try {
    // @ts-expect-error Firefox global
    if (typeof browser !== "undefined" && browser.proxy?.onRequest) {
      return "firefox";
    }
  } catch {
    // Not Firefox
  }
  return "chromium";
}

let adapter: ProxyAdapter | null = null;

async function initAdapter(): Promise<ProxyAdapter> {
  if (adapter) return adapter;

  const browserType = detectBrowser();
  if (browserType === "firefox") {
    const ff = await import("../adapters/firefox-proxy.js");
    adapter = ff;
  } else {
    const cr = await import("../adapters/chromium-proxy.js");
    adapter = cr;
  }
  return adapter;
}

// ─── Public API ──────────────────────────────────────────────────

export async function enableProxy(): Promise<void> {
  const state = await loadState();
  if (!state.apiKey) throw new Error("No API key configured");

  // Pre-check balance: refuse to enable proxy with zero balance
  if (state.balanceCents <= 0) {
    throw new Error("Cannot enable proxy: wallet balance is $0.00. Please top up first.");
  }

  const proxyAdapter = await initAdapter();
  const username = buildProxyUsername(state);
  const port =
    state.proxyProtocol === "socks5" ? PROXY_DEFAULTS.SOCKS5_PORT : PROXY_DEFAULTS.HTTP_PORT;

  // Derive proxy host from API base URL (same server, different port)
  const { getApiBase } = await import("../shared/api-client.js");
  let host: string;
  try {
    const apiUrl = new URL(getApiBase());
    host = apiUrl.hostname;
  } catch {
    host = "localhost";
  }

  const config: ProxyConfig = {
    host,
    port,
    protocol: state.proxyProtocol,
    username,
    password: state.apiKey,
  };

  proxyAdapter.enable(config);

  // Prevent WebRTC IP leaks: force WebRTC to use proxy or disable non-proxy connections
  try {
    if (chrome.privacy?.network?.webRTCIPHandlingPolicy) {
      await chrome.privacy.network.webRTCIPHandlingPolicy.set({
        value: "disable_non_proxied_udp",
      });
    }
  } catch {
    // chrome.privacy may not be available in all contexts
  }

  const updated = await updateState({
    proxyEnabled: true,
    isConnected: true,
    lastError: null,
  });

  // Set up session rotation alarm if configured
  if (state.rotationIntervalMinutes > 0) {
    chrome.alarms.create(ALARM_NAMES.SESSION_ROTATE, {
      periodInMinutes: state.rotationIntervalMinutes,
    });
  }

  updateBadge(updated);
}

export async function disableProxy(): Promise<void> {
  const proxyAdapter = await initAdapter();
  proxyAdapter.disable();

  // Restore default WebRTC behavior when proxy is disabled
  try {
    if (chrome.privacy?.network?.webRTCIPHandlingPolicy) {
      await chrome.privacy.network.webRTCIPHandlingPolicy.set({
        value: "default",
      });
    }
  } catch {
    // chrome.privacy may not be available in all contexts
  }

  // Clear session rotation alarm
  chrome.alarms.clear(ALARM_NAMES.SESSION_ROTATE);

  const updated = await updateState({
    proxyEnabled: false,
    isConnected: false,
  });

  updateBadge(updated);
}

export async function reconfigureProxy(): Promise<void> {
  const state = await loadState();
  if (!state.proxyEnabled) return;
  await disableProxy();
  // Re-enable with current state (which has already been updated by the caller)
  await enableProxy();
}
