//! One test per resource method: HTTP method, path (incl. encoding), query, body, auth mode.
mod common;
use common::*;
use dominusnode::types::*;
use serde_json::{json, Value};

const J: &str = "jwt";
const A: &str = "agent";
const N: &str = "none";

fn check(m: &Mock, method: &str, path: &str, body: Option<Value>, auth: &str) {
    let c = m.last();
    assert_eq!(c.method, method, "method for {path}");
    assert_eq!(c.path, path);
    assert_eq!(c.body, body, "body for {path}");
    let a = c.auth();
    match auth {
        "none" => assert!(a.is_none(), "no auth on {path}"),
        "jwt" => assert!(a.unwrap().starts_with("Bearer eyJ"), "jwt on {path}"),
        "agent" => assert_eq!(a.unwrap(), format!("Bearer {API_KEY}"), "agent key on {path}"),
        _ => unreachable!(),
    }
    assert_eq!(c.header("accept").as_deref(), Some("application/json"));
    assert!(c.header("user-agent").unwrap().starts_with("dominusnode-sdk-rust/4."));
    assert_eq!(c.header("content-type").is_some(), c.body.is_some());
}

macro_rules! case {
    ($name:ident, $reply:expr, |$c:ident| $call:expr, $method:expr, $path:expr, $body:expr, $auth:expr) => {
        #[tokio::test]
        async fn $name() {
            let (cl, m) = connected().await;
            m.push(r(200, $reply));
            let $c = &cl;
            $call.await.unwrap();
            check(&m, $method, $path, $body, $auth);
        }
    };
}

// ---- auth (4)
case!(auth_verify_key, json!({"valid": true}), |c| c.auth.verify_key(API_KEY), "POST", "/api/auth/verify-key", Some(json!({"apiKey": API_KEY})), N);
case!(auth_refresh, json!({"token": "t"}), |c| c.auth.refresh("rt"), "POST", "/api/auth/refresh", Some(json!({"refreshToken": "rt"})), N);
case!(auth_logout, json!({}), |c| c.auth.logout(), "POST", "/api/auth/logout", Some(json!({})), J);
case!(auth_me, json!({"user": {"id": "u", "email": "e", "custom": 1}}), |c| c.auth.me(), "GET", "/api/auth/me", None, J);

// ---- walletAuth (4)
case!(wallet_auth_challenge, json!({"message": "m"}), |c| c.wallet_auth.challenge(WALLET), "POST", "/api/auth/wallet/challenge", Some(json!({"address": WALLET})), N);
case!(wallet_auth_verify, json!({"token": "a", "refreshToken": "b"}), |c| c.wallet_auth.verify(WALLET, &sig()), "POST", "/api/auth/wallet/verify", Some(json!({"address": WALLET, "signature": sig()})), N);
case!(wallet_auth_link, json!({"success": true, "walletAddress": WALLET}), |c| c.wallet_auth.link(WALLET, &sig()), "POST", "/api/auth/wallet/link", Some(json!({"address": WALLET, "signature": sig()})), J);

#[tokio::test]
async fn wallet_auth_sign_in() {
    let m = Mock::default();
    let c = client(&m);
    let (s, signed) = signer_for(WALLET, sig());
    m.push(r(200, json!({"message": format!("Sign in as {}", WALLET.to_uppercase().replace("0X", "0x")), "nonce": "n"})));
    m.push(r(200, json!({"token": make_jwt(900), "refreshToken": make_jwt(9000)})));
    c.wallet_auth.sign_in(&s).await.unwrap();
    assert_eq!(signed.lock().unwrap().len(), 1);
    check(&m, "POST", "/api/auth/wallet/verify", Some(json!({"address": WALLET, "signature": sig()})), N);
    assert!(c.is_connected());
}

#[tokio::test]
async fn wallet_auth_verify_mfa_stores_nothing() {
    let m = Mock::default();
    let c = client(&m);
    m.push(r(200, json!({"mfaRequired": true, "mfaChallengeToken": "x", "token": "should-not-store"})));
    let v = c.wallet_auth.verify(WALLET, &sig()).await.unwrap();
    assert_eq!(v.mfa_required, Some(true));
    assert_eq!(v.mfa_challenge_token.as_deref(), Some("x"));
    assert!(v.token.is_none());
    assert!(!c.is_connected());
}

#[tokio::test]
async fn wallet_auth_sign_in_refuses_foreign_challenge() {
    let m = Mock::default();
    let c = client(&m);
    let (s, signed) = signer_for(WALLET, sig());
    m.push(r(200, json!({"message": format!("Sign in as {OTHER_WALLET}")})));
    let e = c.wallet_auth.sign_in(&s).await.unwrap_err();
    assert!(matches!(e, dominusnode::DominusNodeError::Protocol(_)));
    assert!(signed.lock().unwrap().is_empty());
}

