//! Signed-message parity with the Node SDK and every signer flow.
mod common;
use common::*;
use dominusnode::util::*;
use dominusnode::{DominusNodeError, FnSigner, RegisterNodeOptions};
use serde_json::{json, Value};

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/signed_messages.json")).unwrap()
}

// ---------------------------------------------------------------- byte-for-byte fixtures

#[test]
fn attestation_matches_node_without_pubkey() {
    let f = fixtures();
    let w = f["wallet"].as_str().unwrap();
    let m = build_attestation_message(w, &"f".repeat(64), 3, "line1\nline2 µ", None);
    assert_eq!(m.as_bytes(), f["attestation_none"].as_str().unwrap().as_bytes());
}

#[test]
fn attestation_matches_node_with_pubkey() {
    let f = fixtures();
    let w = f["wallet"].as_str().unwrap();
    let m = build_attestation_message(w, &"0123456789abcdef".repeat(4), 12, "I agree.\n\nTrailing", Some(&"ab".repeat(32)));
    assert_eq!(m.as_bytes(), f["attestation_key"].as_str().unwrap().as_bytes());
}

#[test]
fn payout_message_matches_node() {
    let f = fixtures();
    let m = build_payout_wallet_message(USER_ID, f["wallet"].as_str().unwrap(), "0x2222222222222222222222222222222222222AAA", "base", &"e".repeat(64));
    assert_eq!(m.as_bytes(), f["payout"].as_str().unwrap().as_bytes());
}

#[test]
fn withdraw_message_matches_node() {
    let f = fixtures();
    let m = build_withdraw_message(USER_ID, f["wallet"].as_str().unwrap(), "1234567", "dn-key_ABC-123", &"d".repeat(64));
    assert_eq!(m.as_bytes(), f["withdraw"].as_str().unwrap().as_bytes());
}

#[test]
fn extract_user_id_requires_uuid() {
    assert_eq!(extract_user_id(&build_withdraw_message(USER_ID, WALLET, "1", "kkkkkkkk", "n")).unwrap(), USER_ID);
    assert!(matches!(extract_user_id("a\nb\nUser: not-a-uuid"), Err(DominusNodeError::Protocol(_))));
    assert!(matches!(extract_user_id("short"), Err(DominusNodeError::Protocol(_))));
}

#[test]
fn pow_solution_verifies() {
    let n = solve_pow("abc", 8.0, 1_000_000).unwrap();
    assert!(verify_pow("abc", &n, 8));
    // smallest: no smaller n satisfies
    let v: u64 = n.parse().unwrap();
    assert!((0..v).all(|i| !verify_pow("abc", &i.to_string(), 8)));
    assert!(matches!(solve_pow("abc", 0.0, 10), Err(DominusNodeError::Protocol(_))));
    assert!(matches!(solve_pow("abc", 33.0, 10), Err(DominusNodeError::Protocol(_))));
    assert!(matches!(solve_pow("", 4.0, 10), Err(DominusNodeError::Protocol(_))));
    assert!(matches!(solve_pow(&"a".repeat(257), 4.0, 10), Err(DominusNodeError::Protocol(_))));
    assert!(matches!(solve_pow("abc", 30.0, 5), Err(DominusNodeError::Protocol(_))));
}

// ---------------------------------------------------------------- node register

fn node_challenge(pubkey: Option<&str>) -> Value {
    let msg = build_attestation_message(WALLET, &nonce(), 2, "Be a good node.", pubkey);
    json!({
        "nonce": nonce(), "attestationText": "Be a good node.", "attestationVersion": 2, "policyVersion": 1,
        "message": msg, "expiresAt": "t",
        "powChallenge": {"challengeId": UUID, "prefix": "pfx", "difficulty": 6, "algorithm": "sha256", "expiresAt": "t"}
    })
}

#[tokio::test]
async fn node_register_full_flow() {
    let (c, m) = connected().await;
    let pk = "cd".repeat(32);
    m.push(r(200, node_challenge(Some(&pk))));
    let key = format!("dn_node_{}", "0".repeat(64));
    m.push(r(201, json!({"nodeId": UUID, "nodeKey": key, "status": "pending", "attestationVersion": 2})));
    let (s, signed) = signer_for(WALLET, sig());
    let mut o = RegisterNodeOptions::new(&s);
    o.node_pubkey = Some(pk.to_uppercase());
    o.max_streams = Some(8);
    o.max_gb_day = Some(5);
    let node = c.nodes.register(o).await.unwrap();
    assert_eq!(node.node_key.reveal(), key);
    assert!(!format!("{node:?}").contains(&key));
    let calls = m.calls();
    assert_eq!(calls[0].body, Some(json!({"nodePubkey": pk})));
    let b = calls[1].body.clone().unwrap();
    assert_eq!(calls[1].path, "/v1/nodes");
    assert_eq!(calls[1].auth().unwrap(), format!("Bearer {API_KEY}"));
    assert_eq!(b["walletSignature"], sig());
    assert_eq!(b["nodePubkey"], pk);
    assert_eq!(b["maxStreams"], 8);
    assert_eq!(b["maxGbDay"], 5);
    assert_eq!(b["pow"]["challengeId"], UUID);
    assert!(verify_pow("pfx", b["pow"]["nonce"].as_str().unwrap(), 6));
    assert_eq!(signed.lock().unwrap()[0], build_attestation_message(WALLET, &nonce(), 2, "Be a good node.", Some(&pk)));
}

