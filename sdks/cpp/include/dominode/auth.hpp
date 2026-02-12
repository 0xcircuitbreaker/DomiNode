#pragma once

#include "dominode/types.hpp"

namespace dominode {

class HttpClient;

/// Authentication resource - register, login, MFA, token management.
class AuthResource {
public:
    explicit AuthResource(HttpClient& http);

    /// Register a new account.
    RegisterResult register_account(const std::string& email, const std::string& password);

    /// Login with email and password.
    LoginResult login(const std::string& email, const std::string& password);

    /// Verify MFA code after login.
    MfaVerifyResult verify_mfa(const std::string& code,
                               const std::string& mfa_challenge_token = "",
                               bool is_backup_code = false);

    /// Refresh an access token using a refresh token.
    TokenPair refresh(const std::string& refresh_token);

    /// Logout (revoke all refresh tokens).
    void logout();

    /// Get the current authenticated user.
    User me();

    /// Change password.
    void change_password(const std::string& current_password, const std::string& new_password);

    /// Verify an API key and get tokens.
    VerifyKeyResult verify_key(const std::string& api_key);

    /// Begin MFA setup (returns secret + QR URI + backup codes).
    MfaSetup mfa_setup();

    /// Enable MFA with a TOTP code.
    bool mfa_enable(const std::string& code);

    /// Disable MFA.
    bool mfa_disable(const std::string& password, const std::string& code);

    /// Get MFA status.
    MfaStatus mfa_status();

private:
    HttpClient& http_;
};

} // namespace dominode
