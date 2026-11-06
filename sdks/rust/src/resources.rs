//! API resources (SDK_SURFACE section 3, all except `proxy`).

use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::errors::{DominusNodeError, Result};
use crate::http::{AuthMode, Credentials, HttpClient};
use crate::types::*;
use crate::util::*;

type Http = Arc<HttpClient>;

fn opt<T: ToString>(v: Option<T>) -> Option<String> {
    v.map(|x| x.to_string())
}

// =================================================================== auth (4)

/// Token plumbing.
#[derive(Debug, Clone)]
pub struct AuthResource {
    http: Http,
}
impl AuthResource {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }
    /// `POST /api/auth/verify-key` [none].
    pub async fn verify_key(&self, api_key: &str) -> Result<VerifyKeyResponse> {
        validate_api_key(api_key)?;
        self.http.post("/api/auth/verify-key", json!({ "apiKey": api_key }), AuthMode::None).await
    }
    /// `POST /api/auth/refresh` [none].
    pub async fn refresh(&self, refresh_token: &str) -> Result<RefreshResponse> {
        if refresh_token.is_empty() {
            return Err(DominusNodeError::invalid_arg("refreshToken is required"));
        }
        self.http.post("/api/auth/refresh", json!({ "refreshToken": refresh_token }), AuthMode::None).await
    }
    /// `POST /api/auth/logout` [jwt].
    pub async fn logout(&self) -> Result<()> {
        self.http.post::<Value>("/api/auth/logout", json!({}), AuthMode::Jwt).await.map(|_| ())
    }
    /// `GET /api/auth/me` [jwt].
    pub async fn me(&self) -> Result<MeResponse> {
        self.http.get("/api/auth/me", AuthMode::Jwt).await
    }
}

// =================================================================== walletAuth (4)

/// EIP-191 wallet sign-in.
#[derive(Debug, Clone)]
pub struct WalletAuthResource {
    http: Http,
    creds: Arc<Credentials>,
}
impl WalletAuthResource {
    pub(crate) fn new(http: Http, creds: Arc<Credentials>) -> Self {
        Self { http, creds }
    }
    /// `POST /api/auth/wallet/challenge` [none].
    pub async fn challenge(&self, address: &str) -> Result<WalletChallenge> {
        validate_address(address, "address")?;
        self.http.post("/api/auth/wallet/challenge", json!({ "address": address }), AuthMode::None).await
    }
    /// `POST /api/auth/wallet/verify` [none]. Stores the JWT pair unless MFA is required.
    pub async fn verify(&self, address: &str, signature: &str) -> Result<WalletVerifyResult> {
        validate_address(address, "address")?;
        validate_signature(signature, "signature")?;
        let r: WalletVerifyResult = self
            .http
            .post("/api/auth/wallet/verify", json!({ "address": address, "signature": signature }), AuthMode::None)
            .await?;
        if r.mfa_required == Some(true) {
            return Ok(WalletVerifyResult {
                mfa_required: Some(true),
                mfa_challenge_token: r.mfa_challenge_token,
                ..Default::default()
            });
        }
        if let (Some(t), Some(rt)) = (&r.token, &r.refresh_token) {
            self.creds.tokens.set_tokens(t, Some(rt));
        }
        Ok(r)
    }
    /// challenge -> sign -> verify. Refuses if the challenge does not name the signer's address.
    pub async fn sign_in(&self, signer: &dyn Signer) -> Result<WalletVerifyResult> {
        assert_signer(signer, "signer")?;
        let ch = self.challenge(signer.address()).await?;
        if !ch.message.to_lowercase().contains(&signer.address().to_lowercase()) {
            return Err(DominusNodeError::protocol("wallet challenge does not name the signer's address; refusing to sign"));
        }
        let sig = sign(signer, &ch.message, "signer").await?;
        self.verify(signer.address(), &sig).await
    }
    /// `POST /api/auth/wallet/link` [jwt].
    pub async fn link(&self, address: &str, signature: &str) -> Result<WalletLinkResult> {
        validate_address(address, "address")?;
        validate_signature(signature, "signature")?;
        self.http
            .post("/api/auth/wallet/link", json!({ "address": address, "signature": signature }), AuthMode::Jwt)
            .await
    }
}

// =================================================================== keys (3)

/// API keys.
#[derive(Debug, Clone)]
pub struct KeysResource {
    http: Http,
}
impl KeysResource {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }
    /// `POST /api/keys` [jwt]; label defaults to `Default`.
    pub async fn create(&self, label: Option<&str>) -> Result<CreatedApiKey> {
        let label = label.unwrap_or("Default");
        validate_non_empty(label, "label", 100)?;
        self.http.post("/api/keys", json!({ "label": label }), AuthMode::Jwt).await
    }
    /// `GET /api/keys` [jwt].
    pub async fn list(&self) -> Result<ApiKeyList> {
        self.http.get("/api/keys", AuthMode::Jwt).await
    }
    /// `DELETE /api/keys/{id}` [jwt].
    pub async fn revoke(&self, id: &str) -> Result<()> {
        validate_non_empty(id, "id", 256)?;
        self.http.delete::<Value>(&format!("/api/keys/{}", encode_uri_component(id)), AuthMode::Jwt).await.map(|_| ())
    }
}

