export const STORAGE_KEYS = {
  STATE: "dominusnode_ext_state",
  AUTH: "dominusnode_ext_auth",
} as const;

export const ALARM_NAMES = {
  TOKEN_REFRESH: "dominusnode_token_refresh",
  BALANCE_POLL: "dominusnode_balance_poll",
  SESSION_ROTATE: "dominusnode_session_rotate",
} as const;

export const DEFAULT_API_BASE = "https://proxy.dominusnode.com";
export const PROD_API_BASE = "https://api.dominusnode.com";
// DEV_API_BASE uses HTTP intentionally for local development only
export const DEV_API_BASE = "http://localhost:3000";

export const PROXY_DEFAULTS = {
  HTTP_PORT: 8080,
  SOCKS5_PORT: 1080,
} as const;

// Token refresh 3 minutes before expiry (12 min for 15 min tokens)
export const TOKEN_REFRESH_MINUTES = 12;
export const BALANCE_POLL_MINUTES = 2;

// Low balance warning threshold in cents ($1.00)
export const LOW_BALANCE_THRESHOLD_CENTS = 100;
