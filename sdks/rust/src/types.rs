use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/// A Dominus Node user account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub email: String,
    pub is_admin: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

/// Result of a login attempt. When `mfa_required` is `true` the caller must
/// complete MFA verification before the session is usable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<User>,
    #[serde(default, rename = "mfaRequired")]
    pub mfa_required: bool,
}

/// Internal response shape returned by the login endpoint.
#[derive(Clone, Deserialize)]
pub(crate) struct LoginResponse {
    #[serde(default)]
    pub user: Option<User>,
    #[serde(default, rename = "mfaRequired")]
    pub mfa_required: bool,
    pub token: Option<String>,
    #[serde(rename = "refreshToken")]
    pub refresh_token: Option<String>,
}

// R14 H-3: Custom Debug to redact tokens
impl std::fmt::Debug for LoginResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginResponse")
            .field("user", &self.user)
            .field("mfa_required", &self.mfa_required)
            .field("token", &self.token.as_ref().map(|_| "[REDACTED]"))
            .field("refresh_token", &self.refresh_token.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

/// A JWT access / refresh token pair.
#[derive(Clone, Serialize, Deserialize)]
pub struct TokenPair {
    #[serde(rename = "accessToken")]
    pub access_token: String,
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
}

// Custom Debug to redact tokens (R13 H-2)
impl std::fmt::Debug for TokenPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenPair")
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .finish()
    }
}

/// Current MFA status for the authenticated user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MfaStatus {
    pub enabled: bool,
    #[serde(rename = "backupCodesRemaining")]
    pub backup_codes_remaining: u32,
}

/// MFA setup information returned when initiating TOTP enrolment.
#[derive(Clone, Serialize, Deserialize)]
pub struct MfaSetup {
    pub secret: String,
    #[serde(rename = "otpauthUri")]
    pub otpauth_uri: String,
    #[serde(rename = "backupCodes")]
    pub backup_codes: Vec<String>,
}

// Custom Debug to redact MFA secrets (R13 H-2)
impl std::fmt::Debug for MfaSetup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MfaSetup")
            .field("secret", &"[REDACTED]")
            .field("otpauth_uri", &"[REDACTED]")
            .field("backup_codes", &format!("[{} codes]", self.backup_codes.len()))
            .finish()
    }
}

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------

/// An API key visible in the list endpoint (raw value is never returned here).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKey {
    pub id: String,
    #[serde(alias = "key_prefix", alias = "prefix")]
    pub key_prefix: String,
    pub label: String,
    pub created_at: String,
    /// The raw key value -- only present immediately after creation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

/// Response from the key-creation endpoint.
#[derive(Clone, Deserialize)]
pub struct CreateKeyResponse {
    pub key: String,
    pub id: String,
    pub prefix: String,
    pub label: String,
    pub created_at: String,
}

// R14 H-3: Custom Debug to redact raw API key
impl std::fmt::Debug for CreateKeyResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreateKeyResponse")
            .field("key", &"[REDACTED]")
            .field("id", &self.id)
            .field("prefix", &self.prefix)
            .field("label", &self.label)
            .field("created_at", &self.created_at)
            .finish()
    }
}

/// Response from the list-keys endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct ListKeysResponse {
    pub keys: Vec<ListKeysEntry>,
}

/// A single entry in the key list.
#[derive(Debug, Clone, Deserialize)]
pub struct ListKeysEntry {
    pub id: String,
    pub prefix: String,
    pub label: String,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

/// Wallet balance information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Wallet {
    pub balance_cents: i64,
    pub currency: String,
}

/// A single wallet ledger transaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletTransaction {
    pub id: String,
    #[serde(rename = "type")]
    pub tx_type: String,
    pub amount_cents: i64,
    pub description: String,
    pub created_at: String,
}

/// Response from the get-balance endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct WalletBalanceResponse {
    #[serde(rename = "balanceCents")]
    pub balance_cents: i64,
    #[serde(rename = "balanceUsd")]
    pub balance_usd: f64,
    pub currency: String,
    #[serde(rename = "lastToppedUp")]
    pub last_topped_up: Option<String>,
}