// =================================================================== wallet (5)

/// Crypto currencies accepted by `top_up_crypto`.
pub const CRYPTO_CURRENCIES: [&str; 11] = ["btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb", "link"];

/// Requester prepaid wallet (cents).
#[derive(Debug, Clone)]
pub struct WalletResource {
    http: Http,
}
impl WalletResource {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }
    /// `GET /api/wallet` [jwt].
    pub async fn get_balance(&self) -> Result<WalletBalance> {
        self.http.get("/api/wallet", AuthMode::Jwt).await
    }
    /// `GET /api/wallet/transactions` [jwt].
    pub async fn get_transactions(&self, limit: Option<u32>, offset: Option<u32>) -> Result<WalletTransactions> {
        let q = qs(&[("limit", opt(limit)), ("offset", opt(offset))]);
        self.http.get(&format!("/api/wallet/transactions{q}"), AuthMode::Jwt).await
    }
    /// `GET /api/wallet/forecast` [jwt].
    pub async fn get_forecast(&self) -> Result<Forecast> {
        self.http.get("/api/wallet/forecast", AuthMode::Jwt).await
    }
    /// `POST /api/wallet/topup/crypto` [jwt]; 1000..100000 cents.
    pub async fn top_up_crypto(&self, amount_cents: i64, currency: &str) -> Result<CryptoInvoice> {
        validate_cents(amount_cents, "amountCents", false)?;
        if !(1000..=100_000).contains(&amount_cents) {
            return Err(DominusNodeError::invalid_arg("crypto top-up must be between 1000 and 100000 cents ($10-$1,000)"));
        }
        let c = currency.to_lowercase();
        if !CRYPTO_CURRENCIES.contains(&c.as_str()) {
            return Err(DominusNodeError::invalid_arg(format!("currency must be one of {}", CRYPTO_CURRENCIES.join(", "))));
        }
        let amount_usd = amount_cents as f64 / 100.0;
        self.http.post("/api/wallet/topup/crypto", json!({ "amountUsd": amount_usd, "currency": c }), AuthMode::Jwt).await
    }
    /// `GET /api/wallet/crypto/status/{invoiceId}` [jwt].
    pub async fn get_crypto_status(&self, invoice_id: &str) -> Result<CryptoInvoiceStatus> {
        validate_uuid(invoice_id, "invoiceId")?;
        self.http.get(&format!("/api/wallet/crypto/status/{}", encode_uri_component(invoice_id)), AuthMode::Jwt).await
    }
}

// =================================================================== agenticWallets (9)

