//! HTTP behaviour, error mapping, validation, redaction and credential lifecycle.
mod common;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use dominusnode::http::{retry_delay, retry_delay_with};
use dominusnode::token_manager::TokenManager;
use dominusnode::types::NodeCaps;
use dominusnode::{scrub_credentials, Config, DominusNodeClient, DominusNodeError, Secret};
use serde_json::json;

// ---------------------------------------------------------------- error mapping

#[tokio::test]
async fn error_mapping_by_status() {
    type Is = fn(&DominusNodeError) -> bool;
    let cases: Vec<(u16, Is)> = vec![
        (400, |e| matches!(e, DominusNodeError::Validation(_))),
        (402, |e| matches!(e, DominusNodeError::InsufficientBalance(_))),
        (403, |e| matches!(e, DominusNodeError::Authorization(_))),
        (404, |e| matches!(e, DominusNodeError::NotFound(_))),
        (409, |e| matches!(e, DominusNodeError::Conflict(_))),
        (500, |e| matches!(e, DominusNodeError::Server(_))),
        (503, |e| matches!(e, DominusNodeError::Server(_))),
        (418, |e| matches!(e, DominusNodeError::Api(_))),
    ];
    for (status, is) in cases {
        let (c, m) = connected().await;
        m.push(r(status, json!({"error": format!("boom {status}"), "code": "CAP_ABOVE_DEFAULT", "max": 5, "cap": "7", "limitPerDay": 3, "other": 1})));
        let e = c.credits.balance().await.unwrap_err();
        assert!(is(&e), "{status}: {e:?}");
        assert_eq!(e.status_code(), Some(status));
        assert_eq!(e.code(), Some("CAP_ABOVE_DEFAULT"));
        assert_eq!(e.message(), format!("boom {status}"));
        let d = e.details().unwrap();
        assert_eq!(d["max"], json!(5));
        assert_eq!(d["cap"], json!("7"));
        assert_eq!(d["limitPerDay"], json!(3));
        assert!(!d.contains_key("other"));
    }
}

#[tokio::test]
async fn error_401_with_api_key_no_refresh() {
    let (c, m) = connected().await;
    m.push(r(401, json!({"error": "bad key"})));
    let e = c.credits.balance().await.unwrap_err();
    assert!(matches!(e, DominusNodeError::Authentication(_)));
    assert_eq!(m.count(), 1);
}

#[tokio::test]
async fn error_message_fallbacks_and_truncation() {
    let (c, m) = connected().await;
    m.push(r(400, json!({"message": "from message"})));
    assert_eq!(c.credits.balance().await.unwrap_err().message(), "from message");
    m.push(raw(400, ""));
    assert_eq!(c.credits.balance().await.unwrap_err().message(), "HTTP 400");
    m.push(r(400, json!({"error": "x".repeat(600)})));
    let e = c.credits.balance().await.unwrap_err();
    assert_eq!(e.message().len(), 500 + "... [truncated]".len());
    m.push(r(403, json!({"error": "MFA", "mfaRequired": true})));
    assert_eq!(c.credits.balance().await.unwrap_err().code(), Some("MFA_REQUIRED"));
}

#[tokio::test]
async fn error_messages_are_scrubbed() {
    let (c, m) = connected().await;
    let jwt = make_jwt(10);
    let node = format!("dn_node_{}", "a".repeat(64));
    m.push(r(400, json!({"error": format!("key {API_KEY} node {node} jwt {jwt} test dn_test_abcdefgh proxy dn_proxy_x")})));
    let e = c.credits.balance().await.unwrap_err();
    for s in [API_KEY, node.as_str(), jwt.as_str(), "dn_test_abcdefgh", "dn_proxy_x"] {
        assert!(!e.message().contains(s), "{}", e.message());
        assert!(!format!("{e}").contains(s));
        assert!(!format!("{e:?}").contains(s));
    }
    assert!(e.message().contains("[REDACTED]"));
    // transport errors too
    m.push(Reply::Fail(format!("connect failed for {API_KEY}")));
    let e = c.credits.balance().await.unwrap_err();
    assert!(matches!(e, DominusNodeError::Network(_)));
    assert!(!e.message().contains(API_KEY));
}