/// Response from the get-transactions endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct TransactionsResponse {
    pub transactions: Vec<TransactionEntry>,
}

/// A single transaction entry in the list.
#[derive(Debug, Clone, Deserialize)]
pub struct TransactionEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub tx_type: String,
    #[serde(rename = "amountCents")]
    pub amount_cents: i64,
    #[serde(rename = "amountUsd")]
    pub amount_usd: f64,
    pub description: String,
    #[serde(rename = "paymentProvider")]
    pub payment_provider: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// Response from a Stripe top-up request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StripeCheckout {
    pub url: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

/// Response from a crypto top-up request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CryptoInvoice {
    #[serde(rename = "invoiceId")]
    pub invoice_id: String,
    #[serde(rename = "invoiceUrl", alias = "paymentUrl")]
    pub invoice_url: String,
    #[serde(rename = "priceAmount", alias = "amount", default)]
    pub price_amount: f64,
    #[serde(rename = "payCurrency", alias = "currency", default)]
    pub pay_currency: String,
}

/// Spending forecast based on recent usage.
#[derive(Debug, Clone, Deserialize)]
pub struct ForecastResponse {
    #[serde(rename = "dailyAvgCents")]
    pub daily_avg_cents: f64,
    #[serde(rename = "daysRemaining")]
    pub days_remaining: Option<f64>,
    pub trend: String,
    #[serde(rename = "trendPct")]
    pub trend_pct: f64,
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/// A single metered usage record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageRecord {
    pub date: String,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub total_bytes: u64,
    pub cost_cents: i64,
    pub request_count: u64,
}

/// A top-visited host by bandwidth.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopHost {
    pub target_host: String,
    pub total_bytes: u64,
    pub request_count: u64,
}

/// Summary block returned with detailed usage.
#[derive(Debug, Clone, Deserialize)]
pub struct UsageSummary {
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "totalCostCents")]
    pub total_cost_cents: i64,
    #[serde(rename = "requestCount")]
    pub request_count: u64,
    #[serde(rename = "totalGB")]
    pub total_gb: f64,
    #[serde(rename = "totalCostUsd")]
    pub total_cost_usd: f64,
}

/// A single record inside the usage response.
#[derive(Debug, Clone, Deserialize)]
pub struct UsageResponseRecord {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "bytesIn")]
    pub bytes_in: u64,
    #[serde(rename = "bytesOut")]
    pub bytes_out: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "costCents")]
    pub cost_cents: i64,
    #[serde(rename = "proxyType")]
    pub proxy_type: String,
    #[serde(rename = "targetHost")]
    pub target_host: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// Pagination metadata.
#[derive(Debug, Clone, Deserialize)]
pub struct Pagination {
    pub limit: u64,
    pub offset: u64,
    pub total: u64,
}

/// Period metadata.
#[derive(Debug, Clone, Deserialize)]
pub struct Period {
    pub since: String,
    pub until: String,
}

/// Full response from the usage endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct UsageResponse {
    pub summary: UsageSummary,
    pub records: Vec<UsageResponseRecord>,
    pub pagination: Pagination,
    pub period: Period,
}

/// A single day's aggregated usage.
#[derive(Debug, Clone, Deserialize)]
pub struct DailyUsageDay {
    pub date: String,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "totalGB")]
    pub total_gb: f64,
    #[serde(rename = "totalCostCents")]
    pub total_cost_cents: i64,
    #[serde(rename = "totalCostUsd")]
    pub total_cost_usd: f64,
    #[serde(rename = "requestCount")]
    pub request_count: u64,
}

/// Response from the daily usage endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct DailyUsageResponse {
    pub days: Vec<DailyUsageDay>,
    pub period: Period,
}

/// A top-host entry returned by the top-hosts endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct TopHostEntry {
    #[serde(rename = "targetHost")]
    pub target_host: String,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "totalGB")]
    pub total_gb: f64,
    #[serde(rename = "requestCount")]
    pub request_count: u64,
}

