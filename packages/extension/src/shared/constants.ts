export const STORAGE_KEYS = {
  /** Non-secret settings (chrome.storage.local). */
  SETTINGS: "dominusnode_settings",
  /** API key (chrome.storage.local only; never sync). */
  SECRET: "dominusnode_secret",
  /** Per-run spend/balance state (chrome.storage.session when available). */
  RUN: "dominusnode_run",
} as const;

export const ALARMS = {
  BALANCE: "dominusnode_balance",
  ROTATE: "dominusnode_rotate",
} as const;

export const DEFAULT_API_BASE = "https://api.dominusnode.com";
export const DEFAULT_GATEWAY_HOST = "proxy.dominusnode.com";
export const DEFAULT_GATEWAY_PORT = 8080;

/** Poll interval for balance (chrome.alarms minimum is 0.5 min in packed builds). */
export const BALANCE_POLL_MINUTES = 1;

/** Response size cap for every API call. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Discard port on loopback: connection refused, so blocked traffic never goes direct. */
export const BLOCK_PROXY = "PROXY 127.0.0.1:9";

/** OFAC-sanctioned countries: never selectable as exit. */
export const SANCTIONED_COUNTRIES = new Set(["CU", "IR", "KP", "RU", "SY"]);