#[test]
fn scrub_patterns() {
    assert_eq!(scrub_credentials("a dn_live_abc-_9 b"), "a [REDACTED] b");
    assert_eq!(scrub_credentials("eyJa.b.c rest"), "[REDACTED] rest");
    assert_eq!(scrub_credentials("eyJa.b. x"), "[REDACTED] x");
    assert_eq!(scrub_credentials("dn_live_ alone"), "dn_live_ alone");
}

#[tokio::test]
async fn invalid_json_and_redirect() {
    let (c, m) = connected().await;
    m.push(raw(200, "not json"));
    assert!(matches!(c.credits.balance().await, Err(DominusNodeError::Server(_))));
    m.push(Reply::Ok(302, vec![], vec![("location".into(), "http://evil/".into())]));
    let e = c.credits.balance().await.unwrap_err();
    assert_eq!(e.status_code(), Some(302));
    assert_eq!(m.count(), 2, "redirect not followed");
    m.push(raw(200, ""));
    c.auth.logout().await.unwrap();
}

// ---------------------------------------------------------------- 429

#[tokio::test]
async fn retry_429_once_then_success_body_not_read() {
    let (c, m) = connected().await;
    m.push(rh(429, json!({"error": "slow"}), &[("retry-after", "0")]));
    m.push(r(200, json!({})));
    let t = Instant::now();
    c.credits.balance().await.unwrap();
    assert!(t.elapsed() >= Duration::from_millis(90));
    assert_eq!(m.count(), 2);
    assert!(!m.bodies_read.lock().unwrap()[0].load(Ordering::SeqCst), "429 body cancelled unread");
}

#[tokio::test]
async fn second_429_raises_rate_limit() {
    let (c, m) = connected().await;
    m.push(rh(429, json!({}), &[("retry-after", "0")]));
    m.push(rh(429, json!({"error": "still", "code": "RATE_LIMITED"}), &[("retry-after", "42")]));
    match c.credits.balance().await.unwrap_err() {
        DominusNodeError::RateLimit { info, retry_after_seconds } => {
            assert_eq!(retry_after_seconds, 42);
            assert_eq!(info.code.as_deref(), Some("RATE_LIMITED"));
        }
        e => panic!("{e:?}"),
    }
    assert_eq!(m.count(), 2);
    m.push(rh(429, json!({}), &[("retry-after", "0")]));
    m.push(r(429, json!({})));
    match c.credits.balance().await.unwrap_err() {
        DominusNodeError::RateLimit { retry_after_seconds, .. } => assert_eq!(retry_after_seconds, 60),
        e => panic!("{e:?}"),
    }
}

#[test]
fn retry_delay_bounds() {
    assert_eq!(retry_delay_with(100, 0.0), Duration::from_millis(9000));
    assert_eq!(retry_delay_with(100, 0.999_999_9), Duration::from_millis(11000));
    assert_eq!(retry_delay_with(5, 0.5), Duration::from_millis(5000));
    assert_eq!(retry_delay_with(0, 0.0), Duration::from_millis(100));
    for _ in 0..200 {
        let d = retry_delay(3600).as_millis();
        assert!((9000..=11000).contains(&d));
        assert!(retry_delay(0).as_millis() >= 100);
    }
}

// ---------------------------------------------------------------- 401 refresh

#[tokio::test]
async fn jwt_401_refreshes_and_retries() {
    let m = Mock::default();
    let c = jwt_client(&m);
    let new_access = make_jwt(901);
    m.push(r(401, json!({"error": "expired"})));
    m.push(r(200, json!({"token": new_access, "refreshToken": make_jwt(90000)})));
    m.push(r(200, json!({"balanceCents": 7})));
    let b = c.wallet.get_balance().await.unwrap();
    assert_eq!(b.balance_cents, 7);
    let calls = m.calls();
    assert_eq!(calls[1].path, "/api/auth/refresh");
    assert!(calls[1].auth().is_none());
    assert_eq!(calls[2].auth().unwrap(), format!("Bearer {new_access}"));
}

