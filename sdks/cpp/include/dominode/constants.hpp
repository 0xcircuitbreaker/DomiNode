#pragma once

#include <string>

namespace dominode {

inline constexpr const char* SDK_VERSION = "1.0.0";
inline constexpr const char* USER_AGENT = "dominode-sdk-cpp/1.0.0";
inline constexpr const char* DEFAULT_BASE_URL = "https://api.dominode.io";
inline constexpr const char* DEFAULT_PROXY_HOST = "proxy.dominode.io";
inline constexpr int DEFAULT_HTTP_PROXY_PORT = 8080;
inline constexpr int DEFAULT_SOCKS5_PROXY_PORT = 1080;
inline constexpr int TOKEN_REFRESH_BUFFER_SECONDS = 60;
inline constexpr int MAX_RATE_LIMIT_RETRIES = 1;

} // namespace dominode
