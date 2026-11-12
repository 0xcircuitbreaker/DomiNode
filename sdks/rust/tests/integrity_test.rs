//! 2.0.1 server-alignment fixes: team keys, health, cursor, chain, byte counts, retries, pagination.
mod common;
use common::*;
use dominusnode::types::*;
use dominusnode::util::build_payout_wallet_message;
use dominusnode::DominusNodeError;
use futures_util::StreamExt;
use serde_json::json;

const TEAM: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

#[tokio::test]
async fn team_key_prefix_and_list_fields() {
    let (c, m) = connected().await;
    m.push(r(201, json!({"id": "k", "prefix": "dn_live_ab", "label": "l", "key": API_KEY})));
    assert_eq!(c.teams.create_key(TEAM, "l").await.unwrap().key_prefix, "dn_live_ab");
    m.push(r(201, json!({"id": "k", "keyPrefix": "dn_live_cd", "label": "l", "key": API_KEY})));
    assert_eq!(c.teams.create_key(TEAM, "l").await.unwrap().key_prefix, "dn_live_cd");
    m.push(r(200, json!({"keys": [
        {"id": "k1", "userId": "u1", "prefix": "dn_live_x", "label": "a", "teamId": TEAM, "createdAt": "t", "revokedAt": null},
        {"id": "k2", "userId": "u2", "keyPrefix": "dn_live_y", "label": "b", "teamId": TEAM, "createdAt": "t", "revokedAt": "r"}
    ]})));
    let keys = c.teams.list_keys(TEAM).await.unwrap().keys;
    assert_eq!((keys[0].key_prefix.as_str(), keys[0].user_id.as_str(), keys[0].team_id.as_str()), ("dn_live_x", "u1", TEAM));
    assert_eq!(keys[0].revoked_at, None);
    assert_eq!(keys[1].key_prefix, "dn_live_y");
    assert_eq!(keys[1].prefix(), "dn_live_y");
    assert_eq!(keys[1].revoked_at.as_deref(), Some("r"));
}

#[tokio::test]
async fn health_status_only() {
    let m = Mock::default();
    let c = client(&m);
    m.push(r(200, json!({"status": "ok", "activeSessions": 4})));
    let h = c.proxy.get_health().await.unwrap();
    assert_eq!((h.status.as_str(), h.active_sessions, h.uptime_seconds), ("ok", 0, 0.0));
}

#[tokio::test]
async fn cursor_matches_server_regex() {
    let (c, m) = connected().await;
    let long = "1".repeat(20);
    for bad in ["0", "01", long.as_str(), "-1", "1a", ""] {
        assert!(matches!(c.credits.transactions(None, Some(bad), None).await, Err(DominusNodeError::Validation(_))), "{bad}");
    }
    assert_eq!(m.count(), 0);
    m.push(r(200, json!({"transactions": [], "nextCursor": null})));
    c.credits.transactions(None, Some(&"9".repeat(19)), None).await.unwrap();
}

#[tokio::test]
async fn new_fields() {
    let (c, m) = connected().await;
    m.push(r(200, json!({"invites": [{"id": "i", "invitedBy": "u9"}]})));
    assert_eq!(c.teams.list_invites(TEAM).await.unwrap().invites[0].invited_by, "u9");
    m.push(r(200, json!({"buyerDiscounts": [{"tier": "Partner", "rank": 4, "buyerDiscountBps": 500}]})));
    assert_eq!(c.network.pricing().await.unwrap().buyer_discounts[0].buyer_discount_bps, 500);
    m.push(r(200, json!({"seed": {"online": 1, "paidBytes24h": "1099511627776"}, "community": {"online": 2, "paidBytes24h": 7}})));
    let s = c.network.stats().await.unwrap();
    assert_eq!((s.seed.paid_bytes24h, s.community.online, s.community.paid_bytes24h), (1_099_511_627_776, 2, 7));
    m.push(r(200, json!({"buyerDiscountBps": 250})));
    assert_eq!(c.credits.balance().await.unwrap().buyer_discount_bps, 250);
    m.push(r(200, json!({"tier": {"buyerDiscountBps": 100}})));
    assert_eq!(c.nodes.tier().await.unwrap().tier.buyer_discount_bps, 100);
}

#[test]
fn byte_counts_accept_numbers_and_strings() {
    let u: UsageResponse = serde_json::from_value(json!({
        "summary": {"totalBytes": "12345678901"},
        "records": [{"bytesIn": 5, "bytesOut": "6", "totalBytes": null}]
    }))
    .unwrap();
    assert_eq!(u.summary.total_bytes, 12_345_678_901);
    assert_eq!((u.records[0].bytes_in, u.records[0].bytes_out, u.records[0].total_bytes), (5, 6, 0));
    for bad in [json!("abc"), json!("1.5"), json!(1.5), json!("99999999999999999999"), json!(true)] {
        assert!(serde_json::from_value::<UsageRecord>(json!({"bytesIn": bad})).is_err());
    }
}

