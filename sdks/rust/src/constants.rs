/// SDK version string.
pub const SDK_VERSION: &str = "1.0.0";

/// User-Agent header sent with every request.
pub const USER_AGENT: &str = "dominusnode-sdk-rust/1.0.0";

/// Default Dominus Node API base URL.
pub const DEFAULT_BASE_URL: &str = "https://api.dominusnode.com";

/// Default proxy hostname.
pub const DEFAULT_PROXY_HOST: &str = "proxy.dominusnode.com";

/// Default HTTP proxy port.
pub const DEFAULT_HTTP_PROXY_PORT: u16 = 8080;

/// Default SOCKS5 proxy port.
pub const DEFAULT_SOCKS5_PROXY_PORT: u16 = 1080;

/// How many seconds before JWT expiry we trigger a refresh.
pub const TOKEN_REFRESH_BUFFER_SECS: u64 = 60;

/// Maximum number of automatic retries on 429 rate-limit responses.
pub const MAX_RATE_LIMIT_RETRIES: u32 = 1;
