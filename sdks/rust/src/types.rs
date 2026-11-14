//! Request/response types (SDK_SURFACE section 3). Unknown server fields are
//! ignored; missing fields take defaults.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::util::Secret;

macro_rules! model {
    ($(#[$m:meta])* pub struct $name:ident { $($(#[$fm:meta])* pub $f:ident : $t:ty),* $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        #[non_exhaustive]
        pub struct $name { $($(#[$fm])* pub $f: $t),* }
    };
}

model! {
    /// Server money object: integer µUSD and 6-decimal USD, both strings.
    pub struct Money { pub musd: String, pub usd: String }
}

model! {
    /// Result of `connect_with_key`.
    pub struct ConnectResult { pub mfa_required: bool, pub user_id: Option<String> }
}

// ---- auth
model! {
    /// `POST /api/auth/verify-key`.
    pub struct VerifyKeyResponse {
        pub valid: bool, pub token: String, pub refresh_token: String, pub user_id: String, pub email: String,
    }
}
model! {
    /// `POST /api/auth/refresh`.
    pub struct RefreshResponse { pub token: String, pub refresh_token: Option<String> }
}
/// Account user (snake_case as the server sends it).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct User {
    /// User id.
    pub id: String,
    /// Email (may be empty for wallet accounts).
    pub email: Option<String>,
    /// Linked wallet.
    pub wallet_address: Option<String>,
    /// Email verified flag.
    pub email_verified: Option<bool>,
    /// Other fields.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
model! {
    /// `GET /api/auth/me`.
    pub struct MeResponse { pub user: User }
}

// ---- wallet auth
model! {
    /// `POST /api/auth/wallet/challenge`.
    pub struct WalletChallenge { pub message: String, pub nonce: String, pub challenge: String, pub expires_at: String }
}
model! {
    /// `POST /api/auth/wallet/verify`. When `mfa_required`, nothing is stored.
    pub struct WalletVerifyResult {
        pub token: Option<String>, pub refresh_token: Option<String>, pub user: Option<User>,
        pub mfa_required: Option<bool>, pub mfa_challenge_token: Option<String>,
    }
}
model! {
    /// `POST /api/auth/wallet/link`.
    pub struct WalletLinkResult { pub success: bool, pub wallet_address: String }
}

// ---- keys
/// API key metadata (snake_case as the server sends it).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ApiKeyInfo {
    /// Id.
    pub id: String,
    /// First characters.
    pub prefix: String,
    /// Label.
    pub label: String,
    /// Creation time.
    pub created_at: String,
    /// Revocation time.
    pub revoked_at: Option<String>,
}
/// Newly created API key; `key` is returned once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreatedApiKey {
    /// Id.
    #[serde(default)]
    pub id: String,
    /// Prefix.
    #[serde(default)]
    pub prefix: String,
    /// Label.
    #[serde(default)]
    pub label: String,
    /// Creation time.
    #[serde(default)]
    pub created_at: String,
    /// The raw key (redacted when printed).
    pub key: Secret,
}
model! {
    /// `GET /api/keys`.
    pub struct ApiKeyList { pub keys: Vec<ApiKeyInfo> }
}

// ---- wallet
model! {
    /// `GET /api/wallet`.
    pub struct WalletBalance { pub balance_cents: i64, pub balance_usd: f64, pub currency: String, pub last_topped_up: Option<String> }
}
model! {
    /// `GET /v1/wallet` (raw API key).
    pub struct AgentWalletBalance { pub balance_cents: i64, pub currency: String, pub last_topped_up: Option<String> }
}
model! {
    /// Wallet transaction.
    pub struct WalletTransaction {
        pub id: String, pub r#type: String, pub amount_cents: i64, pub amount_usd: f64,
        pub description: String, pub payment_provider: Option<String>, pub created_at: String,
    }
}
model! {
    /// `GET /api/wallet/transactions`.
    pub struct WalletTransactions { pub transactions: Vec<WalletTransaction> }
}
model! {
    /// `GET /api/wallet/forecast`.
    pub struct Forecast { pub daily_avg_cents: f64, pub days_remaining: Option<f64>, pub trend: String, pub trend_pct: f64 }
}
model! {
    /// `POST /api/wallet/topup/crypto`.
    pub struct CryptoInvoice { pub invoice_id: String, pub invoice_url: String, pub pay_currency: String, pub price_amount: f64 }
}
model! {
    /// `GET /api/wallet/crypto/status/{id}`.
    pub struct CryptoInvoiceStatus { pub invoice_id: String, pub status: String, pub amount_cents: i64, pub provider: String, pub created_at: String }
}

// ---- agentic wallets
model! {
    /// Agentic sub-wallet.
    pub struct AgenticWallet {
        pub id: String, pub label: String, pub balance_cents: i64, pub spending_limit_cents: i64,
        pub daily_limit_cents: Option<i64>, pub allowed_domains: Option<Vec<String>>, pub status: String, pub created_at: String,
    }
}
model! {
    /// Agentic wallet transaction.
    pub struct AgenticWalletTransaction {
        pub id: String, pub wallet_id: String, pub r#type: String, pub amount_cents: i64,
        pub description: String, pub session_id: Option<String>, pub created_at: String,
    }
}
model! {
    /// `GET /api/agent-wallet`.
    pub struct AgenticWalletList { pub wallets: Vec<AgenticWallet> }
}
model! {
    /// `POST /api/agent-wallet/{id}/fund`.
    pub struct AgenticWalletFund { pub transaction: AgenticWalletTransaction }
}
model! {
    /// `GET /api/agent-wallet/{id}/transactions`.
    pub struct AgenticWalletTransactions { pub transactions: Vec<AgenticWalletTransaction> }
}
model! {
    /// `DELETE /api/agent-wallet/{id}`.
    pub struct AgenticWalletDelete { pub deleted: bool, pub refunded_cents: i64 }
}
/// Policy patch. `Some(None)` sends JSON `null` (clears the limit).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgenticWalletPolicy {
    /// Daily limit in cents (>= 0).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daily_limit_cents: Option<Option<i64>>,
    /// Allowed domains.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_domains: Option<Option<Vec<String>>>,
}

// ---- teams
model! {
    /// Team.
    pub struct Team {
        pub id: String, pub name: String, pub owner_id: String, pub max_members: i64,
        pub status: String, pub balance_cents: i64, pub created_at: String,
    }
}
model! {
    /// `GET /api/teams`.
    pub struct TeamList { pub teams: Vec<Team> }
}
model! {
    /// Team member.
    pub struct TeamMember { pub id: String, pub team_id: String, pub user_id: String, pub email: String, pub role: String, pub joined_at: String }
}
model! {
    /// Team invite.
    pub struct TeamInvite {
        pub id: String, pub team_id: String, pub email: String, pub role: String,
        /// Deprecated: never sent by the server (the token goes to the invitee); always empty.
        pub token: String, pub expires_at: String, pub created_at: String,
        /// User id of the member who sent the invite.
        pub invited_by: String,
    }
}
model! {
    /// Team API key metadata.
    pub struct TeamKey {
        pub id: String,
        /// Key prefix (server `prefix`; legacy `keyPrefix` accepted).
        #[serde(rename(serialize = "keyPrefix", deserialize = "prefix"), alias = "keyPrefix")] pub key_prefix: String,
        pub label: String, pub created_at: String,
        pub user_id: String, pub team_id: String, pub revoked_at: Option<String>,
    }
}
/// Newly created team key; `key` is returned once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamKeyCreated {
    /// Id.
    #[serde(default)]
    pub id: String,
    /// Prefix (server `prefix`; legacy `keyPrefix` accepted).
    #[serde(default, rename(serialize = "keyPrefix", deserialize = "prefix"), alias = "keyPrefix")]
    pub key_prefix: String,
    /// Creation time.
    #[serde(default)]
    pub created_at: String,
    /// Label.
    #[serde(default)]
    pub label: String,
    /// Raw key (redacted when printed).
    pub key: Secret,
}
model! {
    /// Team wallet transaction.
    pub struct TeamTransaction { pub id: String, pub team_id: String, pub r#type: String, pub amount_cents: i64, pub description: String, pub created_at: String }
}
model! {
    /// `DELETE /api/teams/{id}`.
    pub struct TeamDelete { pub refunded_cents: i64 }
}
model! {
    /// `POST /api/teams/{id}/wallet/fund`.
    pub struct TeamFund { pub transaction: TeamTransaction }
}
model! {
    /// `GET /api/teams/{id}/wallet/transactions`.
    pub struct TeamTransactions { pub transactions: Vec<TeamTransaction> }
}
model! {
    /// `GET /api/teams/{id}/members`.
    pub struct TeamMembers { pub members: Vec<TeamMember> }
}
model! {
    /// `GET /api/teams/{id}/invites`.
    pub struct TeamInvites { pub invites: Vec<TeamInvite> }
}
model! {
    /// `GET /api/teams/{id}/keys`.
    pub struct TeamKeys { pub keys: Vec<TeamKey> }
}
/// `PATCH /api/teams/{id}` body.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamUpdate {
    /// New name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// New member cap.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_members: Option<i64>,
}