#[tokio::test]
async fn refresh_failure_clears_tokens() {
    let m = Mock::default();
    let c = jwt_client(&m);
    m.push(r(401, json!({})));
    m.push(r(401, json!({"error": "revoked"})));
    let e = c.wallet.get_balance().await.unwrap_err();
    assert!(matches!(e, DominusNodeError::Authentication(_)));
    assert!(!c.token_manager().has_tokens());
    assert!(!c.is_connected());
}

#[tokio::test]
async fn expired_access_token_refreshed_before_request() {
    let m = Mock::default();
    let c = client_with(&m, |cfg| {
        cfg.access_token = Some(make_jwt(10)); // inside the 60 s buffer
        cfg.refresh_token = Some(make_jwt(9000));
    });
    let fresh = make_jwt(900);
    m.push(r(200, json!({"token": fresh})));
    m.push(r(200, json!({})));
    c.wallet.get_forecast().await.unwrap();
    assert_eq!(m.calls()[0].path, "/api/auth/refresh");
    assert_eq!(m.last().auth().unwrap(), format!("Bearer {fresh}"));
}

#[tokio::test]
async fn concurrent_refresh_is_singleton() {
    let m = Mock::default();
    let c = Arc::new(client_with(&m, |cfg| {
        cfg.access_token = Some(make_jwt(0));
        cfg.refresh_token = Some(make_jwt(9000));
    }));
    m.push(r(200, json!({"token": make_jwt(900)})));
    for _ in 0..4 {
        m.push(r(200, json!({})));
    }
    let tasks: Vec<_> = (0..4)
        .map(|_| {
            let c = c.clone();
            tokio::spawn(async move { c.wallet.get_forecast().await })
        })
        .collect();
    for t in tasks {
        t.await.unwrap().unwrap();
    }
    assert_eq!(m.calls().iter().filter(|c| c.path == "/api/auth/refresh").count(), 1);
}

// ---------------------------------------------------------------- size cap

#[tokio::test]
async fn cap_by_content_length_and_by_size() {
    let (c, m) = connected().await;
    m.push(Reply::Ok(200, vec![], vec![("content-length".into(), (11 * 1024 * 1024).to_string())]));
    // mock appends its own content-length after ours; ours is found first.
    let e = c.credits.balance().await.unwrap_err();
    assert!(matches!(e, DominusNodeError::Server(_)));
    assert!(!m.bodies_read.lock().unwrap()[0].load(Ordering::SeqCst));
    m.push(Reply::Ok(200, vec![b' '; 10 * 1024 * 1024 + 1], vec![("content-length".into(), "10".into())]));
    let e = c.credits.balance().await.unwrap_err();
    assert!(matches!(e, DominusNodeError::Server(_)));
    assert!(e.message().contains("size limit"));
}

// ---------------------------------------------------------------- validation (no request)

