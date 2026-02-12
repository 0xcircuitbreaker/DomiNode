#include "dominode/auth.hpp"
#include "dominode/http_client.hpp"

namespace dominode {

AuthResource::AuthResource(HttpClient& http) : http_(http) {}

RegisterResult AuthResource::register_account(const std::string& email, const std::string& password) {
    nlohmann::json body = {{"email", email}, {"password", password}};
    auto resp = http_.post("/api/auth/register", body, false);
    return resp.get<RegisterResult>();
}

LoginResult AuthResource::login(const std::string& email, const std::string& password) {
    nlohmann::json body = {{"email", email}, {"password", password}};
    auto resp = http_.post("/api/auth/login", body, false);
    return resp.get<LoginResult>();
}

MfaVerifyResult AuthResource::verify_mfa(const std::string& code,
                                          const std::string& mfa_challenge_token,
                                          bool is_backup_code) {
    nlohmann::json body = {{"code", code}};
    if (!mfa_challenge_token.empty()) {
        body["mfaChallengeToken"] = mfa_challenge_token;
    }
    if (is_backup_code) {
        body["isBackupCode"] = true;
    }
    auto resp = http_.post("/api/auth/mfa/verify", body, false);
    return resp.get<MfaVerifyResult>();
}

TokenPair AuthResource::refresh(const std::string& refresh_token) {
    nlohmann::json body = {{"refreshToken", refresh_token}};
    auto resp = http_.post("/api/auth/refresh", body, false);
    return resp.get<TokenPair>();
}

void AuthResource::logout() {
    http_.post("/api/auth/logout", nlohmann::json::object());
}

User AuthResource::me() {
    auto resp = http_.get("/api/auth/me");
    return resp.at("user").get<User>();
}

void AuthResource::change_password(const std::string& current_password, const std::string& new_password) {
    nlohmann::json body = {{"currentPassword", current_password}, {"newPassword", new_password}};
    http_.post("/api/auth/change-password", body);
}

VerifyKeyResult AuthResource::verify_key(const std::string& api_key) {
    nlohmann::json body = {{"apiKey", api_key}};
    auto resp = http_.post("/api/auth/verify-key", body, false);
    return resp.get<VerifyKeyResult>();
}

MfaSetup AuthResource::mfa_setup() {
    auto resp = http_.post("/api/auth/mfa/setup", nlohmann::json::object());
    return resp.get<MfaSetup>();
}

bool AuthResource::mfa_enable(const std::string& code) {
    nlohmann::json body = {{"code", code}};
    auto resp = http_.post("/api/auth/mfa/enable", body);
    return resp.value("enabled", false);
}

bool AuthResource::mfa_disable(const std::string& password, const std::string& code) {
    nlohmann::json body = {{"password", password}, {"code", code}};
    auto resp = http_.post("/api/auth/mfa/disable", body);
    return !resp.value("enabled", true);
}

MfaStatus AuthResource::mfa_status() {
    auto resp = http_.get("/api/auth/mfa/status");
    return resp.get<MfaStatus>();
}

} // namespace dominode