/// Agentic sub-wallets (`/api/agent-wallet`, jwt).
#[derive(Debug, Clone)]
pub struct AgenticWalletResource {
    http: Http,
}
impl AgenticWalletResource {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }
    fn p(id: &str, rest: &str) -> String {
        format!("/api/agent-wallet/{}{rest}", encode_uri_component(id))
    }
    /// `POST /api/agent-wallet`; spending limit defaults to 10000 cents.
    pub async fn create(
        &self,
        label: &str,
        spending_limit_cents: Option<i64>,
        daily_limit_cents: Option<i64>,
        allowed_domains: Option<Vec<String>>,
    ) -> Result<AgenticWallet> {
        let spending = validate_cents(spending_limit_cents.unwrap_or(10_000), "spendingLimitCents", true)?;
        let mut body = Map::new();
        body.insert("label".into(), json!(label));
        body.insert("spendingLimitCents".into(), json!(spending));
        if let Some(d) = daily_limit_cents {
            body.insert("dailyLimitCents".into(), json!(validate_cents(d, "dailyLimitCents", true)?));
        }
        if let Some(a) = allowed_domains {
            body.insert("allowedDomains".into(), json!(a));
        }
        self.http.post("/api/agent-wallet", Value::Object(body), AuthMode::Jwt).await
    }
    /// `GET /api/agent-wallet`.
    pub async fn list(&self) -> Result<AgenticWalletList> {
        self.http.get("/api/agent-wallet", AuthMode::Jwt).await
    }
    /// `GET /api/agent-wallet/{id}`.
    pub async fn get(&self, wallet_id: &str) -> Result<AgenticWallet> {
        self.http.get(&Self::p(wallet_id, ""), AuthMode::Jwt).await
    }
    /// `POST /api/agent-wallet/{id}/fund`.
    pub async fn fund(&self, wallet_id: &str, amount_cents: i64) -> Result<AgenticWalletFund> {
        validate_cents(amount_cents, "amountCents", false)?;
        self.http.post(&Self::p(wallet_id, "/fund"), json!({ "amountCents": amount_cents }), AuthMode::Jwt).await
    }
    /// `PATCH /api/agent-wallet/{id}/policy`.
    pub async fn update_wallet_policy(&self, wallet_id: &str, policy: &AgenticWalletPolicy) -> Result<AgenticWallet> {
        if let Some(Some(d)) = policy.daily_limit_cents {
            validate_cents(d, "dailyLimitCents", true)?;
        }
        let body = serde_json::to_value(policy).expect("policy serializes");
        self.http.patch(&Self::p(wallet_id, "/policy"), body, AuthMode::Jwt).await
    }
    /// `GET /api/agent-wallet/{id}/transactions`.
    pub async fn transactions(&self, wallet_id: &str, limit: Option<u32>, offset: Option<u32>) -> Result<AgenticWalletTransactions> {
        let q = qs(&[("limit", opt(limit)), ("offset", opt(offset))]);
        self.http.get(&Self::p(wallet_id, &format!("/transactions{q}")), AuthMode::Jwt).await
    }
    /// `POST /api/agent-wallet/{id}/freeze`.
    pub async fn freeze(&self, wallet_id: &str) -> Result<AgenticWallet> {
        self.http.post(&Self::p(wallet_id, "/freeze"), json!({}), AuthMode::Jwt).await
    }
    /// `POST /api/agent-wallet/{id}/unfreeze`.
    pub async fn unfreeze(&self, wallet_id: &str) -> Result<AgenticWallet> {
        self.http.post(&Self::p(wallet_id, "/unfreeze"), json!({}), AuthMode::Jwt).await
    }
    /// `DELETE /api/agent-wallet/{id}`.
    pub async fn delete(&self, wallet_id: &str) -> Result<AgenticWalletDelete> {
        self.http.delete(&Self::p(wallet_id, ""), AuthMode::Jwt).await
    }
}

// =================================================================== teams (18)