#[tokio::test]
async fn validation_failures_send_nothing() {
    let (c, m) = connected().await;
    let is_inv = |e: DominusNodeError| {
        assert!(matches!(e, DominusNodeError::Validation(_)), "{e:?}");
        assert_eq!(e.code(), Some("INVALID_ARGUMENT"));
        assert_eq!(e.status_code(), None);
    };
    // cents
    is_inv(c.agentic_wallets.fund("w", 0).await.unwrap_err());
    is_inv(c.agentic_wallets.fund("w", 2_147_483_648).await.unwrap_err());
    is_inv(c.teams.fund_wallet("t", -1).await.unwrap_err());
    is_inv(c.agentic_wallets.create("x", Some(-1), None, None).await.unwrap_err());
    is_inv(c.agentic_wallets.create("x", None, Some(2_147_483_648), None).await.unwrap_err());
    is_inv(c.wallet.top_up_crypto(999, "btc").await.unwrap_err());
    is_inv(c.wallet.top_up_crypto(100_001, "btc").await.unwrap_err());
    is_inv(c.wallet.top_up_crypto(5000, "doge").await.unwrap_err());
    // µUSD
    let (s, _) = signer_for(WALLET, sig());
    is_inv(c.credits.convert(9_999u64, &s, None).await.unwrap_err());
    is_inv(c.credits.convert(10_000_000_001u64, &s, None).await.unwrap_err());
    is_inv(c.credits.convert("012345", &s, None).await.unwrap_err());
    is_inv(c.credits.convert("1.5", &s, None).await.unwrap_err());
    is_inv(c.credits.convert(-5i64, &s, None).await.unwrap_err());
    is_inv(c.credits.convert("12345678901234567", &s, None).await.unwrap_err());
    is_inv(c.credits.withdraw(999_999u64, &s, None).await.unwrap_err());
    is_inv(c.credits.withdraw(100_000_000_001u64, &s, None).await.unwrap_err());
    // idempotency key
    is_inv(c.credits.convert(10_000u64, &s, Some("short")).await.unwrap_err());
    is_inv(c.credits.convert(10_000u64, &s, Some("has space!!")).await.unwrap_err());
    is_inv(c.credits.convert(10_000u64, &s, Some(&"a".repeat(121))).await.unwrap_err());
    // uuid / address / signature
    is_inv(c.nodes.revoke("not-a-uuid").await.unwrap_err());
    is_inv(c.sessions.report("x", "slow").await.unwrap_err());
    is_inv(c.sessions.report(UUID, "bored").await.unwrap_err());
    is_inv(c.wallet.get_crypto_status("x").await.unwrap_err());
    is_inv(c.wallet_auth.challenge("0x123").await.unwrap_err());
    is_inv(c.wallet_auth.verify(WALLET, &format!("0x{}", "a".repeat(129))).await.unwrap_err());
    is_inv(c.wallet_auth.verify(WALLET, &format!("0x{}", "a".repeat(199))).await.unwrap_err());
    is_inv(c.wallet_auth.link(WALLET, &format!("0x{}", "z".repeat(130))).await.unwrap_err());
    // ranges and misc
    is_inv(c.nodes.list(Some(0), None).await.unwrap_err());
    is_inv(c.nodes.list(Some(501), None).await.unwrap_err());
    is_inv(c.nodes.list(None, Some(1_000_001)).await.unwrap_err());
    is_inv(c.nodes.update_caps(UUID, &NodeCaps::default()).await.unwrap_err());
    is_inv(c.nodes.update_caps(UUID, &NodeCaps { max_streams: Some(0), ..Default::default() }).await.unwrap_err());
    is_inv(c.payouts.list(Some(201), None).await.unwrap_err());
    is_inv(c.credits.transactions(Some(201), None, None).await.unwrap_err());
    is_inv(c.credits.transactions(None, Some("abc"), None).await.unwrap_err());
    is_inv(c.credits.transactions(None, None, Some("steal")).await.unwrap_err());
    is_inv(c.keys.create(Some("")).await.unwrap_err());
    is_inv(c.keys.create(Some(&"x".repeat(101))).await.unwrap_err());
    is_inv(c.teams.create_key("t", "").await.unwrap_err());
    is_inv(c.auth.verify_key("dn_live_short").await.unwrap_err());
    is_inv(c.connect_with_key("sk_live_whatever123").await.unwrap_err());
    assert_eq!(m.count(), 0);
}

#[test]
fn config_validation() {
    let bad = |f: fn(&mut Config)| {
        let mut c = Config::default();
        f(&mut c);
        let e = DominusNodeClient::new(c).unwrap_err();
        assert_eq!(e.code(), Some("INVALID_ARGUMENT"));
    };
    bad(|c| c.base_url = "ftp://x".into());
    bad(|c| c.base_url = "https://user:pw@x".into());
    bad(|c| c.base_url = "not a url".into());
    bad(|c| c.proxy_host = "bad host".into());
    bad(|c| c.http_proxy_port = 0);
    bad(|c| c.socks5_proxy_port = 70000);
    let mut ok = Config { base_url: "https://api.example.com///".into(), proxy_host: "[::1]".into(), ..Default::default() };
    ok.http_proxy_port = 65535;
    DominusNodeClient::new(ok).unwrap();
}

