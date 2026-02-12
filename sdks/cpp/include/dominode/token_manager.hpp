#pragma once

#include <functional>
#include <mutex>
#include <string>

namespace dominode {

struct RefreshResult {
    std::string access_token;
    std::string refresh_token;  // may be empty if not rotated
};

/// Thread-safe token manager that stores JWT access and refresh tokens in memory.
/// Tokens are securely zeroed on destruction via explicit_bzero.
class TokenManager {
public:
    TokenManager() = default;
    ~TokenManager();

    TokenManager(const TokenManager&) = delete;
    TokenManager& operator=(const TokenManager&) = delete;

    /// Store access (and optionally refresh) tokens.
    void set_tokens(const std::string& access, const std::string& refresh = "");

    /// Get a valid (non-expired) access token, refreshing if needed.
    /// Throws AuthenticationError if no valid token and cannot refresh.
    std::string get_valid_token();

    /// Force a token refresh regardless of expiry state.
    /// Used after a 401 response to avoid re-using a rejected token.
    /// Throws AuthenticationError if no refresh token or refresh function is set.
    std::string force_refresh();

    /// Check whether a JWT is expired (within the refresh buffer window).
    bool is_expired(const std::string& token) const;

    /// Set the function to call when the access token needs refreshing.
    void set_refresh_function(std::function<RefreshResult(const std::string& refresh_token)> fn);

    /// Check if an access token is currently stored.
    bool has_access_token() const;

    /// Check if a refresh token is currently stored.
    bool has_refresh_token() const;

    /// Securely clear all stored tokens.
    void clear();

private:
    /// Securely zero a string's memory.
    static void secure_clear(std::string& s);

    std::string access_token_;
    std::string refresh_token_;
    mutable std::mutex refresh_mutex_;
    std::function<RefreshResult(const std::string&)> refresh_fn_;
};

} // namespace dominode