// ---- keys (3)
#[tokio::test]
async fn keys_create() {
    let (c, m) = connected().await;
    m.push(r(200, json!({"id": "k", "prefix": "dn_live_", "label": "Default", "created_at": "t", "key": "dn_live_secretsecretsecret"})));
    let k = c.keys.create(None).await.unwrap();
    check(&m, "POST", "/api/keys", Some(json!({"label": "Default"})), J);
    assert_eq!(k.key.reveal(), "dn_live_secretsecretsecret");
    assert!(!format!("{k:?}").contains("secretsecret"));
}
case!(keys_list, json!({"keys": [{"id": "k", "prefix": "p", "label": "l", "created_at": "t", "revoked_at": null}]}), |c| c.keys.list(), "GET", "/api/keys", None, J);
case!(keys_revoke_encodes, json!({}), |c| c.keys.revoke("a/b c"), "DELETE", "/api/keys/a%2Fb%20c", None, J);

// ---- wallet (5)
case!(wallet_balance, json!({"balanceCents": 100}), |c| c.wallet.get_balance(), "GET", "/api/wallet", None, J);
case!(wallet_transactions, json!({"transactions": []}), |c| c.wallet.get_transactions(Some(10), Some(5)), "GET", "/api/wallet/transactions?limit=10&offset=5", None, J);
case!(wallet_transactions_no_query, json!({"transactions": []}), |c| c.wallet.get_transactions(None, None), "GET", "/api/wallet/transactions", None, J);
case!(wallet_forecast, json!({"trend": "up"}), |c| c.wallet.get_forecast(), "GET", "/api/wallet/forecast", None, J);
case!(wallet_topup_crypto, json!({"invoiceId": "i"}), |c| c.wallet.top_up_crypto(2550, "USDC"), "POST", "/api/wallet/topup/crypto", Some(json!({"amountUsd": 25.5, "currency": "usdc"})), J);
case!(wallet_crypto_status, json!({"status": "paid"}), |c| c.wallet.get_crypto_status(UUID), "GET", &format!("/api/wallet/crypto/status/{UUID}"), None, J);

// ---- agenticWallets (9)
case!(aw_create, json!({"id": "w"}), |c| c.agentic_wallets.create("bot", None, Some(500), Some(vec!["example.com".into()])), "POST", "/api/agent-wallet", Some(json!({"label": "bot", "spendingLimitCents": 10000, "dailyLimitCents": 500, "allowedDomains": ["example.com"]})), J);
case!(aw_list, json!({"wallets": []}), |c| c.agentic_wallets.list(), "GET", "/api/agent-wallet", None, J);
case!(aw_get, json!({"id": "w"}), |c| c.agentic_wallets.get("w/1"), "GET", "/api/agent-wallet/w%2F1", None, J);
case!(aw_fund, json!({"transaction": {"id": "t"}}), |c| c.agentic_wallets.fund("w", 250), "POST", "/api/agent-wallet/w/fund", Some(json!({"amountCents": 250})), J);
case!(aw_policy, json!({"id": "w"}), |c| c.agentic_wallets.update_wallet_policy("w", &AgenticWalletPolicy { daily_limit_cents: Some(None), allowed_domains: Some(Some(vec!["a.com".into()])) }), "PATCH", "/api/agent-wallet/w/policy", Some(json!({"dailyLimitCents": null, "allowedDomains": ["a.com"]})), J);
case!(aw_transactions, json!({"transactions": []}), |c| c.agentic_wallets.transactions("w", Some(3), None), "GET", "/api/agent-wallet/w/transactions?limit=3", None, J);
case!(aw_freeze, json!({"id": "w"}), |c| c.agentic_wallets.freeze("w"), "POST", "/api/agent-wallet/w/freeze", Some(json!({})), J);
case!(aw_unfreeze, json!({"id": "w"}), |c| c.agentic_wallets.unfreeze("w"), "POST", "/api/agent-wallet/w/unfreeze", Some(json!({})), J);
case!(aw_delete, json!({"deleted": true, "refundedCents": 5}), |c| c.agentic_wallets.delete("w"), "DELETE", "/api/agent-wallet/w", None, J);