#[tokio::test]
async fn payout_wallet_base_sepolia() {
    let (c, m) = connected().await;
    let addr = "0x3333333333333333333333333333333333333abc";
    m.push(r(200, json!({
        "nonce": nonce(), "expiresAt": "t", "signer": WALLET,
        "message": build_payout_wallet_message(USER_ID, WALLET, addr, "base-sepolia", &nonce()),
        "oldWalletSignatureRequired": false, "oldWalletAddress": null,
    })));
    m.push(r(200, json!({"payoutWallet": {"address": addr, "chain": "base-sepolia", "status": "active"}, "changed": true, "cooldownHours": 0})));
    let (s, _) = signer_for(WALLET, sig());
    c.payout_wallet.set(addr, &s, Some("base-sepolia"), None).await.unwrap();
    assert_eq!(m.calls()[0].body, Some(json!({"address": addr, "chain": "base-sepolia"})));
    m.clear();
    assert!(matches!(c.payout_wallet.set(addr, &s, Some("eth"), None).await, Err(DominusNodeError::Validation(_))));
    assert_eq!(m.count(), 0);
}

#[tokio::test]
async fn report_limit_not_retried() {
    let (c, m) = connected().await;
    m.push(r(409, json!({"error": "At most 20 reports", "code": "REPORT_LIMIT"})));
    let e = c.sessions.report(TEAM, "blocked").await.unwrap_err();
    assert!(matches!(e, DominusNodeError::Conflict(_)));
    assert_eq!(e.code(), Some("REPORT_LIMIT"));
    assert_eq!(m.count(), 1);
    m.clear();
    m.push(rh(429, json!({}), &[("retry-after", "0")]));
    m.push(rh(429, json!({"code": "REPORT_LIMIT"}), &[("retry-after", "0")]));
    let e = c.sessions.report(TEAM, "blocked").await.unwrap_err();
    assert!(matches!(e, DominusNodeError::RateLimit { .. }));
    assert_eq!(e.code(), Some("REPORT_LIMIT"));
    assert_eq!(m.count(), 2);
}

#[tokio::test]
async fn pagination_streams() {
    let (c, m) = connected().await;
    m.push(r(200, json!({"transactions": [{"id": "3"}, {"id": "2"}], "nextCursor": "2"})));
    m.push(r(200, json!({"transactions": [{"id": "1"}], "nextCursor": null})));
    let ids: Vec<String> = c.credits.iter_transactions(Some(2), Some("earn"), None).map(|t| t.unwrap().id).collect().await;
    assert_eq!(ids, ["3", "2", "1"]);
    assert!(m.calls()[1].url.ends_with("/v1/credits/transactions?limit=2&cursor=2&type=earn"));

    m.clear();
    m.push(r(200, json!({"payouts": [{"id": "a"}, {"id": "b"}]})));
    m.push(r(200, json!({"payouts": [{"id": "c"}]})));
    assert_eq!(c.payouts.iter(Some(2)).unwrap().count().await, 3);
    assert!(m.calls()[1].url.ends_with("/v1/payouts?limit=2&offset=2"));

    m.clear();
    m.push(r(200, json!({"nodes": [{"id": "a"}]})));
    m.push(r(200, json!({"nodes": []})));
    assert_eq!(c.nodes.iter(Some(1)).unwrap().count().await, 1);
    assert_eq!(m.count(), 2);

    m.clear();
    m.push(r(200, json!({"records": [{"id": "a"}, {"id": "b"}], "pagination": {"total": 2}})));
    assert_eq!(c.usage.iter_records(Some("2026-01-01"), None, Some(2)).unwrap().count().await, 2);
    assert_eq!(m.count(), 1);

    m.clear();
    m.push(r(200, json!({"transactions": [{"id": "a"}]})));
    assert_eq!(c.wallet.iter_transactions(Some(5)).unwrap().count().await, 1);
    assert!(matches!(c.wallet.iter_transactions(Some(101)), Err(DominusNodeError::Validation(_))));

    m.clear();
    m.push(r(500, json!({"error": "boom"})));
    let first: Vec<_> = c.payouts.iter(None).unwrap().collect().await;
    assert_eq!(first.len(), 1);
    assert!(first[0].is_err());
}

/// The 2.0.0 public field names and types still exist.
#[test]
fn backward_compatible_fields() {
    let inv = TeamInvite::default();
    let _: &String = &inv.token;
    let h = ProxyHealth::default();
    let _: (i64, f64) = (h.active_sessions, h.uptime_seconds);
    let k: TeamKey = serde_json::from_value(json!({"id": "k", "prefix": "dn_live_p"})).unwrap();
    let _: &String = &k.key_prefix;
    assert_eq!(k.key_prefix, "dn_live_p");
    let k: TeamKey = serde_json::from_value(json!({"id": "k", "keyPrefix": "dn_live_q"})).unwrap();
    assert_eq!(k.prefix(), "dn_live_q");
    let r = UsageRecord::default();
    let _: i64 = r.bytes_in + r.bytes_out + r.total_bytes;
}