// ---- usage
model! {
    /// Usage record.
    pub struct UsageRecord {
        pub id: String, pub session_id: String, #[serde(deserialize_with = "crate::util::de_byte_count")] pub bytes_in: i64, #[serde(deserialize_with = "crate::util::de_byte_count")] pub bytes_out: i64, #[serde(deserialize_with = "crate::util::de_byte_count")] pub total_bytes: i64,
        pub cost_cents: f64, pub proxy_type: String, pub target_host: String, pub created_at: String,
    }
}
model! {
    /// Usage totals.
    pub struct UsageSummary { #[serde(deserialize_with = "crate::util::de_byte_count")] pub total_bytes: i64, pub total_cost_cents: f64, pub request_count: i64, #[serde(rename = "totalGB")] pub total_gb: f64, pub total_cost_usd: f64 }
}
model! {
    /// Pagination block.
    pub struct Pagination { pub limit: i64, pub offset: i64, pub total: i64 }
}
model! {
    /// Date range echoed by the server.
    pub struct Period { pub since: String, pub until: String }
}
model! {
    /// `GET /api/usage`.
    pub struct UsageResponse { pub summary: UsageSummary, pub records: Vec<UsageRecord>, pub pagination: Pagination, pub period: Period }
}
model! {
    /// One day of usage.
    pub struct DailyUsage { pub date: String, #[serde(deserialize_with = "crate::util::de_byte_count")] pub total_bytes: i64, #[serde(rename = "totalGB")] pub total_gb: f64, pub total_cost_cents: f64, pub total_cost_usd: f64, pub request_count: i64 }
}
model! {
    /// `GET /api/usage/daily`.
    pub struct DailyUsageResponse { pub days: Vec<DailyUsage>, pub period: Period }
}
model! {
    /// One top host.
    pub struct TopHost { pub target_host: String, #[serde(deserialize_with = "crate::util::de_byte_count")] pub total_bytes: i64, #[serde(rename = "totalGB")] pub total_gb: f64, pub request_count: i64 }
}
model! {
    /// `GET /api/usage/top-hosts`.
    pub struct TopHostsResponse { pub hosts: Vec<TopHost>, pub period: Period }
}

// ---- sessions
/// Active proxy session. Deliberately has NO proxy/node IP field.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSession {
    /// Session id.
    pub id: String,
    /// Start time.
    pub started_at: String,
    /// Status.
    pub status: String,
}
/// `GET /api/sessions/active`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ActiveSessions {
    /// Sessions.
    pub sessions: Vec<ActiveSession>,
}
model! {
    /// `POST /v1/sessions/{id}/report`.
    pub struct ReportResult { pub report_id: String, pub reports_today: i64, pub limit_per_day: i64 }
}

// ---- x402
model! {
    /// x402 facilitator.
    pub struct X402Facilitator { pub network: String, pub receiving_address: Option<String>, pub currency: String }
}
model! {
    /// `GET /api/x402/info`. Prices are server-reported.
    pub struct X402Info {
        pub supported: bool, pub enabled: bool, pub protocol: String, pub version: String,
        pub facilitators: BTreeMap<String, X402Facilitator>, pub pricing: BTreeMap<String, Value>,
        pub currencies: Vec<String>, pub wallet_type: String, pub agentic_wallets: bool,
    }
}

// ---- network
model! {
    /// `GET /v1/policy`.
    pub struct NetworkPolicy { pub version: i64, pub sha256: String, pub body: serde_json::Map<String, Value>, pub floor_guarantees: Vec<String> }
}
model! {
    /// Price per IP class.
    pub struct ClassPrice { pub ip_class: String, pub price_per_gb_musd: String }
}
model! {
    /// Node share per tier.
    pub struct NodeShare { pub tier: String, pub rank: i64, pub node_share_bps: i64 }
}
model! {
    /// `GET /v1/pricing`.
    pub struct NetworkPricing {
        pub currency: String, pub unit: String, pub prices: Vec<ClassPrice>, pub node_share: Vec<NodeShare>,
        pub buyer_discounts: Vec<BuyerDiscount>, pub maturation_hours: f64, pub rails: Vec<String>,
    }
}
model! {
    /// Buyer discount for one owner tier (basis points).
    pub struct BuyerDiscount { pub tier: String, pub rank: i64, pub buyer_discount_bps: i64 }
}
model! {
    /// Online nodes and paid bytes in the last 24h for one operator group.
    pub struct NetworkGroupStats { pub online: i64, #[serde(deserialize_with = "crate::util::de_byte_count")] pub paid_bytes24h: i64 }
}
model! {
    /// Online nodes in a country.
    pub struct CountryCount { pub country: String, pub online: i64 }
}
model! {
    /// `GET /v1/network/stats`.
    pub struct NetworkStats {
        pub online_nodes: i64, pub by_class: BTreeMap<String, i64>, pub by_country: Vec<CountryCount>,
        pub other_countries: i64,
        /// Operator-run seed nodes.
        pub seed: NetworkGroupStats,
        /// Agent-run community nodes.
        pub community: NetworkGroupStats,
        pub generated_at: String,
    }
}

model! {
    /// Coordinator health in `NetworkStatus` (`operational` | `down`).
    pub struct StatusCoordinator { pub status: String, pub policy_version: Option<i64> }
}
model! {
    /// Gateway health in `NetworkStatus` (`operational` | `down` | `unknown`).
    pub struct StatusGateway { pub status: String, pub instances_online: i64, pub last_heartbeat_at: Option<String> }
}
model! {
    /// Percent of minutes with a live gateway; `None` before any heartbeat.
    pub struct StatusAvailability {
        #[serde(rename = "last24h")]
        pub last_24h: Option<f64>,
        #[serde(rename = "last7d")]
        pub last_7d: Option<f64>,
    }
}
model! {
    /// Node aggregates in `NetworkStatus`.
    pub struct StatusNodes {
        pub online_nodes: i64, pub by_class: BTreeMap<String, i64>, pub by_country: Vec<CountryCount>,
        pub other_countries: i64, pub countries_available: i64,
        /// Figures hidden by k-anonymity (published as 0).
        pub suppressed: Option<Vec<String>>,
    }
}
model! {
    /// Public incident (no incident id).
    pub struct PublicIncident {
        pub title: String, pub body: String, pub severity: String, pub status: String,
        pub started_at: String, pub resolved_at: Option<String>, pub updated_at: String,
    }
}
model! {
    /// `GET /v1/status`: aggregates only, no node ids, instance ids or IPs.
    pub struct NetworkStatus {
        /// `operational` | `degraded` | `down` | `unknown`.
        pub status: String,
        pub coordinator: StatusCoordinator, pub gateway: StatusGateway, pub availability: StatusAvailability,
        pub nodes: Option<StatusNodes>, pub incidents: Vec<PublicIncident>, pub generated_at: String,
    }
}

// ---- nodes
model! {
    /// PoW puzzle.
    pub struct PowChallenge { pub challenge_id: String, pub prefix: String, pub difficulty: f64, pub algorithm: String, pub expires_at: String }
}
model! {
    /// `POST /v1/nodes/challenge`.
    pub struct NodeChallenge {
        pub nonce: String, pub attestation_text: String, pub attestation_version: i64, pub policy_version: i64,
        pub message: String, pub expires_at: String, pub pow_challenge: PowChallenge,
    }
}
/// Registration result; `node_key` is returned once.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredNode {
    /// Node id.
    pub node_id: String,
    /// Status.
    pub status: String,
    /// Attestation version.
    pub attestation_version: i64,
    /// `dn_node_` key (redacted when printed).
    pub node_key: Secret,
}
model! {
    /// One of the caller's nodes.
    pub struct NodeInfo {
        pub id: String, pub status: String, pub wallet_address: String, pub node_pubkey: Option<String>,
        pub attestation_version: i64, pub observed_ip: Option<String>, pub country: Option<String>,
        pub ip_class: Option<String>, pub max_streams: Option<i64>, pub max_gb_day: Option<i64>,
        pub reputation: f64, pub agent_version: Option<String>, pub last_seen_at: Option<String>, pub created_at: String,
        /// Gateway-verified class (= `ip_class`, "unknown" until classified). 2.1.
        pub verified_class: Option<String>,
        /// Class declared at registration (informational). 2.1.
        pub declared_class: Option<String>,
        /// When the class was last verified. 2.1.
        pub class_verified_at: Option<String>,
        /// Tier-credit weight of the verified class (e.g. 1, 0.4, 0.25). 2.1.
        pub tier_weight: Option<f64>,
    }
}
model! {
    /// `GET /v1/nodes`.
    pub struct NodeList {
        pub nodes: Vec<NodeInfo>, pub limit: i64, pub offset: i64,
        /// Next page cursor; `None` on the last page or on older servers. 2.1.
        pub next_cursor: Option<String>,
    }
}
model! {
    /// `DELETE /v1/nodes/{id}`.
    pub struct NodeRevoked { pub id: String, pub status: String }
}
/// Node caps; each present value 1..1,000,000.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NodeCaps {
    /// Max concurrent streams.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_streams: Option<i64>,
    /// GB per day.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gb_per_day: Option<i64>,
    /// Requests per second.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub req_per_sec: Option<i64>,
}
model! {
    /// `PATCH /v1/nodes/{id}`.
    pub struct UpdateCapsResult { pub id: String, pub status: String, pub caps: Value, pub effective: Value, pub applies_on: String }
}
model! {
    /// Tier description.
    pub struct TierView {
        pub id: i64, pub name: String, pub rank: i64, pub node_share_bps: i64, pub hold_days: i64,
        pub max_nodes: i64, pub daily_withdraw_limit_musd: String, pub buyer_discount_bps: i64,
    }
}
model! {
    /// `GET /v1/node/tier`.
    pub struct NodeTier {
        pub tier: TierView, pub next_tier: Option<TierView>, pub progress: Option<Value>,
        pub changed_at: Option<String>, pub uptime_grace_until: Option<String>, pub demotion_reason: Option<String>,
        /// Tier-credit weight per exit class, e.g. `masked` 0.25. 2.1.
        pub tier_weights: Option<std::collections::BTreeMap<String, f64>>,
    }
}