#[tokio::test]
async fn node_register_refuses_mismatched_message() {
    let (c, m) = connected().await;
    let mut ch = node_challenge(None);
    ch["message"] = json!(build_attestation_message(OTHER_WALLET, &nonce(), 2, "Be a good node.", None));
    m.push(r(200, ch));
    let (s, signed) = signer_for(WALLET, sig());
    let e = c.nodes.register(RegisterNodeOptions::new(&s)).await.unwrap_err();
    assert!(matches!(e, DominusNodeError::Protocol(_)));
    assert!(signed.lock().unwrap().is_empty());
    assert_eq!(m.count(), 1);
}

#[tokio::test]
async fn node_register_validates_challenge_and_response() {
    let (s, signed) = signer_for(WALLET, sig());
    for (field, val) in [("nonce", json!("XYZ")), ("attestationText", json!("")), ("attestationVersion", json!(0))] {
        let (c, m) = connected().await;
        let mut ch = node_challenge(None);
        ch[field] = val;
        m.push(r(200, ch));
        assert!(matches!(c.nodes.register(RegisterNodeOptions::new(&s)).await, Err(DominusNodeError::Protocol(_))), "{field}");
    }
    let (c, m) = connected().await;
    m.push(r(200, node_challenge(None)));
    m.push(r(201, json!({"nodeId": UUID, "nodeKey": "dn_node_short"})));
    assert!(matches!(c.nodes.register(RegisterNodeOptions::new(&s)).await, Err(DominusNodeError::Protocol(_))));
    assert_eq!(signed.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn node_register_validates_args_before_request() {
    let (c, m) = connected().await;
    let (s, _) = signer_for(WALLET, sig());
    let mut o = RegisterNodeOptions::new(&s);
    o.max_streams = Some(1025);
    assert!(c.nodes.register(o).await.is_err());
    let mut o = RegisterNodeOptions::new(&s);
    o.max_gb_day = Some(0);
    assert!(c.nodes.register(o).await.is_err());
    let mut o = RegisterNodeOptions::new(&s);
    o.node_pubkey = Some("zz".into());
    assert!(c.nodes.register(o).await.is_err());
    let (bad, _) = signer_for("0x123", sig());
    assert!(c.nodes.register(RegisterNodeOptions::new(&bad)).await.is_err());
    assert_eq!(m.count(), 0);
}

#[tokio::test]
async fn bad_signature_format_and_signer_error_are_protocol_errors() {
    for s in ["0x12".to_string(), format!("0x{}", "g".repeat(130)), format!("0x{}", "a".repeat(250))] {
        let (c, m) = connected().await;
        m.push(r(200, node_challenge(None)));
        let (sg, _) = signer_for(WALLET, s);
        let e = c.nodes.register(RegisterNodeOptions::new(&sg)).await.unwrap_err();
        assert!(matches!(e, DominusNodeError::Protocol(_)));
        assert_eq!(m.count(), 1);
    }
    let (c, m) = connected().await;
    m.push(r(200, node_challenge(None)));
    let failing = FnSigner::new(WALLET, |_m: &str| Err(format!("hsm offline {API_KEY}")));
    let e = c.nodes.register(RegisterNodeOptions::new(&failing)).await.unwrap_err();
    assert!(matches!(e, DominusNodeError::Protocol(_)));
    assert!(!e.message().contains(API_KEY));
}

// ---------------------------------------------------------------- withdraw

fn withdraw_challenge(amount: &str, key: &str, signer: &str, wallet_in_msg: &str) -> Value {
    json!({"nonce": nonce(), "message": build_withdraw_message(USER_ID, wallet_in_msg, amount, key, &nonce()), "expiresAt": "t", "signer": signer})
}

#[tokio::test]
async fn withdraw_flow() {
    let (c, m) = connected().await;
    m.push(r(200, withdraw_challenge("2000000", "idem-key-01", &WALLET.to_uppercase().replace("0X", "0x"), WALLET)));
    m.push(r(200, json!({"payout": {"id": "p", "status": "pending", "amount": {"musd": "2000000", "usd": "2.000000"}}, "duplicate": false})));
    let (s, signed) = signer_for(WALLET, sig());
    let res = c.credits.withdraw(2_000_000u64, &s, Some("idem-key-01")).await.unwrap();
    assert_eq!(res.idempotency_key, "idem-key-01");
    assert_eq!(res.payout.status, "pending");
    let calls = m.calls();
    assert_eq!(calls[0].path, "/v1/credits/withdraw/challenge");
    assert_eq!(calls[0].body, Some(json!({"amountMusd": "2000000", "idempotencyKey": "idem-key-01"})));
    assert_eq!(calls[1].path, "/v1/credits/withdraw");
    assert_eq!(calls[1].body, Some(json!({"amountMusd": "2000000", "idempotencyKey": "idem-key-01", "nonce": nonce(), "signature": sig()})));
    assert_eq!(signed.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn withdraw_refuses_mismatch_and_wrong_signer() {
    let (s, signed) = signer_for(WALLET, sig());
    // message built for a different amount
    let (c, m) = connected().await;
    m.push(r(200, withdraw_challenge("9999999", "idem-key-01", WALLET, WALLET)));
    assert!(matches!(c.credits.withdraw(2_000_000u64, &s, Some("idem-key-01")).await, Err(DominusNodeError::Protocol(_))));
    // server signer differs
    let (c, m2) = connected().await;
    m2.push(r(200, withdraw_challenge("2000000", "idem-key-01", OTHER_WALLET, WALLET)));
    assert!(matches!(c.credits.withdraw(2_000_000u64, &s, Some("idem-key-01")).await, Err(DominusNodeError::Protocol(_))));
    assert!(signed.lock().unwrap().is_empty());
    assert_eq!(m.count() + m2.count(), 2);
}

// ---------------------------------------------------------------- payout wallet

const NEW_ADDR: &str = "0x3333333333333333333333333333333333333ABC";

fn payout_challenge(required: bool, old: Option<&str>, msg_addr: &str) -> Value {
    json!({
        "nonce": nonce(), "expiresAt": "t", "signer": WALLET,
        "message": build_payout_wallet_message(USER_ID, WALLET, msg_addr, "base", &nonce()),
        "oldWalletSignatureRequired": required, "oldWalletAddress": old,
    })
}

#[tokio::test]
async fn payout_wallet_first_set() {
    let (c, m) = connected().await;
    m.push(r(200, payout_challenge(false, None, NEW_ADDR)));
    m.push(r(200, json!({"payoutWallet": {"address": NEW_ADDR.to_lowercase(), "chain": "base", "status": "active"}, "changed": true, "cooldownHours": 72})));
    let (s, signed) = signer_for(WALLET, sig());
    c.payout_wallet.set(NEW_ADDR, &s, None, None).await.unwrap();
    let calls = m.calls();
    assert_eq!(calls[0].path, "/v1/payout-wallet/challenge");
    assert_eq!(calls[0].body, Some(json!({"address": NEW_ADDR.to_lowercase(), "chain": "base"})));
    assert_eq!(calls[1].method, "PUT");
    assert_eq!(calls[1].body, Some(json!({"address": NEW_ADDR.to_lowercase(), "chain": "base", "nonce": nonce(), "signature": sig()})));
    assert_eq!(signed.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn payout_wallet_change_old_signer_signs_same_message() {
    let (c, m) = connected().await;
    m.push(r(200, payout_challenge(true, Some(OTHER_WALLET), NEW_ADDR)));
    m.push(r(200, json!({"changed": true})));
    let (s, signed) = signer_for(WALLET, sig());
    let old_sig = format!("0x{}", "cd".repeat(65));
    let (old, old_signed) = signer_for(OTHER_WALLET, old_sig.clone());
    c.payout_wallet.set(NEW_ADDR, &s, Some("base"), Some(&old)).await.unwrap();
    assert_eq!(signed.lock().unwrap()[0], old_signed.lock().unwrap()[0]);
    assert_eq!(m.last().body.unwrap()["oldWalletSignature"], old_sig);
}

#[tokio::test]
async fn payout_wallet_refusals() {
    let (s, signed) = signer_for(WALLET, sig());
    let (wrong_old, old_signed) = signer_for("0x4444444444444444444444444444444444444444", sig());
    // required but missing
    let (c, m) = connected().await;
    m.push(r(200, payout_challenge(true, Some(OTHER_WALLET), NEW_ADDR)));
    assert!(matches!(c.payout_wallet.set(NEW_ADDR, &s, None, None).await, Err(DominusNodeError::Validation(_))));
    // wrong old signer
    m.push(r(200, payout_challenge(true, Some(OTHER_WALLET), NEW_ADDR)));
    assert!(matches!(c.payout_wallet.set(NEW_ADDR, &s, None, Some(&wrong_old)).await, Err(DominusNodeError::Validation(_))));
    // mismatched message (different address)
    m.push(r(200, payout_challenge(false, None, OTHER_WALLET)));
    assert!(matches!(c.payout_wallet.set(NEW_ADDR, &s, None, None).await, Err(DominusNodeError::Protocol(_))));
    // server signer differs
    let mut ch = payout_challenge(false, None, NEW_ADDR);
    ch["signer"] = json!(OTHER_WALLET);
    m.push(r(200, ch));
    assert!(matches!(c.payout_wallet.set(NEW_ADDR, &s, None, None).await, Err(DominusNodeError::Protocol(_))));
    assert!(signed.lock().unwrap().is_empty() && old_signed.lock().unwrap().is_empty());
    // chain other than base: no request
    let before = m.count();
    assert!(c.payout_wallet.set(NEW_ADDR, &s, Some("eth"), None).await.is_err());
    assert!(c.payout_wallet.set("0xnope", &s, None, None).await.is_err());
    assert_eq!(m.count(), before);
}
