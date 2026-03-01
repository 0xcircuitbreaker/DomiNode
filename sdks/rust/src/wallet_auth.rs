use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::errors::{DominusNodeError, Result};
use crate::http_client::HttpClient;
use crate::token_manager::TokenManager;
use crate::types::User;

/// Response from the wallet challenge endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct WalletChallenge {
    pub challenge: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

/// Response from the wallet verify endpoint.
///
/// When `mfa_required` is `true`, the caller must complete MFA verification
/// before the client is fully authenticated. Use the `mfa_challenge_token`
/// with `auth.verify_mfa()` to complete the flow.
#[derive(Clone, Deserialize)]
pub struct WalletVerifyResult {
    #[serde(default)]
    pub token: String,
    #[serde(rename = "refreshToken", default)]
    pub refresh_token: String,
    #[serde(default)]
    pub user: User,
    /// True when MFA is required before authentication is complete.
    #[serde(rename = "mfaRequired", default)]
    pub mfa_required: bool,
    #[serde(rename = "mfaChallengeToken", default)]
    pub mfa_challenge_token: Option<String>,
}

// Custom Debug to redact tokens
impl std::fmt::Debug for WalletVerifyResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WalletVerifyResult")
            .field("token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .field("user", &self.user)
            .field("mfa_required", &self.mfa_required)
            .finish()
    }
}

/// Response from the wallet link endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct WalletLinkResult {
    pub success: bool,
    #[serde(rename = "walletAddress")]
    pub wallet_address: String,
}

// Request bodies

#[derive(Serialize)]
struct ChallengeBody<'a> {
    address: &'a str,
}

#[derive(Serialize)]
struct VerifyBody<'a> {
    address: &'a str,
    signature: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    challenge: Option<&'a str>,
}

/// Validate an Ethereum address (0x followed by 40 hex chars).
fn validate_address(address: &str) -> Result<()> {
    if address.is_empty() {
        return Err(DominusNodeError::Validation(
            "address is required".to_string(),
        ));
    }
    if address.len() != 42
        || !address.starts_with("0x")
        || !address[2..].chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(DominusNodeError::Validation(
            "address must be a valid Ethereum address (0x followed by 40 hex characters)"
                .to_string(),
        ));
    }
    Ok(())
}

/// Validate EIP-191 signature format (0x + 130 hex chars = 65 bytes).
fn validate_signature(signature: &str) -> Result<()> {
    if signature.is_empty() {
        return Err(DominusNodeError::Validation(
            "signature is required and must be a non-empty string".to_string(),
        ));
    }
    // Max length check
    if signature.len() > 200 {
        return Err(DominusNodeError::Validation(
            "signature must not exceed 200 characters".to_string(),
        ));
    }
    // EIP-191 format validation
    if signature.len() != 132
        || !signature.starts_with("0x")
        || !signature[2..].chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(DominusNodeError::Validation(
            "signature must be a valid EIP-191 signature (0x followed by 130 hex characters)"
                .to_string(),
        ));
    }
    Ok(())
}

/// Wallet-based authentication resource using EIP-191 signed messages.
///
/// Allows Ethereum wallet holders to authenticate by signing a server-issued
/// challenge message. Supports account creation, login, and linking a wallet
/// to an existing account.
pub struct WalletAuthResource {
    http: Arc<HttpClient>,
    token_manager: Arc<TokenManager>,
}

impl WalletAuthResource {
    pub(crate) fn new(http: Arc<HttpClient>, token_manager: Arc<TokenManager>) -> Self {
        Self { http, token_manager }
    }

    /// Request a signature challenge for the given Ethereum address.
    ///
    /// The returned challenge must be signed with the wallet's private key
    /// and submitted via [`WalletAuthResource::verify`] to complete authentication.
    ///
    /// This endpoint does not require authentication.
    pub async fn challenge(&self, address: &str) -> Result<WalletChallenge> {
        validate_address(address)?;
        self.http
            .post(
                "/api/auth/wallet/challenge",
                Some(&ChallengeBody { address }),
                false,
            )
            .await
    }

    /// Submit a signed challenge to create an account or log in.
    ///
    /// If the address is not yet associated with an account, a new one is created.
    /// Returns JWT tokens and user information on success.
    /// Tokens are automatically stored for subsequent authenticated requests.
    ///
    /// This endpoint does not require authentication.
    /// The `challenge` parameter is optional (server looks up internally by address).
    pub async fn verify(
        &self,
        address: &str,
        signature: &str,
        challenge: Option<&str>,
    ) -> Result<WalletVerifyResult> {
        validate_address(address)?;
        validate_signature(signature)?;
        let challenge_val = challenge.filter(|c| !c.is_empty());
        let result: WalletVerifyResult = self
            .http
            .post(
                "/api/auth/wallet/verify",
                Some(&VerifyBody {
                    address,
                    signature,
                    challenge: challenge_val,
                }),
                false,
            )
            .await?;
        // Detect MFA-required response — don't store tokens, surface to caller
        if result.mfa_required {
            return Ok(result);
        }
        // Store tokens after verify (matching Python/Go/Java)
        if !result.token.is_empty() {
            self.token_manager
                .set_tokens(&result.token, Some(&result.refresh_token))
                .await;
        }
        Ok(result)
    }

    /// Link an Ethereum wallet to the currently authenticated account.
    ///
    /// Requires JWT authentication.
    /// The `challenge` parameter is optional (server looks up internally by address).
    pub async fn link(
        &self,
        address: &str,
        signature: &str,
        challenge: Option<&str>,
    ) -> Result<WalletLinkResult> {
        validate_address(address)?;
        validate_signature(signature)?;
        let challenge_val = challenge.filter(|c| !c.is_empty());
        self.http
            .post(
                "/api/auth/wallet/link",
                Some(&VerifyBody {
                    address,
                    signature,
                    challenge: challenge_val,
                }),
                true,
            )
            .await
    }
}
