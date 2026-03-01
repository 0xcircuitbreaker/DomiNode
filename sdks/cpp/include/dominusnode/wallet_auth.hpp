#pragma once

#include <nlohmann/json.hpp>
#include <ostream>
#include <string>

namespace dominusnode {

class HttpClient;
class TokenManager;

// ─── Types ──────────────────────────────────────────────────────────────

struct WalletChallenge {
    std::string challenge;
    std::string expires_at;
};

inline void from_json(const nlohmann::json& j, WalletChallenge& c) {
    j.at("challenge").get_to(c.challenge);
    c.expires_at = j.value("expiresAt", "");
}

/// User type forward-declared from auth.hpp; duplicated here
/// to avoid circular includes. Only used for wallet verify result.
struct WalletAuthUser {
    std::string id;
    std::string email;
    bool is_admin = false;
    std::string created_at;
};

inline void from_json(const nlohmann::json& j, WalletAuthUser& u) {
    j.at("id").get_to(u.id);
    j.at("email").get_to(u.email);
    u.is_admin = j.value("is_admin", false);
    u.created_at = j.value("created_at", "");
}

struct WalletVerifyResult {
    std::string token;
    std::string refresh_token;
    WalletAuthUser user;
    /// True when MFA is required before authentication is complete.
    bool mfa_required = false;
    std::string mfa_challenge_token;
};

inline void from_json(const nlohmann::json& j, WalletVerifyResult& r) {
    r.token = j.value("token", "");
    r.refresh_token = j.value("refreshToken", "");
    if (j.contains("user") && j["user"].is_object()) {
        j.at("user").get_to(r.user);
    }
    r.mfa_required = j.value("mfaRequired", false);
    r.mfa_challenge_token = j.value("mfaChallengeToken", "");
}

// Redact tokens in stream output to prevent accidental logging
inline std::ostream& operator<<(std::ostream& os, const WalletVerifyResult& r) {
    os << "WalletVerifyResult{token=[REDACTED], refresh_token=[REDACTED], mfa_required="
       << (r.mfa_required ? "true" : "false") << ", user.id=" << r.user.id << "}";
    return os;
}

struct WalletLinkResult {
    bool success = false;
    std::string wallet_address;
};

inline void from_json(const nlohmann::json& j, WalletLinkResult& r) {
    r.success = j.value("success", false);
    r.wallet_address = j.value("walletAddress", "");
}

// ─── Resource ───────────────────────────────────────────────────────────

class WalletAuthResource {
public:
    WalletAuthResource(HttpClient& http, TokenManager& token_manager);

    /// Request a signature challenge for the given Ethereum address (no auth required).
    WalletChallenge challenge(const std::string& address);

    /// Submit signed challenge to create account or login (no auth required).
    /// Tokens are automatically stored for subsequent authenticated requests.
    /// The challenge_str parameter is optional (server looks up internally).
    WalletVerifyResult verify(const std::string& address,
                              const std::string& signature,
                              const std::string& challenge_str = "");

    /// Link an Ethereum wallet to the current account (requires auth).
    /// The challenge_str parameter is optional (server looks up internally).
    WalletLinkResult link(const std::string& address,
                          const std::string& signature,
                          const std::string& challenge_str = "");

private:
    HttpClient& http_;
    TokenManager& token_manager_;
};

} // namespace dominusnode
