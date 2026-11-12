#pragma once

#include <cstdint>
#include <cstddef>

namespace dominusnode {

inline constexpr const char* SDK_VERSION = "2.1.0";
inline constexpr const char* USER_AGENT = "dominusnode-sdk-cpp/2.1.0";
inline constexpr const char* DEFAULT_BASE_URL = "https://api.dominusnode.com";
inline constexpr const char* DEFAULT_PROXY_HOST = "proxy.dominusnode.com";
inline constexpr int DEFAULT_HTTP_PROXY_PORT = 8080;
inline constexpr int DEFAULT_SOCKS5_PROXY_PORT = 1080;
/// Gateway HTTPS proxy listener (PROXY_TLS_PORT), used with GatewayTls.
inline constexpr int DEFAULT_TLS_PROXY_PORT = 8443;
/// Refresh JWTs this long before expiry.
inline constexpr long long TOKEN_REFRESH_BUFFER_MS = 60000;
/// Hard cap on any response body the SDK reads (API or proxy fetch).
inline constexpr std::size_t MAX_RESPONSE_BYTES = 10u * 1024u * 1024u;
/// API request timeout.
inline constexpr long REQUEST_TIMEOUT_MS = 30000;
/// 429: one retry; wait = min(Retry-After, 10 s) +/-10 % jitter, floor 100 ms.
inline constexpr int MAX_RATE_LIMIT_RETRIES = 1;
inline constexpr long MAX_RETRY_WAIT_MS = 10000;
inline constexpr long MIN_RETRY_WAIT_MS = 100;
/// Largest value accepted for any *_cents argument (PostgreSQL INTEGER max).
inline constexpr std::int64_t MAX_AMOUNT_CENTS = 2147483647;

} // namespace dominusnode
