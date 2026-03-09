use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};

use crate::errors::Result;
use crate::http_client::HttpClient;
use crate::types::{LoginResponse, LoginResult, MfaSetup, MfaStatus, User};

const POW_MAX_NONCE: u64 = 100_000_000;

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct RegisterBody<'a> {
    email: &'a str,
    password: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pow: Option<PowSolution>,
}

#[derive(Serialize)]
struct PowSolution {
    #[serde(rename = "challengeId")]
    challenge_id: String,
    nonce: u64,
}

#[derive(Deserialize)]
struct PowChallenge {
    #[serde(rename = "challengeId")]
    challenge_id: String,
    prefix: String,
    difficulty: u32,
}

#[derive(Serialize)]
struct LoginBody<'a> {
    email: &'a str,
    password: &'a str,
}

#[derive(Serialize)]
struct MfaVerifyBody<'a> {
    code: &'a str,
    #[serde(rename = "mfaChallengeToken", skip_serializing_if = "Option::is_none")]
    mfa_challenge_token: Option<&'a str>,
    #[serde(rename = "isBackupCode", skip_serializing_if = "Option::is_none")]
    is_backup_code: Option<bool>,
}

#[derive(Serialize)]
struct RefreshBody<'a> {
    #[serde(rename = "refreshToken")]
    refresh_token: &'a str,
}

#[derive(Serialize)]
struct ChangePasswordBody<'a> {
    #[serde(rename = "currentPassword")]
    current_password: &'a str,
    #[serde(rename = "newPassword")]
    new_password: &'a str,
}

#[derive(Serialize)]
struct VerifyKeyBody<'a> {
    #[serde(rename = "apiKey")]
    api_key: &'a str,
}

#[derive(Serialize)]
struct MfaCodeBody<'a> {
    code: &'a str,
}

#[derive(Serialize)]
struct MfaDisableBody<'a> {
    password: &'a str,
    code: &'a str,
}

// ---------------------------------------------------------------------------
// Response types specific to auth
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Deserialize)]
pub struct RegisterResponse {
    pub user: User,
    pub token: Option<String>,
    #[serde(rename = "refreshToken")]
    pub refresh_token: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct MfaVerifyResponse {
    pub user: User,
    pub token: String,
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct RefreshResponse {
    pub token: String,
    #[serde(rename = "refreshToken")]
    pub refresh_token: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct MeResponse {
    pub user: User,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct VerifyKeyResponse {
    pub valid: bool,
    pub token: String,
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
    #[serde(rename = "userId")]
    pub user_id: String,
    pub email: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct MfaEnableResponse {
    pub enabled: bool,
}

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

/// Authentication resource -- register, login, MFA, key verification, etc.
pub struct AuthResource {
    http: Arc<HttpClient>,
}

impl AuthResource {
    pub(crate) fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// Solve a Proof-of-Work challenge for bot-free registration.
    async fn solve_pow(&self) -> Option<PowSolution> {
        let challenge: PowChallenge = match self
            .http
            .post("/api/auth/pow/challenge", Some(&serde_json::json!({})), false)
            .await
        {
            Ok(c) => c,
            Err(_) => return None,
        };

        for nonce in 0..POW_MAX_NONCE {
            let input = format!("{}{}", challenge.prefix, nonce);
            let hash = Sha256::digest(input.as_bytes());
            if count_leading_zero_bits(&hash) >= challenge.difficulty {
                return Some(PowSolution {
                    challenge_id: challenge.challenge_id,
                    nonce,
                });
            }
        }
        None
    }

    /// Register a new user account.
    pub async fn register(&self, email: &str, password: &str) -> Result<RegisterResponse> {
        let pow = self.solve_pow().await;
        self.http
            .post(
                "/api/auth/register",
                Some(&RegisterBody { email, password, pow }),
                false,
            )
            .await
    }

    /// Log in with email and password.
    ///
    /// If the account has MFA enabled, the returned [`LoginResponse`] will have
    /// `mfa_required = true` and no tokens. Use [`AuthResource::verify_mfa`] to
    /// complete authentication.
    pub async fn login(&self, email: &str, password: &str) -> Result<LoginResponse> {
        self.http
            .post("/api/auth/login", Some(&LoginBody { email, password }), false)
            .await
    }

    /// Complete MFA verification after login.
    pub async fn verify_mfa(
        &self,
        code: &str,
        challenge_token: Option<&str>,
        is_backup: bool,
    ) -> Result<MfaVerifyResponse> {
        let body = MfaVerifyBody {
            code,
            mfa_challenge_token: challenge_token,
            is_backup_code: if is_backup { Some(true) } else { None },
        };
        self.http
            .post("/api/auth/mfa/verify", Some(&body), false)
            .await
    }

    /// Exchange a refresh token for a new access / refresh token pair.
    pub async fn refresh(&self, refresh_token: &str) -> Result<RefreshResponse> {
        self.http
            .post(
                "/api/auth/refresh",
                Some(&RefreshBody { refresh_token }),
                false,
            )
            .await
    }

    /// Log out, revoking all refresh tokens for the current user.
    pub async fn logout(&self) -> Result<()> {
        let _: serde_json::Value = self
            .http
            .post("/api/auth/logout", Some(&serde_json::json!({})), true)
            .await?;
        Ok(())
    }

    /// Get the currently authenticated user.
    pub async fn me(&self) -> Result<MeResponse> {
        self.http.get("/api/auth/me", true).await
    }

    /// Change the current user's password.
    pub async fn change_password(
        &self,
        current_password: &str,
        new_password: &str,
    ) -> Result<()> {
        let _: serde_json::Value = self
            .http
            .post(
                "/api/auth/change-password",
                Some(&ChangePasswordBody {
                    current_password,
                    new_password,
                }),
                true,
            )
            .await?;
        Ok(())
    }

    /// Verify an API key and receive JWT tokens.
    pub async fn verify_key(&self, api_key: &str) -> Result<VerifyKeyResponse> {
        self.http
            .post("/api/auth/verify-key", Some(&VerifyKeyBody { api_key }), false)
            .await
    }

    /// Initiate MFA (TOTP) setup. Returns the secret, otpauth URI, and backup codes.
    pub async fn mfa_setup(&self) -> Result<MfaSetup> {
        self.http
            .post("/api/auth/mfa/setup", Some(&serde_json::json!({})), true)
            .await
    }

    /// Confirm MFA setup with a TOTP code.
    pub async fn mfa_enable(&self, code: &str) -> Result<MfaEnableResponse> {
        self.http
            .post("/api/auth/mfa/enable", Some(&MfaCodeBody { code }), true)
            .await
    }

    /// Disable MFA (requires password + current TOTP code).
    pub async fn mfa_disable(&self, password: &str, code: &str) -> Result<MfaEnableResponse> {
        self.http
            .post(
                "/api/auth/mfa/disable",
                Some(&MfaDisableBody { password, code }),
                true,
            )
            .await
    }

    /// Get the current MFA status for the authenticated user.
    pub async fn mfa_status(&self) -> Result<MfaStatus> {
        self.http.get("/api/auth/mfa/status", true).await
    }
}

/// Count the number of leading zero bits in a hash digest.
fn count_leading_zero_bits(hash: &[u8]) -> u32 {
    let mut count: u32 = 0;
    for &byte in hash {
        if byte == 0 {
            count += 8;
        } else {
            let mut mask: u8 = 0x80;
            while mask != 0 && (byte & mask) == 0 {
                count += 1;
                mask >>= 1;
            }
            break;
        }
    }
    count
}
