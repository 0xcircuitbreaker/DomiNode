use dominusnode::wallet_auth;
use dominusnode::x402;

// Test that types can be deserialized from JSON
#[test]
fn test_x402_info_deserialize() {
    let json = r#"{
        "supported": true,
        "enabled": true,
        "protocol": "x402",
        "version": "1.0",
        "facilitators": [
            {"address": "0xabc", "chain": "base", "network": "mainnet"}
        ],
        "pricing": {"perRequestCents": 1, "perGbCents": 300, "currency": "USDC"},
        "currencies": ["USDC", "USDT"],
        "walletType": "evm",
        "agenticWallets": true
    }"#;

    let info: x402::X402Info = serde_json::from_str(json).unwrap();
    assert!(info.supported);
    assert!(info.enabled);
    assert_eq!(info.protocol, "x402");
    assert_eq!(info.version, "1.0");
    assert_eq!(info.facilitators.len(), 1);
    assert_eq!(info.facilitators[0].address, "0xabc");
    assert_eq!(info.pricing.per_request_cents, 1);
    assert_eq!(info.pricing.per_gb_cents, 300);
    assert_eq!(info.pricing.currency, "USDC");
    assert_eq!(info.currencies.len(), 2);
    assert_eq!(info.wallet_type, "evm");
    assert!(info.agentic_wallets);
}

#[test]
fn test_wallet_challenge_deserialize() {
    let json = r#"{
        "challenge": "Sign this message: abc123",
        "expiresAt": "2026-03-01T00:00:00Z"
    }"#;

    let ch: wallet_auth::WalletChallenge = serde_json::from_str(json).unwrap();
    assert_eq!(ch.challenge, "Sign this message: abc123");
    assert_eq!(ch.expires_at, "2026-03-01T00:00:00Z");
}

#[test]
fn test_wallet_verify_result_deserialize() {
    let json = r#"{
        "token": "jwt-access",
        "refreshToken": "jwt-refresh",
        "user": {
            "id": "u1",
            "email": "wallet@example.com",
            "is_admin": false
        }
    }"#;

    let result: wallet_auth::WalletVerifyResult = serde_json::from_str(json).unwrap();
    assert_eq!(result.token, "jwt-access");
    assert_eq!(result.refresh_token, "jwt-refresh");
    assert_eq!(result.user.id, "u1");
    assert_eq!(result.user.email, "wallet@example.com");
}

#[test]
fn test_wallet_verify_result_debug_redacts_tokens() {
    let json = r#"{
        "token": "secret-jwt",
        "refreshToken": "secret-refresh",
        "user": {"id": "u1", "email": "test@example.com", "is_admin": false}
    }"#;

    let result: wallet_auth::WalletVerifyResult = serde_json::from_str(json).unwrap();
    let debug_str = format!("{:?}", result);
    assert!(!debug_str.contains("secret-jwt"));
    assert!(!debug_str.contains("secret-refresh"));
    assert!(debug_str.contains("[REDACTED]"));
}

#[test]
fn test_wallet_link_result_deserialize() {
    let json = r#"{
        "success": true,
        "walletAddress": "0x1234567890abcdef1234567890abcdef12345678"
    }"#;

    let result: wallet_auth::WalletLinkResult = serde_json::from_str(json).unwrap();
    assert!(result.success);
    assert_eq!(result.wallet_address, "0x1234567890abcdef1234567890abcdef12345678");
}