// ---- teams (18)
case!(teams_create, json!({"id": "t"}), |c| c.teams.create("A", Some(5)), "POST", "/api/teams", Some(json!({"name": "A", "maxMembers": 5})), J);
case!(teams_list, json!({"teams": []}), |c| c.teams.list(), "GET", "/api/teams", None, J);
case!(teams_get, json!({"id": "t"}), |c| c.teams.get("t 1"), "GET", "/api/teams/t%201", None, J);
case!(teams_update, json!({"id": "t"}), |c| c.teams.update("t", &TeamUpdate { name: Some("B".into()), max_members: None }), "PATCH", "/api/teams/t", Some(json!({"name": "B"})), J);
case!(teams_delete, json!({"refundedCents": 0}), |c| c.teams.delete("t"), "DELETE", "/api/teams/t", None, J);
case!(teams_fund, json!({"transaction": {}}), |c| c.teams.fund_wallet("t", 100), "POST", "/api/teams/t/wallet/fund", Some(json!({"amountCents": 100})), J);
case!(teams_transactions, json!({"transactions": []}), |c| c.teams.get_transactions("t", Some(1), Some(2)), "GET", "/api/teams/t/wallet/transactions?limit=1&offset=2", None, J);
case!(teams_list_members, json!({"members": []}), |c| c.teams.list_members("t"), "GET", "/api/teams/t/members", None, J);
case!(teams_add_member, json!({"id": "m"}), |c| c.teams.add_member("t", "a@b.c", Some("admin")), "POST", "/api/teams/t/members", Some(json!({"email": "a@b.c", "role": "admin"})), J);
case!(teams_update_role, json!({"id": "m"}), |c| c.teams.update_member_role("t", "u/1", "member"), "PATCH", "/api/teams/t/members/u%2F1", Some(json!({"role": "member"})), J);
case!(teams_remove_member, json!({}), |c| c.teams.remove_member("t", "u"), "DELETE", "/api/teams/t/members/u", None, J);
case!(teams_create_invite, json!({"id": "i"}), |c| c.teams.create_invite("t", "a@b.c", None), "POST", "/api/teams/t/invites", Some(json!({"email": "a@b.c"})), J);
case!(teams_list_invites, json!({"invites": []}), |c| c.teams.list_invites("t"), "GET", "/api/teams/t/invites", None, J);
case!(teams_cancel_invite, json!({}), |c| c.teams.cancel_invite("t", "i?x"), "DELETE", "/api/teams/t/invites/i%3Fx", None, J);
case!(teams_accept_invite, json!({"id": "m"}), |c| c.teams.accept_invite("tok&1"), "POST", "/api/teams/invites/tok%261/accept", Some(json!({})), J);
case!(teams_list_keys, json!({"keys": []}), |c| c.teams.list_keys("t"), "GET", "/api/teams/t/keys", None, J);
case!(teams_revoke_key, json!({}), |c| c.teams.revoke_key("t", "k"), "DELETE", "/api/teams/t/keys/k", None, J);

#[tokio::test]
async fn teams_create_key_wraps_secret() {
    let (c, m) = connected().await;
    m.push(r(200, json!({"id": "k", "prefix": "dn_live_", "label": "ci", "key": "dn_live_teamkeyteamkey"})));
    let k = c.teams.create_key("t", "ci").await.unwrap();
    check(&m, "POST", "/api/teams/t/keys", Some(json!({"label": "ci"})), J);
    assert_eq!(k.key.reveal(), "dn_live_teamkeyteamkey");
    assert_eq!(serde_json::to_value(&k).unwrap()["key"], "[REDACTED]");
}

// ---- usage (4)
case!(usage_get, json!({"records": []}), |c| c.usage.get(Some("2026-01-01T00:00:00Z"), Some("2026-02-01"), Some(10), Some(0)), "GET", "/api/usage?since=2026-01-01T00%3A00%3A00Z&until=2026-02-01&limit=10&offset=0", None, J);
case!(usage_daily, json!({"days": []}), |c| c.usage.get_daily(Some("2026-01-01"), None), "GET", "/api/usage/daily?since=2026-01-01", None, J);
case!(usage_top_hosts, json!({"hosts": []}), |c| c.usage.get_top_hosts(None, None, Some(5)), "GET", "/api/usage/top-hosts?limit=5", None, J);

#[tokio::test]
async fn usage_export_csv_raw() {
    let (c, m) = connected().await;
    m.push(raw(200, "a,b\n1,2\n"));
    let csv = c.usage.export_csv(None, Some("2026-02-01")).await.unwrap();
    assert_eq!(csv, "a,b\n1,2\n");
    check(&m, "GET", "/api/usage/export?until=2026-02-01", None, J);
}

// ---- sessions (2)
#[tokio::test]
async fn sessions_get_active_drops_unknown_fields() {
    let (c, m) = connected().await;
    m.push(r(200, json!({"sessions": [{"id": "s", "startedAt": "t", "status": "active", "proxyIp": "1.2.3.4", "nodeIp": "5.6.7.8"}]})));
    let s = c.sessions.get_active().await.unwrap();
    check(&m, "GET", "/api/sessions/active", None, J);
    assert_eq!(s.sessions[0].id, "s");
    let v = serde_json::to_string(&s).unwrap();
    assert!(!v.contains("1.2.3.4") && !v.contains("proxyIp") && !v.contains("5.6.7.8"));
    assert!(!format!("{s:?}").contains("1.2.3.4"));
}
case!(sessions_report, json!({"reportId": "r", "reportsToday": 1, "limitPerDay": 5}), |c| c.sessions.report(UUID, "captcha"), "POST", &format!("/v1/sessions/{UUID}/report"), Some(json!({"reason": "captcha"})), A);