/// Response from the top-hosts endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct TopHostsResponse {
    pub hosts: Vec<TopHostEntry>,
    pub period: Period,
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/// A billing plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub price_per_gb_cents: i64,
    pub monthly_bandwidth_bytes: u64,
    pub is_default: bool,
}

/// A plan entry as returned by the API (camelCase).
#[derive(Debug, Clone, Deserialize)]
pub struct PlanEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "pricePerGbCents")]
    pub price_per_gb_cents: i64,
    #[serde(rename = "pricePerGbUsd")]
    pub price_per_gb_usd: f64,
    #[serde(rename = "monthlyBandwidthBytes")]
    pub monthly_bandwidth_bytes: u64,
    #[serde(rename = "monthlyBandwidthGB")]
    pub monthly_bandwidth_gb: Option<f64>,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
}

/// Response from the list-plans endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct ListPlansResponse {
    pub plans: Vec<PlanEntry>,
}

/// User's current plan and monthly usage.
#[derive(Debug, Clone, Deserialize)]
pub struct UserPlanResponse {
    pub plan: PlanEntry,
    pub usage: UserPlanUsage,
}

/// Monthly usage counters relative to the plan limit.
#[derive(Debug, Clone, Deserialize)]
pub struct UserPlanUsage {
    #[serde(rename = "monthlyUsageBytes")]
    pub monthly_usage_bytes: u64,
    #[serde(rename = "monthlyUsageGB")]
    pub monthly_usage_gb: f64,
    #[serde(rename = "limitBytes")]
    pub limit_bytes: u64,
    #[serde(rename = "limitGB")]
    pub limit_gb: Option<f64>,
    #[serde(rename = "percentUsed")]
    pub percent_used: Option<f64>,
}

/// Response from the change-plan endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct ChangePlanResponse {
    pub message: String,
    pub plan: PlanEntry,
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/// An active proxy session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveSession {
    pub id: String,
    #[serde(alias = "proxy_ip", rename = "proxyIp")]
    pub proxy_ip: String,
    #[serde(alias = "started_at", rename = "startedAt")]
    pub started_at: String,
    #[serde(alias = "bytes_total", default)]
    pub status: String,
}

/// A single active session entry.
#[derive(Debug, Clone, Deserialize)]
pub struct ActiveSessionEntry {
    pub id: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "proxyIp")]
    pub proxy_ip: String,
    pub status: String,
}

/// Response from the active-sessions endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct ActiveSessionsResponse {
    pub sessions: Vec<ActiveSessionEntry>,
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

/// Options for building a proxy URL.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProxyUrlOptions {
    /// Protocol to use: `"http"` (default) or `"socks5"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    /// ISO 3166-1 alpha-2 country code for geo-targeting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    /// US state code for geo-targeting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// City name for geo-targeting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    /// Autonomous System Number for ASN targeting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asn: Option<u32>,
    /// Sticky session identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// Proxy health check response (public, no auth required).
#[derive(Debug, Clone, Deserialize)]
pub struct ProxyHealthResponse {
    pub status: String,
    #[serde(rename = "activeSessions")]
    pub active_sessions: u64,
    #[serde(rename = "uptimeSeconds")]
    pub uptime_seconds: f64,
}

/// Detailed proxy status (requires authentication).
#[derive(Debug, Clone, Deserialize)]
pub struct ProxyStatusResponse {
    pub status: String,
    #[serde(rename = "activeSessions")]
    pub active_sessions: u64,
    #[serde(rename = "userActiveSessions")]
    pub user_active_sessions: u64,
    #[serde(rename = "avgLatencyMs")]
    pub avg_latency_ms: f64,
    pub providers: Vec<ProviderInfo>,
    pub endpoints: ProxyEndpoints,
    #[serde(rename = "supportedCountries")]
    pub supported_countries: Vec<String>,
    #[serde(rename = "uptimeSeconds")]
    pub uptime_seconds: f64,
}

