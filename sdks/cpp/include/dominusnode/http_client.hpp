#pragma once

#include <nlohmann/json.hpp>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <ostream>
#include <string>
#include <utility>
#include <vector>

namespace dominusnode {

// ─── Token manager ──────────────────────────────────────────────────────────

struct RefreshResult {
    std::string access_token;
    std::optional<std::string> refresh_token;
};
using RefreshFn = std::function<RefreshResult(const std::string& refresh_token)>;

/// Holds the JWT access/refresh pair. clear() drops (zeroizes) tokens but keeps the refresh callback.
class TokenManager {
public:
    void set_tokens(const std::string& access, const std::optional<std::string>& refresh = std::nullopt);
    void set_refresh_function(RefreshFn fn);
    bool has_refresh_function() const;
    std::optional<std::string> access_token() const;
    std::optional<std::string> refresh_token() const;
    bool has_tokens() const;
    /// True when the JWT has no parseable exp or expires within 60 s.
    static bool is_expired(const std::string& token);
    std::string get_valid_token();
    /// Refresh regardless of expiry. Concurrent callers share one refresh.
    /// Failure clears both tokens and rethrows.
    std::string force_refresh();
    void clear();

private:
    mutable std::mutex mu_;
    std::mutex refresh_mu_;
    std::optional<std::string> access_;
    std::optional<std::string> refresh_;
    RefreshFn refresh_fn_;
    unsigned long long generation_ = 0;
};

inline std::ostream& operator<<(std::ostream& os, const TokenManager&) { return os << "TokenManager([REDACTED])"; }
inline void to_json(nlohmann::json& j, const TokenManager&) { j = "[REDACTED]"; }

// ─── Transport ──────────────────────────────────────────────────────────────

struct HttpRequest {
    std::string method;
    std::string url;
    std::vector<std::pair<std::string, std::string>> headers;
    std::optional<std::string> body;
    long timeout_ms = 30000;
};

struct HttpResponse {
    long status = 0;
    /// Lowercased header names.
    std::map<std::string, std::string> headers;
    std::string body;
};

/// Pluggable transport (tests inject a mock). Must not follow redirects.
/// Throw NetworkError on transport failure.
using Transport = std::function<HttpResponse(const HttpRequest&)>;

/// libcurl transport: FOLLOWLOCATION 0, TLS verification set explicitly after curl_easy_reset,
/// TLS >= 1.2, http/https only, 10 MB cap (Content-Length and write callback), 429 body not read.
Transport make_curl_transport();

enum class AuthMode { None, Jwt, Agent };

/// min(retry_after, 10 s) +/-10 % jitter, floor 100 ms.
long retry_delay_ms(long retry_after_seconds);
/// Recursively delete __proto__/constructor/prototype keys (depth limit 50).
void strip_dangerous_keys(nlohmann::json& j, int depth = 0);

class HttpClient {
public:
    HttpClient(const std::string& base_url, TokenManager& tokens,
               std::function<std::string()> api_key, Transport transport = nullptr);

    nlohmann::json request(const std::string& method, const std::string& path,
                           const std::optional<nlohmann::json>& body, AuthMode auth,
                           const std::vector<std::pair<std::string, std::string>>& headers = {});
    /// Body text (unparsed) after status checks.
    std::string request_raw(const std::string& method, const std::string& path,
                            const std::optional<nlohmann::json>& body, AuthMode auth,
                            const std::vector<std::pair<std::string, std::string>>& headers = {});

    nlohmann::json get(const std::string& path, AuthMode auth = AuthMode::Jwt);
    nlohmann::json post(const std::string& path, const nlohmann::json& body = nlohmann::json::object(),
                        AuthMode auth = AuthMode::Jwt,
                        const std::vector<std::pair<std::string, std::string>>& headers = {});
    nlohmann::json put(const std::string& path, const nlohmann::json& body, AuthMode auth = AuthMode::Jwt);
    nlohmann::json patch(const std::string& path, const nlohmann::json& body, AuthMode auth = AuthMode::Jwt);
    nlohmann::json del(const std::string& path, AuthMode auth = AuthMode::Jwt);

    const std::string& base_url() const { return base_url_; }
    /// Test hook: replace the sleep used between 429 retries.
    void set_sleeper(std::function<void(long ms)> s) { sleeper_ = std::move(s); }

private:
    std::string bearer(AuthMode mode, bool force_refresh);
    HttpResponse send(const std::string& method, const std::string& path,
                      const std::optional<nlohmann::json>& body, const std::string& bearer,
                      const std::vector<std::pair<std::string, std::string>>& headers);

    std::string base_url_;
    TokenManager& tokens_;
    std::function<std::string()> api_key_;
    Transport transport_;
    std::function<void(long)> sleeper_;
};

inline std::ostream& operator<<(std::ostream& os, const HttpClient& c) { return os << "HttpClient(" << c.base_url() << ")"; }

} // namespace dominusnode