/// Teams (`/api/teams`, jwt).
#[derive(Debug, Clone)]
pub struct TeamsResource {
    http: Http,
}
impl TeamsResource {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }
    fn p(team_id: &str, rest: &str) -> String {
        format!("/api/teams/{}{rest}", encode_uri_component(team_id))
    }
    fn email_role(email: &str, role: Option<&str>) -> Value {
        let mut b = Map::new();
        b.insert("email".into(), json!(email));
        if let Some(r) = role {
            b.insert("role".into(), json!(r));
        }
        Value::Object(b)
    }
    /// `POST /api/teams`.
    pub async fn create(&self, name: &str, max_members: Option<i64>) -> Result<Team> {
        let mut b = Map::new();
        b.insert("name".into(), json!(name));
        if let Some(m) = max_members {
            b.insert("maxMembers".into(), json!(m));
        }
        self.http.post("/api/teams", Value::Object(b), AuthMode::Jwt).await
    }
    /// `GET /api/teams`.
    pub async fn list(&self) -> Result<TeamList> {
        self.http.get("/api/teams", AuthMode::Jwt).await
    }
    /// `GET /api/teams/{id}`.
    pub async fn get(&self, team_id: &str) -> Result<Team> {
        self.http.get(&Self::p(team_id, ""), AuthMode::Jwt).await
    }
    /// `PATCH /api/teams/{id}`.
    pub async fn update(&self, team_id: &str, update: &TeamUpdate) -> Result<Team> {
        self.http.patch(&Self::p(team_id, ""), serde_json::to_value(update).expect("serializes"), AuthMode::Jwt).await
    }
    /// `DELETE /api/teams/{id}`.
    pub async fn delete(&self, team_id: &str) -> Result<TeamDelete> {
        self.http.delete(&Self::p(team_id, ""), AuthMode::Jwt).await
    }
    /// `POST /api/teams/{id}/wallet/fund`.
    pub async fn fund_wallet(&self, team_id: &str, amount_cents: i64) -> Result<TeamFund> {
        validate_cents(amount_cents, "amountCents", false)?;
        self.http.post(&Self::p(team_id, "/wallet/fund"), json!({ "amountCents": amount_cents }), AuthMode::Jwt).await
    }
    /// `GET /api/teams/{id}/wallet/transactions`.
    pub async fn get_transactions(&self, team_id: &str, limit: Option<u32>, offset: Option<u32>) -> Result<TeamTransactions> {
        let q = qs(&[("limit", opt(limit)), ("offset", opt(offset))]);
        self.http.get(&Self::p(team_id, &format!("/wallet/transactions{q}")), AuthMode::Jwt).await
    }
    /// `GET /api/teams/{id}/members`.
    pub async fn list_members(&self, team_id: &str) -> Result<TeamMembers> {
        self.http.get(&Self::p(team_id, "/members"), AuthMode::Jwt).await
    }
    /// `POST /api/teams/{id}/members`.
    pub async fn add_member(&self, team_id: &str, email: &str, role: Option<&str>) -> Result<TeamMember> {
        self.http.post(&Self::p(team_id, "/members"), Self::email_role(email, role), AuthMode::Jwt).await
    }
    /// `PATCH /api/teams/{id}/members/{userId}`.
    pub async fn update_member_role(&self, team_id: &str, user_id: &str, role: &str) -> Result<TeamMember> {
        let path = Self::p(team_id, &format!("/members/{}", encode_uri_component(user_id)));
        self.http.patch(&path, json!({ "role": role }), AuthMode::Jwt).await
    }
    /// `DELETE /api/teams/{id}/members/{userId}`.
    pub async fn remove_member(&self, team_id: &str, user_id: &str) -> Result<()> {
        let path = Self::p(team_id, &format!("/members/{}", encode_uri_component(user_id)));
        self.http.delete::<Value>(&path, AuthMode::Jwt).await.map(|_| ())
    }
    /// `POST /api/teams/{id}/invites`.
    pub async fn create_invite(&self, team_id: &str, email: &str, role: Option<&str>) -> Result<TeamInvite> {
        self.http.post(&Self::p(team_id, "/invites"), Self::email_role(email, role), AuthMode::Jwt).await
    }
    /// `GET /api/teams/{id}/invites`.
    pub async fn list_invites(&self, team_id: &str) -> Result<TeamInvites> {
        self.http.get(&Self::p(team_id, "/invites"), AuthMode::Jwt).await
    }
    /// `DELETE /api/teams/{id}/invites/{inviteId}`.
    pub async fn cancel_invite(&self, team_id: &str, invite_id: &str) -> Result<()> {
        let path = Self::p(team_id, &format!("/invites/{}", encode_uri_component(invite_id)));
        self.http.delete::<Value>(&path, AuthMode::Jwt).await.map(|_| ())
    }
    /// `POST /api/teams/invites/{token}/accept`.
    pub async fn accept_invite(&self, token: &str) -> Result<TeamMember> {
        let path = format!("/api/teams/invites/{}/accept", encode_uri_component(token));
        self.http.post(&path, json!({}), AuthMode::Jwt).await
    }
    /// `POST /api/teams/{id}/keys`; label 1..100.
    pub async fn create_key(&self, team_id: &str, label: &str) -> Result<TeamKeyCreated> {
        validate_non_empty(label, "label", 100)?;
        self.http.post(&Self::p(team_id, "/keys"), json!({ "label": label }), AuthMode::Jwt).await
    }
    /// `GET /api/teams/{id}/keys`.
    pub async fn list_keys(&self, team_id: &str) -> Result<TeamKeys> {
        self.http.get(&Self::p(team_id, "/keys"), AuthMode::Jwt).await
    }
    /// `DELETE /api/teams/{id}/keys/{keyId}`.
    pub async fn revoke_key(&self, team_id: &str, key_id: &str) -> Result<()> {
        let path = Self::p(team_id, &format!("/keys/{}", encode_uri_component(key_id)));
        self.http.delete::<Value>(&path, AuthMode::Jwt).await.map(|_| ())
    }
}

// =================================================================== usage (4)

/// Usage history (jwt). `from` -> `since`, `to` -> `until`.
#[derive(Debug, Clone)]
pub struct UsageResource {
    http: Http,
}
impl UsageResource {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }
    /// `GET /api/usage`.
    pub async fn get(&self, from: Option<&str>, to: Option<&str>, limit: Option<u32>, offset: Option<u32>) -> Result<UsageResponse> {
        let q = qs(&[("since", opt(from)), ("until", opt(to)), ("limit", opt(limit)), ("offset", opt(offset))]);
        self.http.get(&format!("/api/usage{q}"), AuthMode::Jwt).await
    }
    /// `GET /api/usage/daily`.
    pub async fn get_daily(&self, from: Option<&str>, to: Option<&str>) -> Result<DailyUsageResponse> {
        let q = qs(&[("since", opt(from)), ("until", opt(to))]);
        self.http.get(&format!("/api/usage/daily{q}"), AuthMode::Jwt).await
    }
    /// `GET /api/usage/top-hosts`.
    pub async fn get_top_hosts(&self, from: Option<&str>, to: Option<&str>, limit: Option<u32>) -> Result<TopHostsResponse> {
        let q = qs(&[("since", opt(from)), ("until", opt(to)), ("limit", opt(limit))]);
        self.http.get(&format!("/api/usage/top-hosts{q}"), AuthMode::Jwt).await
    }
    /// `GET /api/usage/export` -> raw CSV.
    pub async fn export_csv(&self, from: Option<&str>, to: Option<&str>) -> Result<String> {
        let q = qs(&[("since", opt(from)), ("until", opt(to))]);
        self.http.request_text("GET", &format!("/api/usage/export{q}"), None, AuthMode::Jwt, &[]).await
    }
}

