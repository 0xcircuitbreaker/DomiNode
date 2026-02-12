import { loadState, updateState } from "../shared/state.js";
import { getValidToken } from "./auth-manager.js";
import { disableProxy } from "./proxy-controller.js";
import { updateBadge } from "./badge-manager.js";
import { apiGet } from "../shared/api-client.js";
import { LOW_BALANCE_THRESHOLD_CENTS } from "../shared/constants.js";

interface WalletResponse {
  balance: number; // cents
}

let lastNotifiedLowBalance = false;

export async function pollBalance(): Promise<void> {
  const state = await loadState();

  // Skip if not authenticated
  if (!state.accessToken && !state.refreshToken) return;

  let token: string;
  try {
    token = await getValidToken();
  } catch {
    // Can't get valid token — skip this poll
    return;
  }

  let balance: number;
  try {
    const resp = await apiGet<WalletResponse>("/api/wallet", token);
    balance = resp.balance;
  } catch {
    // Network error — keep last known balance, don't update state
    return;
  }

  const previousBalance = state.balanceCents;
  const updated = await updateState({ balanceCents: balance, lastError: null });

  // Auto-disable proxy if balance is zero
  if (balance <= 0 && state.proxyEnabled) {
    await disableProxy();

    try {
      chrome.notifications.create("zero-balance", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "DomiNode",
        message: "Proxy disabled — wallet balance is $0.00. Please top up.",
      });
    } catch {
      // Notifications may not be available
    }
    return;
  }

  // Low balance warning (only notify once per transition)
  if (
    balance > 0 &&
    balance <= LOW_BALANCE_THRESHOLD_CENTS &&
    !lastNotifiedLowBalance
  ) {
    lastNotifiedLowBalance = true;
    try {
      chrome.notifications.create("low-balance", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "DomiNode",
        message: `Low balance: $${(balance / 100).toFixed(2)} remaining.`,
      });
    } catch {
      // Notifications may not be available
    }
  } else if (balance > LOW_BALANCE_THRESHOLD_CENTS) {
    lastNotifiedLowBalance = false;
  }

  updateBadge(updated);
}
