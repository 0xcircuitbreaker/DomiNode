"""SDK constants."""

SDK_VERSION = "1.0.0"
USER_AGENT = f"dominusnode-sdk-python/{SDK_VERSION}"

DEFAULT_BASE_URL = "https://api.dominusnode.com"
DEFAULT_PROXY_HOST = "proxy.dominusnode.com"
DEFAULT_HTTP_PROXY_PORT = 8080
DEFAULT_SOCKS5_PROXY_PORT = 1080

# Token refresh buffer: refresh if token expires within this many seconds
TOKEN_REFRESH_BUFFER_SECONDS = 60

# Price per GB in cents (matches backend PRICE_PER_GB_CENTS)
PRICE_PER_GB_CENTS = 500

# Bytes per GB
BYTES_PER_GB = 1_073_741_824