// ---- x402 (1) + network (3)
case!(x402_info, json!({"supported": true, "pricing": {"perGb": "1.00"}}), |c| c.x402.get_info(), "GET", "/api/x402/info", None, N);
case!(network_policy, json!({"version": 1, "body": {"a": 1}}), |c| c.network.policy(), "GET", "/v1/policy", None, N);
case!(network_pricing, json!({"prices": [{"ipClass": "dc", "pricePerGbMusd": "1000000"}]}), |c| c.network.pricing(), "GET", "/v1/pricing", None, N);
case!(network_stats, json!({"onlineNodes": 3, "byClass": {"dc": 3}}), |c| c.network.stats(), "GET", "/v1/network/stats", None, N);

// ---- nodes (list, revoke, update_caps, tier, register_challenge; register in signer_test)
case!(nodes_challenge_empty, json!({}), |c| c.nodes.register_challenge(None), "POST", "/v1/nodes/challenge", Some(json!({})), A);
case!(nodes_challenge_pubkey, json!({}), |c| c.nodes.register_challenge(Some(&"AB".repeat(32))), "POST", "/v1/nodes/challenge", Some(json!({"nodePubkey": "ab".repeat(32)})), A);
case!(nodes_list, json!({"nodes": [], "limit": 10, "offset": 0}), |c| c.nodes.list(Some(10), Some(0)), "GET", "/v1/nodes?limit=10&offset=0", None, A);
case!(nodes_revoke, json!({"id": UUID, "status": "revoked"}), |c| c.nodes.revoke(UUID), "DELETE", &format!("/v1/nodes/{UUID}"), None, A);
case!(nodes_update_caps, json!({"id": UUID}), |c| c.nodes.update_caps(UUID, &NodeCaps { max_streams: Some(4), gb_per_day: None, req_per_sec: Some(10) }), "PATCH", &format!("/v1/nodes/{UUID}"), Some(json!({"maxStreams": 4, "reqPerSec": 10})), A);
case!(nodes_tier, json!({"tier": {"dailyWithdrawLimitMusd": "100000000"}}), |c| c.nodes.tier(), "GET", "/v1/node/tier", None, A);

// ---- credits (balance, transactions; convert and withdraw in signer_test)
case!(credits_balance, json!({"available": {"musd": "1", "usd": "0.000001"}}), |c| c.credits.balance(), "GET", "/v1/credits", None, A);
case!(credits_transactions, json!({"transactions": [], "nextCursor": null}), |c| c.credits.transactions(Some(50), Some("123"), Some("earn")), "GET", "/v1/credits/transactions?limit=50&cursor=123&type=earn", None, A);

// ---- payouts (1), payoutWallet.get (1)
case!(payouts_list, json!({"payouts": [], "limit": 5, "offset": 1}), |c| c.payouts.list(Some(5), Some(1)), "GET", "/v1/payouts?limit=5&offset=1", None, A);
case!(payout_wallet_get, json!({"payoutWallet": null, "cooldownHours": 72}), |c| c.payout_wallet.get(), "GET", "/v1/payout-wallet", None, A);

// ---- proxy getHealth / getConfig
case!(proxy_health, json!({"status": "ok"}), |c| c.proxy.get_health(), "GET", "/api/proxy/health", None, N);
case!(proxy_config, json!({"httpProxyPort": 8080}), |c| c.proxy.get_config(), "GET", "/api/proxy/config", None, J);

// ---- agent mode without a key falls back to the wallet JWT
#[tokio::test]
async fn agent_mode_uses_jwt_without_key() {
    let m = Mock::default();
    let c = jwt_client(&m);
    m.push(r(200, json!({})));
    c.credits.balance().await.unwrap();
    assert!(m.last().auth().unwrap().starts_with("Bearer eyJ"));
}

#[tokio::test]
async fn no_credential_raises_auth_without_request() {
    let m = Mock::default();
    let c = client(&m);
    let e = c.wallet.get_balance().await.unwrap_err();
    assert!(matches!(e, dominusnode::DominusNodeError::Authentication(_)));
    let e = c.credits.balance().await.unwrap_err();
    assert!(matches!(e, dominusnode::DominusNodeError::Authentication(_)));
    assert_eq!(m.count(), 0);
}
