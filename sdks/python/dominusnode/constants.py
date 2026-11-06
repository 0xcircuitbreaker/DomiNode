"""SDK-wide constants (mirrors sdks/node/src/constants.ts)."""

SDK_VERSION = "2.0.0"
USER_AGENT = f"dominusnode-sdk-python/{SDK_VERSION}"
DEFAULT_BASE_URL = "https://api.dominusnode.com"
DEFAULT_PROXY_HOST = "proxy.dominusnode.com"
DEFAULT_HTTP_PROXY_PORT = 8080
DEFAULT_SOCKS5_PROXY_PORT = 1080
#: Gateway HTTPS proxy listener (PROXY_TLS_PORT), used with gateway_tls.
DEFAULT_TLS_PROXY_PORT = 8443
#: Refresh JWTs this many seconds before expiry.
TOKEN_REFRESH_BUFFER_SECONDS = 60
#: Hard cap on any response body the SDK reads (API or proxy fetch).
MAX_RESPONSE_BYTES = 10 * 1024 * 1024
#: API request timeout (seconds).
REQUEST_TIMEOUT_SECONDS = 30.0
#: 429 retry: one retry, wait = min(Retry-After, 10s) +/-10% jitter, floor 100ms.
MAX_RATE_LIMIT_RETRIES = 1
MAX_RETRY_WAIT_SECONDS = 10.0
MIN_RETRY_WAIT_SECONDS = 0.1
#: Largest value accepted for any *_cents argument (PostgreSQL INTEGER max).
MAX_AMOUNT_CENTS = 2_147_483_647
#: 1 USD = 1,000,000 µUSD.
MUSD_PER_USD = 1_000_000