// =================================================================== sessions (2)

/// Allowed `report` reasons.
pub const REPORT_REASONS: [&str; 6] = ["blocked", "captcha", "rate_limited", "slow", "bad_content", "other"];

/// Proxy sessions.
#[derive(Debug, Clone)]
pub struct SessionsResource {
    http: Http,
}
impl SessionsResource {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }
    /// `GET /api/sessions/active` [jwt]. Only `id`, `startedAt`, `status` are kept.
    pub async fn get_active(&self) -> Result<ActiveSessions> {
        let v: Value = self.http.get("/api/sessions/active", AuthMode::Jwt).await?;
        let s = |x: &Value, k: &str| match x.get(k) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => String::new(),
            Some(o) => o.to_string(),
        };
        let sessions = v
            .get("sessions")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|x| ActiveSession { id: s(x, "id"), started_at: s(x, "startedAt"), status: s(x, "status") })
                    .collect()
            })
            .unwrap_or_default();
        Ok(ActiveSessions { sessions })
    }
    /// `POST /v1/sessions/{id}/report` [agent].
    pub async fn report(&self, session_id: &str, reason: &str) -> Result<ReportResult> {
        validate_uuid(session_id, "sessionId")?;
        if !REPORT_REASONS.contains(&reason) {
            return Err(DominusNodeError::invalid_arg(format!("reason must be one of {}", REPORT_REASONS.join(", "))));
        }
        let path = format!("/v1/sessions/{}/report", encode_uri_component(session_id));
        self.http.post(&path, json!({ "reason": reason }), AuthMode::Agent).await
    }
}

// =================================================================== x402 (1)

/// x402 protocol info.
#[derive(Debug, Clone)]
pub struct X402Resource {
    http: Http,
}
impl X402Resource {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }
    /// `GET /api/x402/info` [none].
    pub async fn get_info(&self) -> Result<X402Info> {
        self.http.get("/api/x402/info", AuthMode::None).await
    }
}

// =================================================================== network (3)

/// Public relay-network info.
#[derive(Debug, Clone)]
pub struct NetworkResource {
    http: Http,
}
impl NetworkResource {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }
    /// `GET /v1/policy` [none].
    pub async fn policy(&self) -> Result<NetworkPolicy> {
        self.http.get("/v1/policy", AuthMode::None).await
    }
    /// `GET /v1/pricing` [none].
    pub async fn pricing(&self) -> Result<NetworkPricing> {
        self.http.get("/v1/pricing", AuthMode::None).await
    }
    /// `GET /v1/network/stats` [none].
    pub async fn stats(&self) -> Result<NetworkStats> {
        self.http.get("/v1/network/stats", AuthMode::None).await
    }
}

// =================================================================== nodes (6)

/// Options for [`NodesResource::register`].
pub struct RegisterNodeOptions<'a> {
    /// Signer for the account's LINKED wallet.
    pub signer: &'a dyn Signer,
    /// ed25519 public key, 64 hex.
    pub node_pubkey: Option<String>,
    /// Pre-fetched challenge (same pubkey).
    pub challenge: Option<NodeChallenge>,
    /// 1..1024.
    pub max_streams: Option<i64>,
    /// 1..10000.
    pub max_gb_day: Option<i64>,
    /// PoW search cap (default 200,000,000).
    pub max_pow_iterations: Option<u64>,
}
impl<'a> RegisterNodeOptions<'a> {
    /// Options with only a signer.
    pub fn new(signer: &'a dyn Signer) -> Self {
        Self { signer, node_pubkey: None, challenge: None, max_streams: None, max_gb_day: None, max_pow_iterations: None }
    }
}

fn norm_pubkey(v: Option<&str>) -> Result<Option<String>> {
    match v {
        None => Ok(None),
        Some(k) => {
            let k = k.to_lowercase();
            if is_hex64_lower(&k) {
                Ok(Some(k))
            } else {
                Err(DominusNodeError::invalid_arg("nodePubkey must be 64 hex characters (32-byte ed25519 public key)"))
            }
        }
    }
}

fn check_challenge(ch: &NodeChallenge) -> Result<()> {
    if !is_hex64_lower(&ch.nonce) {
        return Err(DominusNodeError::protocol("invalid challenge nonce"));
    }
    if ch.attestation_text.is_empty() || ch.attestation_text.len() > 64 * 1024 {
        return Err(DominusNodeError::protocol("invalid attestation text"));
    }
    if !(1..=100_000).contains(&ch.attestation_version) {
        return Err(DominusNodeError::protocol("invalid attestation version"));
    }
    if !is_uuid(&ch.pow_challenge.challenge_id) {
        return Err(DominusNodeError::protocol("invalid PoW challenge"));
    }
    Ok(())
}