// ---------------------------------------------------------------- connect / disconnect / redaction

#[tokio::test]
async fn connect_with_key_mfa_stores_key_only() {
    let m = Mock::default();
    let c = client(&m);
    m.push(r(403, json!({"error": "MFA required", "mfaRequired": true})));
    let res = c.connect_with_key(API_KEY).await.unwrap();
    assert!(res.mfa_required && res.user_id.is_none());
    assert!(c.is_connected());
    assert!(!c.token_manager().has_tokens());
    m.push(r(200, json!({})));
    c.credits.balance().await.unwrap();
    assert_eq!(m.last().auth().unwrap(), format!("Bearer {API_KEY}"));
}

#[tokio::test]
async fn connect_with_key_other_error_stores_nothing() {
    let m = Mock::default();
    let c = client(&m);
    m.push(r(401, json!({"error": "nope"})));
    assert!(c.connect_with_key(API_KEY).await.is_err());
    assert!(!c.is_connected());
}

#[tokio::test]
async fn connect_returns_user_id() {
    let (c, _m) = connected().await;
    assert!(c.is_connected());
    assert_eq!(format!("{c:?}"), "DominusNodeClient(connected=true)");
    assert_eq!(serde_json::to_value(&c).unwrap(), json!({"connected": true}));
}

#[tokio::test]
async fn disconnect_logs_out_first_then_clears_everything() {
    let (c, m) = connected().await;
    m.push(r(200, json!({})));
    c.disconnect().await;
    let call = m.last();
    assert_eq!(call.path, "/api/auth/logout");
    assert!(call.auth().unwrap().starts_with("Bearer eyJ"), "logout sent while tokens still held");
    assert!(!c.is_connected());
    assert!(c.token_manager().access_token().is_none() && c.token_manager().refresh_token().is_none());
    assert_eq!(format!("{c}"), "DominusNodeClient(connected=false)");
    // proxy no longer has a key
    assert!(matches!(
        c.proxy.build_url(&Default::default(), Default::default(), None),
        Err(DominusNodeError::Authentication(_))
    ));
    // refresh callback survives: reconnect works
    assert!(c.token_manager().has_refresh_function());
    m.push(r(200, json!({"valid": true, "token": make_jwt(900), "refreshToken": make_jwt(9000), "userId": USER_ID})));
    c.connect_with_key(API_KEY).await.unwrap();
    assert!(c.is_connected());
}

#[tokio::test]
async fn disconnect_ignores_logout_failure() {
    let (c, m) = connected().await;
    m.push(Reply::Fail("down".into()));
    c.disconnect().await;
    assert!(!c.is_connected());
}

#[test]
fn token_manager_clear_keeps_refresh_fn_and_redacts() {
    let tm = TokenManager::new();
    tm.set_refresh_function(Arc::new(|_| Box::pin(async { Ok(("a".to_string(), None)) })));
    let jwt = make_jwt(900);
    tm.set_tokens(&jwt, Some("refresh-secret"));
    assert!(!format!("{tm:?}").contains("refresh-secret"));
    assert!(!format!("{tm}").contains(&jwt));
    assert_eq!(serde_json::to_value(&tm).unwrap(), json!("[REDACTED]"));
    tm.clear();
    assert!(!tm.has_tokens());
    assert!(tm.has_refresh_function());
}

#[test]
fn secret_redaction() {
    let s = Secret::new("dn_live_supersecretvalue");
    assert_eq!(s.reveal(), "dn_live_supersecretvalue");
    assert_eq!(s.prefix(), "dn_live_");
    assert_eq!(format!("{s}"), "[REDACTED]");
    assert_eq!(format!("{s:?}"), "Secret([REDACTED])");
    assert_eq!(serde_json::to_string(&s).unwrap(), "\"[REDACTED]\"");
}

#[test]
fn config_debug_redacts_tokens() {
    let c = Config { access_token: Some("eyJsecret.a.b".into()), ..Default::default() };
    assert!(!format!("{c:?}").contains("eyJsecret"));
}
