import type { ExtensionState } from "../shared/types.js";

export function setBadgeConnected(): void {
  chrome.action.setBadgeText({ text: "ON" });
  chrome.action.setBadgeBackgroundColor({ color: "#22C55E" });
}

export function setBadgeDisconnected(): void {
  chrome.action.setBadgeText({ text: "" });
}

export function setBadgeError(text = "ERR"): void {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#EF4444" });
}

export function setBadgeLowBalance(): void {
  chrome.action.setBadgeText({ text: "$!" });
  chrome.action.setBadgeBackgroundColor({ color: "#F59E0B" });
}

export function updateBadge(state: ExtensionState): void {
  if (state.proxyEnabled && state.balanceCents <= 0) {
    setBadgeLowBalance();
  } else if (state.lastError) {
    setBadgeError();
  } else if (state.isConnected) {
    setBadgeConnected();
  } else {
    setBadgeDisconnected();
  }
}