/// Relay nodes you own (agent auth).
#[derive(Debug, Clone)]
pub struct NodesResource {
    http: Http,
}
impl NodesResource {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }
    /// `POST /v1/nodes/challenge`.
    pub async fn register_challenge(&self, node_pubkey: Option<&str>) -> Result<NodeChallenge> {
        let body = match norm_pubkey(node_pubkey)? {
            Some(k) => json!({ "nodePubkey": k }),
            None => json!({}),
        };
        let v: Value = self.http.post("/v1/nodes/challenge", body, AuthMode::Agent).await?;
        serde_json::from_value(v).map_err(|_| DominusNodeError::protocol("invalid node challenge"))
    }

    /// Full registration: challenge -> rebuild attestation (refuse on mismatch) -> PoW -> sign -> `POST /v1/nodes`.
    pub async fn register(&self, opts: RegisterNodeOptions<'_>) -> Result<RegisteredNode> {
        let signer = opts.signer;
        assert_signer(signer, "signer")?;
        let pubkey = norm_pubkey(opts.node_pubkey.as_deref())?;
        if let Some(v) = opts.max_streams {
            validate_int_range(v, "maxStreams", 1, 1024)?;
        }
        if let Some(v) = opts.max_gb_day {
            validate_int_range(v, "maxGbDay", 1, 10_000)?;
        }
        let ch = match opts.challenge {
            Some(c) => c,
            None => self.register_challenge(pubkey.as_deref()).await?,
        };
        check_challenge(&ch)?;
        let message =
            build_attestation_message(signer.address(), &ch.nonce, ch.attestation_version, &ch.attestation_text, pubkey.as_deref());
        assert_same_message(&ch.message, &message, "node attestation")?;
        let pow = solve_pow(&ch.pow_challenge.prefix, ch.pow_challenge.difficulty, opts.max_pow_iterations.unwrap_or(200_000_000))?;
        let wallet_signature = sign(signer, &message, "signer").await?;

        let mut body = Map::new();
        body.insert("nonce".into(), json!(ch.nonce));
        body.insert("walletSignature".into(), json!(wallet_signature));
        body.insert("attestationVersion".into(), json!(ch.attestation_version));
        body.insert("pow".into(), json!({ "challengeId": ch.pow_challenge.challenge_id, "nonce": pow }));
        if let Some(k) = &pubkey {
            body.insert("nodePubkey".into(), json!(k));
        }
        if let Some(v) = opts.max_streams {
            body.insert("maxStreams".into(), json!(v));
        }
        if let Some(v) = opts.max_gb_day {
            body.insert("maxGbDay".into(), json!(v));
        }
        let r: Value = self.http.post("/v1/nodes", Value::Object(body), AuthMode::Agent).await?;
        let node_id = r.get("nodeId").and_then(Value::as_str).unwrap_or("");
        if !is_uuid(node_id) {
            return Err(DominusNodeError::protocol("invalid nodeId in response"));
        }
        let key = r.get("nodeKey").and_then(Value::as_str).unwrap_or("");
        if !key.strip_prefix("dn_node_").is_some_and(is_hex64_lower) {
            return Err(DominusNodeError::protocol("invalid node key in response"));
        }
        Ok(RegisteredNode {
            node_id: node_id.to_string(),
            status: match r.get("status") {
                Some(Value::String(s)) => s.clone(),
                Some(o) => o.to_string(),
                None => String::new(),
            },
            attestation_version: r.get("attestationVersion").and_then(Value::as_i64).unwrap_or(ch.attestation_version),
            node_key: Secret::new(key),
        })
    }

    /// `GET /v1/nodes`; limit 1..500, offset 0..1,000,000.
    pub async fn list(&self, limit: Option<i64>, offset: Option<i64>) -> Result<NodeList> {
        if let Some(l) = limit {
            validate_int_range(l, "limit", 1, 500)?;
        }
        if let Some(o) = offset {
            validate_int_range(o, "offset", 0, 1_000_000)?;
        }
        let q = qs(&[("limit", opt(limit)), ("offset", opt(offset))]);
        self.http.get(&format!("/v1/nodes{q}"), AuthMode::Agent).await
    }
    /// `DELETE /v1/nodes/{id}`.
    pub async fn revoke(&self, node_id: &str) -> Result<NodeRevoked> {
        validate_uuid(node_id, "nodeId")?;
        self.http.delete(&format!("/v1/nodes/{}", encode_uri_component(node_id)), AuthMode::Agent).await
    }
    /// `PATCH /v1/nodes/{id}` with only the present caps.
    pub async fn update_caps(&self, node_id: &str, caps: &NodeCaps) -> Result<UpdateCapsResult> {
        validate_uuid(node_id, "nodeId")?;
        let mut body = Map::new();
        for (k, v) in [("maxStreams", caps.max_streams), ("gbPerDay", caps.gb_per_day), ("reqPerSec", caps.req_per_sec)] {
            if let Some(v) = v {
                body.insert(k.into(), json!(validate_int_range(v, k, 1, 1_000_000)?));
            }
        }
        if body.is_empty() {
            return Err(DominusNodeError::invalid_arg("updateCaps needs at least one of maxStreams, gbPerDay, reqPerSec"));
        }
        self.http.patch(&format!("/v1/nodes/{}", encode_uri_component(node_id)), Value::Object(body), AuthMode::Agent).await
    }
    /// `GET /v1/node/tier`.
    pub async fn tier(&self) -> Result<NodeTier> {
        self.http.get("/v1/node/tier", AuthMode::Agent).await
    }
}

