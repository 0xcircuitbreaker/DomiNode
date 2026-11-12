export const SDK_VERSION = "2.0.1";
export const USER_AGENT = `dominusnode-sdk-node/${SDK_VERSION}`;
export const DEFAULT_BASE_URL = "https://api.dominusnode.daedalusdevelopmentgroup.com";
export const DEFAULT_PROXY_HOST = "proxy.dominusnode.daedalusdevelopmentgroup.com";
export const DEFAULT_HTTP_PROXY_PORT = 8080;
export const DEFAULT_SOCKS5_PROXY_PORT = 1080;
export const DEFAULT_TLS_PROXY_PORT = 8443;
/** Refresh JWTs this long before expiry. */
export const TOKEN_REFRESH_BUFFER_MS = 60_000;
/** Hard cap on any response body the SDK reads (API or proxy fetch). */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** API request timeout. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** 429 retry: one retry, wait = min(Retry-After, 10s) +/-10% jitter, floor 100ms. */
export const MAX_RATE_LIMIT_RETRIES = 1;
export const MAX_RETRY_WAIT_MS = 10_000;
export const MIN_RETRY_WAIT_MS = 100;
/** Largest value accepted for any *Cents argument (PostgreSQL INTEGER max). */
export const MAX_AMOUNT_CENTS = 2_147_483_647;
/** 1 USD = 1,000,000 µUSD. */
export const MUSD_PER_USD = 1_000_000n;
