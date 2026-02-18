#pragma once

#include <nlohmann/json.hpp>
#include <optional>
#include <ostream>
#include <string>
#include <vector>

namespace dominusnode {

// ─── Auth & User ────────────────────────────────────────────────────────────

struct User {
    std::string id;
    std::string email;
    bool is_admin = false;
    std::optional<std::string> created_at;
};

inline void from_json(const nlohmann::json& j, User& u) {
    j.at("id").get_to(u.id);
    j.at("email").get_to(u.email);
    u.is_admin = j.value("is_admin", false);
    if (j.contains("created_at") && !j["created_at"].is_null()) {
        u.created_at = j["created_at"].get<std::string>();
    }
}

inline void to_json(nlohmann::json& j, const User& u) {
    j = {{"id", u.id}, {"email", u.email}, {"is_admin", u.is_admin}};
    if (u.created_at) j["created_at"] = *u.created_at;
}

struct LoginResult {
    std::optional<User> user;
    bool mfa_required = false;
    std::optional<std::string> token;
    std::optional<std::string> refresh_token;
    std::optional<std::string> mfa_challenge_token;
};

inline void from_json(const nlohmann::json& j, LoginResult& r) {
    if (j.contains("user") && !j["user"].is_null()) {
        r.user = j["user"].get<User>();
    }
    r.mfa_required = j.value("mfaRequired", false);
    if (j.contains("token") && !j["token"].is_null()) r.token = j["token"].get<std::string>();
    if (j.contains("refreshToken") && !j["refreshToken"].is_null()) r.refresh_token = j["refreshToken"].get<std::string>();
    if (j.contains("mfaChallengeToken") && !j["mfaChallengeToken"].is_null()) r.mfa_challenge_token = j["mfaChallengeToken"].get<std::string>();
}

// R30 CX-2: Credential redaction in output
inline std::ostream& operator<<(std::ostream& os, const LoginResult& r) {
    os << "LoginResult{mfa_required=" << r.mfa_required
       << ", token=[REDACTED], refresh_token=[REDACTED], mfa_challenge_token=[REDACTED]}";
    return os;
}

struct RegisterResult {
    User user;
    std::optional<std::string> token;
    std::optional<std::string> refresh_token;
};

inline void from_json(const nlohmann::json& j, RegisterResult& r) {
    j.at("user").get_to(r.user);
    if (j.contains("token") && !j["token"].is_null()) r.token = j["token"].get<std::string>();
    if (j.contains("refreshToken") && !j["refreshToken"].is_null()) r.refresh_token = j["refreshToken"].get<std::string>();
}

// R30 CX-2: Credential redaction in output
inline std::ostream& operator<<(std::ostream& os, const RegisterResult& r) {
    os << "RegisterResult{user=" << r.user.id
       << ", token=[REDACTED], refresh_token=[REDACTED]}";
    return os;
}

struct TokenPair {
    std::string access_token;
    std::optional<std::string> refresh_token;
};

inline void from_json(const nlohmann::json& j, TokenPair& t) {
    t.access_token = j.value("token", "");
    if (t.access_token.empty()) t.access_token = j.value("accessToken", "");
    if (j.contains("refreshToken") && !j["refreshToken"].is_null()) {
        t.refresh_token = j["refreshToken"].get<std::string>();
    }
}

// R30 CX-2: Credential redaction in output
inline std::ostream& operator<<(std::ostream& os, const TokenPair&) {
    os << "TokenPair{access_token=[REDACTED], refresh_token=[REDACTED]}";
    return os;
}

struct MfaStatus {
    bool enabled = false;
    int backup_codes_remaining = 0;
};

inline void from_json(const nlohmann::json& j, MfaStatus& m) {
    m.enabled = j.value("enabled", false);
    m.backup_codes_remaining = j.value("backupCodesRemaining", 0);
}

struct MfaSetup {
    std::string secret;
    std::string otpauth_uri;
    std::vector<std::string> backup_codes;
};

inline void from_json(const nlohmann::json& j, MfaSetup& m) {
    j.at("secret").get_to(m.secret);
    j.at("otpauthUri").get_to(m.otpauth_uri);
    j.at("backupCodes").get_to(m.backup_codes);
}

// R30 CX-2: Credential redaction in output
inline std::ostream& operator<<(std::ostream& os, const MfaSetup&) {
    os << "MfaSetup{secret=[REDACTED], otpauth_uri=[REDACTED], backup_codes=[REDACTED]}";
    return os;
}

struct MfaVerifyResult {
    User user;
    std::string token;
    std::string refresh_token;
};

inline void from_json(const nlohmann::json& j, MfaVerifyResult& r) {
    j.at("user").get_to(r.user);
    j.at("token").get_to(r.token);
    j.at("refreshToken").get_to(r.refresh_token);
}

// R30 CX-2: Credential redaction in output
inline std::ostream& operator<<(std::ostream& os, const MfaVerifyResult& r) {
    os << "MfaVerifyResult{user=" << r.user.id
       << ", token=[REDACTED], refresh_token=[REDACTED]}";
    return os;
}

struct VerifyKeyResult {
    bool valid = false;
    std::string token;
    std::string refresh_token;
    std::string user_id;
    std::string email;
};

inline void from_json(const nlohmann::json& j, VerifyKeyResult& r) {
    r.valid = j.value("valid", false);
    r.token = j.value("token", "");
    r.refresh_token = j.value("refreshToken", "");
    r.user_id = j.value("userId", "");
    r.email = j.value("email", "");
}

// R30 CX-2: Credential redaction in output
inline std::ostream& operator<<(std::ostream& os, const VerifyKeyResult& r) {
    os << "VerifyKeyResult{valid=" << r.valid
       << ", user_id=" << r.user_id
       << ", token=[REDACTED], refresh_token=[REDACTED]}";
    return os;
}

// ─── API Keys ───────────────────────────────────────────────────────────────

struct CreateKeyResult {
    std::string key;
    std::string id;
    std::string prefix;
    std::string label;
    std::string created_at;
};

inline void from_json(const nlohmann::json& j, CreateKeyResult& k) {
    j.at("key").get_to(k.key);
    j.at("id").get_to(k.id);
    j.at("prefix").get_to(k.prefix);
    k.label = j.value("label", "");
    k.created_at = j.value("created_at", "");
}

// R30 CX-2: Credential redaction in output
inline std::ostream& operator<<(std::ostream& os, const CreateKeyResult& k) {
    os << "CreateKeyResult{id=" << k.id
       << ", prefix=" << k.prefix
       << ", label=" << k.label
       << ", key=[REDACTED]}";
    return os;
}

struct ApiKeyEntry {
    std::string id;
    std::string prefix;
    std::string label;
    std::string created_at;
    std::optional<std::string> revoked_at;
};

inline void from_json(const nlohmann::json& j, ApiKeyEntry& k) {
    j.at("id").get_to(k.id);
    j.at("prefix").get_to(k.prefix);
    k.label = j.value("label", "");
    k.created_at = j.value("created_at", "");
    if (j.contains("revoked_at") && !j["revoked_at"].is_null()) {
        k.revoked_at = j["revoked_at"].get<std::string>();
    }
}

struct ListKeysResult {
    std::vector<ApiKeyEntry> keys;
};

inline void from_json(const nlohmann::json& j, ListKeysResult& r) {
    j.at("keys").get_to(r.keys);
}

// ─── Wallet ─────────────────────────────────────────────────────────────────

struct WalletBalance {
    int balance_cents = 0;
    double balance_usd = 0.0;
    std::string currency;
    std::optional<std::string> last_topped_up;
};

inline void from_json(const nlohmann::json& j, WalletBalance& w) {
    w.balance_cents = j.value("balanceCents", 0);
    w.balance_usd = j.value("balanceUsd", 0.0);
    w.currency = j.value("currency", "USD");
    if (j.contains("lastToppedUp") && !j["lastToppedUp"].is_null()) {
        w.last_topped_up = j["lastToppedUp"].get<std::string>();
    }
}

struct WalletTransaction {
    std::string id;
    std::string type;  // "topup", "debit", "refund"
    int amount_cents = 0;
    double amount_usd = 0.0;
    std::string description;
    std::optional<std::string> payment_provider;
    std::string created_at;
};

inline void from_json(const nlohmann::json& j, WalletTransaction& t) {
    j.at("id").get_to(t.id);
    j.at("type").get_to(t.type);
    t.amount_cents = j.value("amountCents", 0);
    t.amount_usd = j.value("amountUsd", 0.0);
    t.description = j.value("description", "");
    if (j.contains("paymentProvider") && !j["paymentProvider"].is_null()) {
        t.payment_provider = j["paymentProvider"].get<std::string>();
    }
    t.created_at = j.value("createdAt", "");
}

struct TransactionsResult {
    std::vector<WalletTransaction> transactions;
};

inline void from_json(const nlohmann::json& j, TransactionsResult& r) {
    j.at("transactions").get_to(r.transactions);
}

struct StripeCheckoutResult {
    std::string session_id;
    std::string url;
};

inline void from_json(const nlohmann::json& j, StripeCheckoutResult& r) {
    j.at("sessionId").get_to(r.session_id);
    j.at("url").get_to(r.url);
}

struct CryptoInvoiceResult {
    std::string invoice_id;
    std::string invoice_url;
    std::string pay_currency;
    double price_amount = 0.0;
};

inline void from_json(const nlohmann::json& j, CryptoInvoiceResult& r) {
    j.at("invoiceId").get_to(r.invoice_id);
    j.at("invoiceUrl").get_to(r.invoice_url);
    r.pay_currency = j.value("payCurrency", "");
    r.price_amount = j.value("priceAmount", 0.0);
}

struct WalletForecast {
    int daily_avg_cents = 0;
    std::optional<int> days_remaining;
    std::string trend;  // "up", "down", "stable"
    double trend_pct = 0.0;
};

inline void from_json(const nlohmann::json& j, WalletForecast& f) {
    f.daily_avg_cents = j.value("dailyAvgCents", 0);
    if (j.contains("daysRemaining") && !j["daysRemaining"].is_null()) {
        f.days_remaining = j["daysRemaining"].get<int>();
    }
    f.trend = j.value("trend", "stable");
    f.trend_pct = j.value("trendPct", 0.0);
}

// ─── Usage ──────────────────────────────────────────────────────────────────

struct UsageSummary {
    int64_t total_bytes = 0;
    int total_cost_cents = 0;
    int request_count = 0;
    double total_gb = 0.0;
    double total_cost_usd = 0.0;
};

inline void from_json(const nlohmann::json& j, UsageSummary& s) {
    s.total_bytes = j.value("totalBytes", int64_t(0));
    s.total_cost_cents = j.value("totalCostCents", 0);
    s.request_count = j.value("requestCount", 0);
    s.total_gb = j.value("totalGB", 0.0);
    s.total_cost_usd = j.value("totalCostUsd", 0.0);
}

struct UsageRecord {
    std::string id;
    std::string session_id;
    int64_t bytes_in = 0;
    int64_t bytes_out = 0;
    int64_t total_bytes = 0;
    int cost_cents = 0;
    std::string proxy_type;
    std::string target_host;
    std::string created_at;
};

inline void from_json(const nlohmann::json& j, UsageRecord& r) {
    r.id = j.value("id", "");
    r.session_id = j.value("sessionId", "");
    r.bytes_in = j.value("bytesIn", int64_t(0));
    r.bytes_out = j.value("bytesOut", int64_t(0));
    r.total_bytes = j.value("totalBytes", int64_t(0));
    r.cost_cents = j.value("costCents", 0);
    r.proxy_type = j.value("proxyType", "");
    r.target_host = j.value("targetHost", "");
    r.created_at = j.value("createdAt", "");
}

struct UsagePagination {
    int limit = 0;
    int offset = 0;
    int total = 0;
};

inline void from_json(const nlohmann::json& j, UsagePagination& p) {
    p.limit = j.value("limit", 0);
    p.offset = j.value("offset", 0);
    p.total = j.value("total", 0);
}

struct UsagePeriod {
    std::string since;
    std::string until;
};

inline void from_json(const nlohmann::json& j, UsagePeriod& p) {
    p.since = j.value("since", "");
    p.until = j.value("until", "");
}

struct UsageResult {
    UsageSummary summary;
    std::vector<UsageRecord> records;
    UsagePagination pagination;
    UsagePeriod period;
};

inline void from_json(const nlohmann::json& j, UsageResult& r) {
    j.at("summary").get_to(r.summary);
    j.at("records").get_to(r.records);
    j.at("pagination").get_to(r.pagination);
    j.at("period").get_to(r.period);
}

struct DailyUsageDay {
    std::string date;
    int64_t total_bytes = 0;
    double total_gb = 0.0;
    int total_cost_cents = 0;
    double total_cost_usd = 0.0;
    int request_count = 0;
};

inline void from_json(const nlohmann::json& j, DailyUsageDay& d) {
    d.date = j.value("date", "");
    d.total_bytes = j.value("totalBytes", int64_t(0));
    d.total_gb = j.value("totalGB", 0.0);
    d.total_cost_cents = j.value("totalCostCents", 0);
    d.total_cost_usd = j.value("totalCostUsd", 0.0);
    d.request_count = j.value("requestCount", 0);
}

struct DailyUsageResult {
    std::vector<DailyUsageDay> days;
    UsagePeriod period;
};

inline void from_json(const nlohmann::json& j, DailyUsageResult& r) {
    j.at("days").get_to(r.days);
    j.at("period").get_to(r.period);
}

struct TopHostEntry {
    std::string target_host;
    int64_t total_bytes = 0;
    double total_gb = 0.0;
    int request_count = 0;
};

inline void from_json(const nlohmann::json& j, TopHostEntry& h) {
    h.target_host = j.value("targetHost", "");
    h.total_bytes = j.value("totalBytes", int64_t(0));
    h.total_gb = j.value("totalGB", 0.0);
    h.request_count = j.value("requestCount", 0);
}

struct TopHostsResult {
    std::vector<TopHostEntry> hosts;
    UsagePeriod period;
};

inline void from_json(const nlohmann::json& j, TopHostsResult& r) {
    j.at("hosts").get_to(r.hosts);
    j.at("period").get_to(r.period);
}

// ─── Plans ──────────────────────────────────────────────────────────────────

struct PlanEntry {
    std::string id;
    std::string name;
    int price_per_gb_cents = 0;
    double price_per_gb_usd = 0.0;
    int64_t monthly_bandwidth_bytes = 0;
    std::optional<double> monthly_bandwidth_gb;
    bool is_default = false;
};

inline void from_json(const nlohmann::json& j, PlanEntry& p) {
    j.at("id").get_to(p.id);
    j.at("name").get_to(p.name);
    p.price_per_gb_cents = j.value("pricePerGbCents", 0);
    p.price_per_gb_usd = j.value("pricePerGbUsd", 0.0);
    p.monthly_bandwidth_bytes = j.value("monthlyBandwidthBytes", int64_t(0));
    if (j.contains("monthlyBandwidthGB") && !j["monthlyBandwidthGB"].is_null()) {
        p.monthly_bandwidth_gb = j["monthlyBandwidthGB"].get<double>();
    }
    p.is_default = j.value("isDefault", false);
}

struct ListPlansResult {
    std::vector<PlanEntry> plans;
};

inline void from_json(const nlohmann::json& j, ListPlansResult& r) {
    j.at("plans").get_to(r.plans);
}

struct PlanUsage {
    int64_t monthly_usage_bytes = 0;
    double monthly_usage_gb = 0.0;
    int64_t limit_bytes = 0;
    std::optional<double> limit_gb;
    std::optional<double> percent_used;
};

inline void from_json(const nlohmann::json& j, PlanUsage& u) {
    u.monthly_usage_bytes = j.value("monthlyUsageBytes", int64_t(0));
    u.monthly_usage_gb = j.value("monthlyUsageGB", 0.0);
    u.limit_bytes = j.value("limitBytes", int64_t(0));
    if (j.contains("limitGB") && !j["limitGB"].is_null()) {
        u.limit_gb = j["limitGB"].get<double>();
    }
    if (j.contains("percentUsed") && !j["percentUsed"].is_null()) {
        u.percent_used = j["percentUsed"].get<double>();
    }
}

struct UserPlanResult {
    PlanEntry plan;
    PlanUsage usage;
};

inline void from_json(const nlohmann::json& j, UserPlanResult& r) {
    j.at("plan").get_to(r.plan);
    j.at("usage").get_to(r.usage);
}

struct ChangePlanResult {
    std::string message;
    PlanEntry plan;
};

inline void from_json(const nlohmann::json& j, ChangePlanResult& r) {
    r.message = j.value("message", "");
    j.at("plan").get_to(r.plan);
}

// ─── Sessions ───────────────────────────────────────────────────────────────

struct ActiveSessionEntry {
    std::string id;
    std::string started_at;
    std::string proxy_ip;
    std::string status;
};

inline void from_json(const nlohmann::json& j, ActiveSessionEntry& s) {
    s.id = j.value("id", "");
    s.started_at = j.value("startedAt", "");
    s.proxy_ip = j.value("proxyIp", "");
    s.status = j.value("status", "");
}

struct ActiveSessionsResult {
    std::vector<ActiveSessionEntry> sessions;
};

inline void from_json(const nlohmann::json& j, ActiveSessionsResult& r) {
    j.at("sessions").get_to(r.sessions);
}

// ─── Proxy ──────────────────────────────────────────────────────────────────

struct ProxyEndpoint {
    std::string host;
    int port = 0;
};

inline void from_json(const nlohmann::json& j, ProxyEndpoint& e) {
    j.at("host").get_to(e.host);
    j.at("port").get_to(e.port);
}

struct GeoTargeting {
    bool state_support = false;
    bool city_support = false;
    bool asn_support = false;
};

inline void from_json(const nlohmann::json& j, GeoTargeting& g) {
    g.state_support = j.value("stateSupport", false);
    g.city_support = j.value("citySupport", false);
    g.asn_support = j.value("asnSupport", false);
}

struct ProxyConfig {
    ProxyEndpoint http_proxy;
    ProxyEndpoint socks5_proxy;
    std::vector<std::string> supported_countries;
    std::vector<std::string> blocked_countries;
    std::optional<GeoTargeting> geo_targeting;
};

inline void from_json(const nlohmann::json& j, ProxyConfig& c) {
    j.at("httpProxy").get_to(c.http_proxy);
    j.at("socks5Proxy").get_to(c.socks5_proxy);
    j.at("supportedCountries").get_to(c.supported_countries);
    c.blocked_countries = j.value("blockedCountries", std::vector<std::string>{});
    if (j.contains("geoTargeting") && !j["geoTargeting"].is_null()) {
        c.geo_targeting = j["geoTargeting"].get<GeoTargeting>();
    }
}

struct ProviderStat {
    std::string name;
    std::string state;
    int consecutive_failures = 0;
    int total_requests = 0;
    int total_errors = 0;
    double avg_latency_ms = 0.0;
    bool fallback_only = false;
};

inline void from_json(const nlohmann::json& j, ProviderStat& p) {
    p.name = j.value("name", "");
    p.state = j.value("state", "");
    p.consecutive_failures = j.value("consecutiveFailures", 0);
    p.total_requests = j.value("totalRequests", 0);
    p.total_errors = j.value("totalErrors", 0);
    p.avg_latency_ms = j.value("avgLatencyMs", 0.0);
    p.fallback_only = j.value("fallbackOnly", false);
}

struct ProxyHealth {
    std::string status;
    int active_sessions = 0;
    int uptime_seconds = 0;
};

inline void from_json(const nlohmann::json& j, ProxyHealth& h) {
    h.status = j.value("status", "unknown");
    h.active_sessions = j.value("activeSessions", 0);
    h.uptime_seconds = j.value("uptimeSeconds", 0);
}

struct ProxyStatus {
    std::string status;
    int active_sessions = 0;
    int user_active_sessions = 0;
    double avg_latency_ms = 0.0;
    std::vector<ProviderStat> providers;
    std::string http_endpoint;
    std::string socks5_endpoint;
    std::vector<std::string> supported_countries;
    int uptime_seconds = 0;
};

inline void from_json(const nlohmann::json& j, ProxyStatus& s) {
    s.status = j.value("status", "unknown");
    s.active_sessions = j.value("activeSessions", 0);
    s.user_active_sessions = j.value("userActiveSessions", 0);
    s.avg_latency_ms = j.value("avgLatencyMs", 0.0);
    if (j.contains("providers")) j.at("providers").get_to(s.providers);
    if (j.contains("endpoints") && j["endpoints"].is_object()) {
        s.http_endpoint = j["endpoints"].value("http", "");
        s.socks5_endpoint = j["endpoints"].value("socks5", "");
    }
    s.supported_countries = j.value("supportedCountries", std::vector<std::string>{});
    s.uptime_seconds = j.value("uptimeSeconds", 0);
}

/// Options for building a proxy URL.
struct ProxyUrlOptions {
    std::string protocol = "http";  // "http" or "socks5"
    std::string country;
    std::string state;
    std::string city;
    std::optional<int> asn;
    std::string session_id;
};

// ─── Admin ──────────────────────────────────────────────────────────────────

struct AdminUser {
    std::string id;
    std::string email;
    std::string status;
    bool is_admin = false;
    std::string created_at;
    int balance_cents = 0;
};

inline void from_json(const nlohmann::json& j, AdminUser& u) {
    u.id = j.value("id", "");
    u.email = j.value("email", "");
    u.status = j.value("status", "active");
    u.is_admin = j.value("is_admin", false);
    u.created_at = j.value("created_at", "");
    u.balance_cents = j.value("balance_cents", 0);
}

struct AdminPagination {
    int page = 1;
    int limit = 20;
    int total = 0;
    int total_pages = 0;
};

inline void from_json(const nlohmann::json& j, AdminPagination& p) {
    p.page = j.value("page", 1);
    p.limit = j.value("limit", 20);
    p.total = j.value("total", 0);
    p.total_pages = j.value("totalPages", 0);
}

struct AdminUsersResult {
    std::vector<AdminUser> users;
    AdminPagination pagination;
};

inline void from_json(const nlohmann::json& j, AdminUsersResult& r) {
    j.at("users").get_to(r.users);
    if (j.contains("pagination")) j.at("pagination").get_to(r.pagination);
}

struct RevenueStats {
    int total_revenue_cents = 0;
    double total_revenue_usd = 0.0;
    int avg_transaction_cents = 0;
    double avg_transaction_usd = 0.0;
    UsagePeriod period;
};

inline void from_json(const nlohmann::json& j, RevenueStats& s) {
    s.total_revenue_cents = j.value("totalRevenueCents", 0);
    s.total_revenue_usd = j.value("totalRevenueUsd", 0.0);
    s.avg_transaction_cents = j.value("avgTransactionCents", 0);
    s.avg_transaction_usd = j.value("avgTransactionUsd", 0.0);
    if (j.contains("period")) j.at("period").get_to(s.period);
}

struct DailyRevenueEntry {
    std::string date;
    int revenue_cents = 0;
    double revenue_usd = 0.0;
};

inline void from_json(const nlohmann::json& j, DailyRevenueEntry& d) {
    d.date = j.value("date", "");
    d.revenue_cents = j.value("revenueCents", 0);
    d.revenue_usd = j.value("revenueUsd", 0.0);
}

struct DailyRevenueResult {
    std::vector<DailyRevenueEntry> days;
    UsagePeriod period;
};

inline void from_json(const nlohmann::json& j, DailyRevenueResult& r) {
    j.at("days").get_to(r.days);
    if (j.contains("period")) j.at("period").get_to(r.period);
}

struct SystemStats {
    int active_sessions = 0;
    int total_users = 0;
    int64_t total_bandwidth_bytes = 0;
};

inline void from_json(const nlohmann::json& j, SystemStats& s) {
    s.active_sessions = j.value("activeSessions", j.value("active_sessions", 0));
    s.total_users = j.value("totalUsers", j.value("total_users", 0));
    s.total_bandwidth_bytes = j.value("totalBandwidthBytes", j.value("total_bandwidth_bytes", int64_t(0)));
}

// ─── Slots / Waitlist ─────────────────────────────────────────────────────

struct SlotsInfo {
    int total = 0;
    int used = 0;
    int remaining = 0;
    bool unlimited = false;
};

inline void from_json(const nlohmann::json& j, SlotsInfo& s) {
    s.total = j.value("total", 0);
    s.used = j.value("used", 0);
    s.remaining = j.value("remaining", 0);
    s.unlimited = j.value("unlimited", false);
}

struct WaitlistJoinResult {
    std::string message;
};

inline void from_json(const nlohmann::json& j, WaitlistJoinResult& w) {
    w.message = j.value("message", "");
}

struct WaitlistCount {
    int pending = 0;
};

inline void from_json(const nlohmann::json& j, WaitlistCount& w) {
    w.pending = j.value("pending", 0);
}

} // namespace dominusnode