// =================================================================== credits (4)

/// Credit transaction types.
pub const CREDIT_TX_TYPES: [&str; 6] = ["earn", "mature", "clawback", "convert", "withdraw", "withdraw_reversal"];
/// Convert bounds (µUSD).
pub const MIN_CONVERT_MUSD: i128 = 10_000;
/// Convert upper bound (µUSD).
pub const MAX_CONVERT_MUSD: i128 = 10_000_000_000;
/// Withdraw lower bound (µUSD).
pub const MIN_WITHDRAW_MUSD: i128 = 1_000_000;
/// Withdraw upper bound (µUSD).
pub const MAX_WITHDRAW_MUSD: i128 = 100_000_000_000;

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct SignChallenge {
    nonce: String,
    message: String,
    signer: String,
    #[serde(rename = "oldWalletSignatureRequired")]
    old_wallet_signature_required: bool,
    #[serde(rename = "oldWalletAddress")]
    old_wallet_address: Option<String>,
}

fn check_sign_challenge(ch: &SignChallenge, signer: &dyn Signer) -> Result<()> {
    if !is_hex64_lower(&ch.nonce) {
        return Err(DominusNodeError::protocol("invalid challenge nonce"));
    }
    if ch.signer.to_lowercase() != signer.address().to_lowercase() {
        return Err(DominusNodeError::protocol("the account's linked wallet is not the signer's address; refusing to sign"));
    }
    Ok(())
}

/// Node-operator earnings (µUSD, agent auth).
#[derive(Debug, Clone)]
pub struct CreditsResource {
    http: Http,
}
impl CreditsResource {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }
    /// `GET /v1/credits`.
    pub async fn balance(&self) -> Result<CreditsBalance> {
        self.http.get("/v1/credits", AuthMode::Agent).await
    }
    /// `GET /v1/credits/transactions`.
    pub async fn transactions(&self, limit: Option<i64>, cursor: Option<&str>, tx_type: Option<&str>) -> Result<CreditTransactions> {
        if let Some(l) = limit {
            validate_int_range(l, "limit", 1, 200)?;
        }
        if let Some(c) = cursor {
            if c.is_empty() || c.len() > 20 || !c.bytes().all(|b| b.is_ascii_digit()) {
                return Err(DominusNodeError::invalid_arg("cursor must be a nextCursor value"));
            }
        }
        if let Some(t) = tx_type {
            if !CREDIT_TX_TYPES.contains(&t) {
                return Err(DominusNodeError::invalid_arg(format!("type must be one of {}", CREDIT_TX_TYPES.join(", "))));
            }
        }
        let q = qs(&[("limit", opt(limit)), ("cursor", opt(cursor)), ("type", opt(tx_type))]);
        self.http.get(&format!("/v1/credits/transactions{q}"), AuthMode::Agent).await
    }
    /// `POST /v1/credits/convert` with `Idempotency-Key`.
    pub async fn convert(&self, amount_musd: impl Into<Musd>, idempotency_key: Option<&str>) -> Result<ConvertResult> {
        let amount = to_musd(amount_musd.into(), MIN_CONVERT_MUSD, MAX_CONVERT_MUSD)?;
        let key = idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key);
        validate_idempotency_key(&key)?;
        let mut r: ConvertResult = self
            .http
            .request(
                "POST",
                "/v1/credits/convert",
                Some(json!({ "amountMusd": amount })),
                AuthMode::Agent,
                &[("Idempotency-Key".to_string(), key.clone())],
            )
            .await?;
        r.idempotency_key = key;
        Ok(r)
    }
    /// Withdraw: challenge -> rebuild message (refuse on mismatch) -> sign -> `POST /v1/credits/withdraw`.
    pub async fn withdraw(&self, amount_musd: impl Into<Musd>, signer: &dyn Signer, idempotency_key: Option<&str>) -> Result<WithdrawResult> {
        assert_signer(signer, "signer")?;
        let amount = to_musd(amount_musd.into(), MIN_WITHDRAW_MUSD, MAX_WITHDRAW_MUSD)?;
        let key = idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key);
        validate_idempotency_key(&key)?;
        let ch: SignChallenge = self
            .http
            .post("/v1/credits/withdraw/challenge", json!({ "amountMusd": amount, "idempotencyKey": key }), AuthMode::Agent)
            .await?;
        check_sign_challenge(&ch, signer)?;
        let user_id = extract_user_id(&ch.message)?;
        let local = build_withdraw_message(&user_id, signer.address(), &amount, &key, &ch.nonce);
        assert_same_message(&ch.message, &local, "withdrawal")?;
        let signature = sign(signer, &local, "signer").await?;
        let mut r: WithdrawResult = self
            .http
            .post(
                "/v1/credits/withdraw",
                json!({ "amountMusd": amount, "idempotencyKey": key, "nonce": ch.nonce, "signature": signature }),
                AuthMode::Agent,
            )
            .await?;
        r.idempotency_key = key;
        Ok(r)
    }
}