// ---- credits
model! {
    /// Credit tier.
    pub struct CreditTier { pub id: i64, pub name: String, pub rank: i64, pub hold_days: i64, pub daily_withdraw_limit: Money }
}
model! {
    /// `GET /v1/credits`.
    pub struct CreditsBalance {
        pub pending: Money, pub available: Money, pub frozen: bool, pub auto_convert_pct: f64, pub tier: CreditTier,
        pub tax_form_status: String, pub ytd_paid: Money, pub payouts_enabled: bool, pub min_withdraw: Money,
        /// Discount on relay purchases from your owner tier (0 unless you run a node).
        pub buyer_discount_bps: i64,
    }
}
model! {
    /// Credit ledger entry.
    pub struct CreditTransaction {
        pub id: String, pub r#type: String, pub amount: Money, pub relay_charge_id: Option<String>,
        pub reference: Option<String>, pub created_at: String,
    }
}
model! {
    /// `GET /v1/credits/transactions`.
    pub struct CreditTransactions { pub transactions: Vec<CreditTransaction>, pub next_cursor: Option<String> }
}
model! {
    /// `POST /v1/credits/convert` (+ the idempotency key used).
    pub struct ConvertResult { pub converted: Money, pub converted_cents: i64, pub duplicate: bool, pub idempotency_key: String }
}
model! {
    /// Payout record.
    pub struct Payout {
        pub id: String, pub amount: Money, pub trigger: String, pub status: String, pub tx_hash: Option<String>,
        pub created_at: String, pub failure_reason: Option<String>, pub address: Option<String>,
        pub chain: Option<String>, pub updated_at: Option<String>,
    }
}
model! {
    /// `POST /v1/credits/withdraw` (+ the idempotency key used).
    pub struct WithdrawResult { pub payout: Payout, pub duplicate: bool, pub idempotency_key: String }
}
model! {
    /// `GET /v1/payouts`.
    pub struct PayoutList {
        pub payouts: Vec<Payout>, pub limit: i64, pub offset: i64,
        /// Next page cursor; `None` on the last page or on older servers. 2.1.
        pub next_cursor: Option<String>,
    }
}

// ---- payout wallet
model! {
    /// Payout wallet.
    pub struct PayoutWalletInfo { pub address: String, pub chain: String, pub status: String, pub active_from: String }
}
model! {
    /// `GET /v1/payout-wallet`.
    pub struct PayoutWalletState { pub payout_wallet: Option<PayoutWalletInfo>, pub cooldown_hours: f64 }
}
model! {
    /// `PUT /v1/payout-wallet`.
    pub struct SetPayoutWalletResult { pub payout_wallet: PayoutWalletInfo, pub changed: bool, pub cooldown_hours: f64 }
}

// ---- proxy
model! {
    /// `GET /api/proxy/health` (the server returns only the gateway status).
    pub struct ProxyHealth {
        pub status: String,
        /// Deprecated: never sent by the server; always 0.
        pub active_sessions: i64,
        /// Deprecated: never sent by the server; always 0.
        pub uptime_seconds: f64,
    }
}

impl TeamKey {
    /// The key prefix (same as `key_prefix`).
    pub fn prefix(&self) -> &str {
        &self.key_prefix
    }
}

impl TeamKeyCreated {
    /// The key prefix (same as `key_prefix`).
    pub fn prefix(&self) -> &str {
        &self.key_prefix
    }
}
