import { loadState, updateState } from "../shared/state.js";
import { isTokenExpired, refreshToken } from "./auth-manager.js";
import { updateBadge } from "./badge-manager.js";

export async function refreshTokenIfNeeded(): Promise<void> {
  const state = await loadState();

  // Skip if not authenticated
  if (!state.accessToken || !state.refreshToken) return;

  // Check if token is within 3 minutes of expiry
  if (!isTokenExpired(state.accessToken)) return;

  try {
    await refreshToken();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Network errors are transient — log but don't logout
    if (message.includes("fetch") || message.includes("network") || message.includes("Failed to fetch")) {
      console.warn("Token refresh failed (transient):", message);
      return;
    }

    // Auth errors — session is expired, disable proxy and clear tokens
    const { disableProxy } = await import("./proxy-controller.js");
    await disableProxy();
    const updated = await updateState({
      accessToken: null,
      refreshToken: null,
      proxyEnabled: false,
      isConnected: false,
      lastError: "Session expired — please log in again",
    });
    updateBadge(updated);

    // Show notification
    try {
      chrome.notifications.create("session-expired", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "DomiNode",
        message: "Session expired. Please log in again.",
      });
    } catch {
      // Notifications may not be available
    }
  }
}