/// Information about a single upstream proxy provider.
#[derive(Debug, Clone, Deserialize)]
pub struct ProviderInfo {
    pub name: String,
    pub state: String,
    #[serde(rename = "consecutiveFailures")]
    pub consecutive_failures: u64,
    #[serde(rename = "totalRequests")]
    pub total_requests: u64,
    #[serde(rename = "totalErrors")]
    pub total_errors: u64,
    #[serde(rename = "avgLatencyMs")]
    pub avg_latency_ms: f64,
    #[serde(rename = "fallbackOnly")]
    pub fallback_only: bool,
}

/// HTTP and SOCKS5 endpoint addresses.
#[derive(Debug, Clone, Deserialize)]
pub struct ProxyEndpoints {
    pub http: String,
    pub socks5: String,
}

/// Proxy server configuration (requires authentication).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    #[serde(rename = "httpProxy")]
    pub http_proxy: ProxyEndpoint,
    #[serde(rename = "socks5Proxy")]
    pub socks5_proxy: ProxyEndpoint,
    #[serde(rename = "supportedCountries")]
    pub supported_countries: Vec<String>,
    #[serde(rename = "blockedCountries")]
    pub blocked_countries: Vec<String>,
    #[serde(rename = "geoTargeting", skip_serializing_if = "Option::is_none")]
    pub geo_targeting: Option<GeoTargeting>,
}

/// A host:port pair for a proxy endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyEndpoint {
    pub host: String,
    pub port: u16,
}

/// Geo-targeting feature flags.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoTargeting {
    #[serde(rename = "stateSupport")]
    pub state_support: bool,
    #[serde(rename = "citySupport")]
    pub city_support: bool,
    #[serde(rename = "asnSupport")]
    pub asn_support: bool,
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/// A user record as seen by an admin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminUser {
    pub id: String,
    pub email: String,
    pub status: String,
    pub is_admin: bool,
    pub created_at: String,
    pub balance_cents: i64,
}

/// Revenue statistics for a date range.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevenueStats {
    pub total_revenue_cents: i64,
    pub total_topups_cents: i64,
    pub total_usage_cents: i64,
    pub user_count: u64,
}

/// A single day's revenue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyRevenue {
    pub date: String,
    pub revenue_cents: i64,
}

/// System-wide statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemStats {
    pub active_sessions: u64,
    pub total_users: u64,
    pub total_bandwidth_bytes: u64,
}

/// Admin list-users response.
#[derive(Debug, Clone, Deserialize)]
pub struct ListUsersResponse {
    pub users: Vec<AdminUser>,
    pub pagination: AdminPagination,
}

/// Admin pagination metadata.
#[derive(Debug, Clone, Deserialize)]
pub struct AdminPagination {
    pub page: u64,
    pub limit: u64,
    pub total: u64,
    #[serde(rename = "totalPages")]
    pub total_pages: u64,
}

/// Admin single-user response.
#[derive(Debug, Clone, Deserialize)]
pub struct GetUserResponse {
    pub user: AdminUser,
}

/// Admin revenue response.
#[derive(Debug, Clone, Deserialize)]
pub struct RevenueResponse {
    #[serde(rename = "totalRevenueCents")]
    pub total_revenue_cents: i64,
    #[serde(rename = "totalRevenueUsd")]
    pub total_revenue_usd: f64,
    #[serde(rename = "avgTransactionCents")]
    pub avg_transaction_cents: i64,
    #[serde(rename = "avgTransactionUsd")]
    pub avg_transaction_usd: f64,
    #[serde(rename = "transactionCount")]
    pub transaction_count: u64,
    #[serde(rename = "topupCount")]
    pub topup_count: u64,
    pub period: Period,
}

/// Admin daily-revenue entry.
#[derive(Debug, Clone, Deserialize)]
pub struct DailyRevenueEntry {
    pub date: String,
    #[serde(rename = "revenueCents")]
    pub revenue_cents: i64,
    #[serde(rename = "revenueUsd")]
    pub revenue_usd: f64,
}

/// Admin daily-revenue response.
#[derive(Debug, Clone, Deserialize)]
pub struct DailyRevenueResponse {
    pub days: Vec<DailyRevenueEntry>,
    pub period: Period,
}

/// Simple message response used by several admin endpoints.
#[derive(Debug, Clone, Deserialize)]
pub struct MessageResponse {
    pub message: String,
}
