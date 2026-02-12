#include "dominode/token_manager.hpp"
#include "dominode/constants.hpp"
#include "dominode/errors.hpp"

#include <nlohmann/json.hpp>
#include <cstring>
#include <ctime>

#if defined(__linux__) || defined(__APPLE__)
#include <strings.h>  // explicit_bzero on some platforms
#endif

namespace dominode {

// Portably zero memory without the compiler optimizing it away.
// Zeros the full capacity (not just size) to cover SSO and heap buffers,
// then releases heap memory via shrink_to_fit.
void TokenManager::secure_clear(std::string& s) {
    if (s.empty() && s.capacity() == 0) return;
    size_t cap = s.capacity();
#if defined(__linux__) || (defined(__APPLE__) && defined(__MACH__))
    explicit_bzero(s.data(), cap);
#elif defined(_WIN32)
    SecureZeroMemory(s.data(), cap);
#else
    volatile char* p = reinterpret_cast<volatile char*>(s.data());
    for (size_t i = 0; i < cap; ++i) {
        p[i] = 0;
    }
#endif
    s.clear();
    s.shrink_to_fit();
}

TokenManager::~TokenManager() {
    clear();
}

void TokenManager::set_tokens(const std::string& access, const std::string& refresh) {
    std::lock_guard<std::mutex> lock(refresh_mutex_);
    secure_clear(access_token_);
    access_token_ = access;
    if (!refresh.empty()) {
        secure_clear(refresh_token_);
        refresh_token_ = refresh;
    }
}

bool TokenManager::has_access_token() const {
    std::lock_guard<std::mutex> lock(refresh_mutex_);
    return !access_token_.empty();
}

bool TokenManager::has_refresh_token() const {
    std::lock_guard<std::mutex> lock(refresh_mutex_);
    return !refresh_token_.empty();
}

bool TokenManager::is_expired(const std::string& token) const {
    if (token.empty()) return true;

    // Parse JWT: header.payload.signature
    auto first_dot = token.find('.');
    if (first_dot == std::string::npos) return true;
    auto second_dot = token.find('.', first_dot + 1);
    if (second_dot == std::string::npos) return true;

    std::string payload_b64 = token.substr(first_dot + 1, second_dot - first_dot - 1);

    // Convert base64url to standard base64
    for (auto& c : payload_b64) {
        if (c == '-') c = '+';
        else if (c == '_') c = '/';
    }
    // Pad to multiple of 4
    while (payload_b64.size() % 4 != 0) {
        payload_b64 += '=';
    }

    // Simple base64 decode
    static const std::string b64_chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    auto b64_index = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return -1;
    };

    std::string decoded;
    decoded.reserve(payload_b64.size() * 3 / 4);

    for (size_t i = 0; i < payload_b64.size(); i += 4) {
        int a = b64_index(payload_b64[i]);
        int b = (i + 1 < payload_b64.size()) ? b64_index(payload_b64[i + 1]) : 0;
        int c = (i + 2 < payload_b64.size()) ? b64_index(payload_b64[i + 2]) : 0;
        int d = (i + 3 < payload_b64.size()) ? b64_index(payload_b64[i + 3]) : 0;

        if (a < 0 || b < 0) return true;

        decoded += static_cast<char>((a << 2) | (b >> 4));
        if (i + 2 < payload_b64.size() && payload_b64[i + 2] != '=') {
            decoded += static_cast<char>(((b & 0x0F) << 4) | (c >> 2));
        }
        if (i + 3 < payload_b64.size() && payload_b64[i + 3] != '=') {
            decoded += static_cast<char>(((c & 0x03) << 6) | d);
        }
    }

    try {
        auto payload = nlohmann::json::parse(decoded);
        if (!payload.contains("exp") || !payload["exp"].is_number()) return true;
        int64_t exp = payload["exp"].get<int64_t>();
        int64_t now = static_cast<int64_t>(std::time(nullptr));
        return exp < (now + TOKEN_REFRESH_BUFFER_SECONDS);
    } catch (...) {
        return true;
    }
}

std::string TokenManager::get_valid_token() {
    std::lock_guard<std::mutex> lock(refresh_mutex_);

    if (!access_token_.empty() && !is_expired(access_token_)) {
        return access_token_;
    }

    if (refresh_token_.empty() || !refresh_fn_) {
        throw AuthenticationError("No valid token and cannot refresh");
    }

    // Perform refresh
    auto result = refresh_fn_(refresh_token_);
    secure_clear(access_token_);
    access_token_ = result.access_token;
    if (!result.refresh_token.empty()) {
        secure_clear(refresh_token_);
        refresh_token_ = result.refresh_token;
    }

    return access_token_;
}

std::string TokenManager::force_refresh() {
    std::lock_guard<std::mutex> lock(refresh_mutex_);

    if (refresh_token_.empty() || !refresh_fn_) {
        throw AuthenticationError("No valid token and cannot refresh");
    }

    // Perform refresh unconditionally (ignore expiry check)
    auto result = refresh_fn_(refresh_token_);
    secure_clear(access_token_);
    access_token_ = result.access_token;
    if (!result.refresh_token.empty()) {
        secure_clear(refresh_token_);
        refresh_token_ = result.refresh_token;
    }

    return access_token_;
}

void TokenManager::set_refresh_function(std::function<RefreshResult(const std::string&)> fn) {
    std::lock_guard<std::mutex> lock(refresh_mutex_);
    refresh_fn_ = std::move(fn);
}

void TokenManager::clear() {
    std::lock_guard<std::mutex> lock(refresh_mutex_);
    secure_clear(access_token_);
    secure_clear(refresh_token_);
    refresh_fn_ = nullptr;
}

} // namespace dominode