// =================================================================== payouts (1)

/// Payout history.
#[derive(Debug, Clone)]
pub struct PayoutsResource {
    http: Http,
}
impl PayoutsResource {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }
    /// `GET /v1/payouts`; limit 1..200, offset 0..1,000,000.
    pub async fn list(&self, limit: Option<i64>, offset: Option<i64>) -> Result<PayoutList> {
        if let Some(l) = limit {
            validate_int_range(l, "limit", 1, 200)?;
        }
        if let Some(o) = offset {
            validate_int_range(o, "offset", 0, 1_000_000)?;
        }
        let q = qs(&[("limit", opt(limit)), ("offset", opt(offset))]);
        self.http.get(&format!("/v1/payouts{q}"), AuthMode::Agent).await
    }
}

// =================================================================== payoutWallet (2)

/// Where withdrawals are sent (agent auth).
#[derive(Debug, Clone)]
pub struct PayoutWalletResource {
    http: Http,
}
impl PayoutWalletResource {
    pub(crate) fn new(http: Http) -> Self {
        Self { http }
    }
    /// `GET /v1/payout-wallet`.
    pub async fn get(&self) -> Result<PayoutWalletState> {
        self.http.get("/v1/payout-wallet", AuthMode::Agent).await
    }
    /// Register or change the payout wallet (challenge -> rebuild/compare -> sign(s) -> PUT).
    /// `chain` defaults to `base`; `old_wallet_signer` is needed when the server requires it.
    pub async fn set(
        &self,
        address: &str,
        signer: &dyn Signer,
        chain: Option<&str>,
        old_wallet_signer: Option<&dyn Signer>,
    ) -> Result<SetPayoutWalletResult> {
        assert_signer(signer, "signer")?;
        validate_address(address, "address")?;
        let address = address.to_lowercase();
        let chain = chain.unwrap_or("base");
        if chain != "base" {
            return Err(DominusNodeError::invalid_arg("chain must be 'base'"));
        }
        if let Some(o) = old_wallet_signer {
            assert_signer(o, "oldWalletSigner")?;
        }
        let ch: SignChallenge = self
            .http
            .post("/v1/payout-wallet/challenge", json!({ "address": address, "chain": chain }), AuthMode::Agent)
            .await?;
        check_sign_challenge(&ch, signer)?;
        let user_id = extract_user_id(&ch.message)?;
        let local = build_payout_wallet_message(&user_id, signer.address(), &address, chain, &ch.nonce);
        assert_same_message(&ch.message, &local, "payout wallet")?;
        if ch.old_wallet_signature_required {
            let Some(o) = old_wallet_signer else {
                return Err(DominusNodeError::invalid_arg(format!(
                    "changing the payout wallet requires oldWalletSigner for {}",
                    ch.old_wallet_address.as_deref().unwrap_or("null")
                )));
            };
            if ch.old_wallet_address.as_deref().map(str::to_lowercase) != Some(o.address().to_lowercase()) {
                return Err(DominusNodeError::invalid_arg("oldWalletSigner.address is not the current payout wallet"));
            }
        }
        let signature = sign(signer, &local, "signer").await?;
        let mut body = Map::new();
        body.insert("address".into(), json!(address));
        body.insert("chain".into(), json!(chain));
        body.insert("nonce".into(), json!(ch.nonce));
        body.insert("signature".into(), json!(signature));
        if ch.old_wallet_signature_required {
            if let Some(o) = old_wallet_signer {
                body.insert("oldWalletSignature".into(), json!(sign(o, &local, "oldWalletSigner").await?));
            }
        }
        self.http.put("/v1/payout-wallet", Value::Object(body), AuthMode::Agent).await
    }
}
