#pragma once

#include "dominusnode/constants.hpp"
#include "dominusnode/http_client.hpp"
#include "dominusnode/secret.hpp"
#include "dominusnode/signing.hpp"
#include "dominusnode/ssrf.hpp"
#include "dominusnode/validation.hpp"

#include <nlohmann/json.hpp>
#include <cstdint>
#include <map>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace dominusnode {

using json = nlohmann::json;
using OptStr = std::optional<std::string>;
using OptInt = std::optional<long long>;

/// Pagination callback: return false to stop early.
using ItemCallback = std::function<bool(const json&)>;

/// Byte count from a field sent as a JSON number or a numeric string (null/missing = 0).
/// Fractions, text or out-of-range values throw ServerError.
std::int64_t byte_count(const json& v);

// ─── 3.1 auth ───────────────────────────────────────────────────────────────
class AuthResource {
public:
    explicit AuthResource(HttpClient& h) : http_(h) {}
    /// POST /api/auth/verify-key [none]
    json verify_key(const std::string& api_key);
    /// POST /api/auth/refresh [none]
    json refresh(const std::string& refresh_token);
    /// POST /api/auth/logout [jwt]
    void logout();
    /// GET /api/auth/me [jwt]
    json me();
private:
    HttpClient& http_;
};

// ─── 3.2 walletAuth ─────────────────────────────────────────────────────────
class WalletAuthResource {
public:
    WalletAuthResource(HttpClient& h, TokenManager& t) : http_(h), tokens_(t) {}
    json challenge(const std::string& address);
    /// Stores the JWT pair unless mfaRequired (then returns {mfaRequired, mfaChallengeToken} only).
    json verify(const std::string& address, const std::string& signature);
    json sign_in(const Signer& signer);
    json link(const std::string& address, const std::string& signature);
private:
    HttpClient& http_;
    TokenManager& tokens_;
};

// ─── 3.3 keys ───────────────────────────────────────────────────────────────
struct CreatedApiKey {
    std::string id, prefix, label, created_at;
    Secret key;
};
class KeysResource {
public:
    explicit KeysResource(HttpClient& h) : http_(h) {}
    CreatedApiKey create(const std::string& label = "Default");
    json list();
    void revoke(const std::string& id);
private:
    HttpClient& http_;
};

// ─── 3.4 wallet ─────────────────────────────────────────────────────────────
class WalletResource {
public:
    explicit WalletResource(HttpClient& h) : http_(h) {}
    /// GET /v1/wallet [agent]: {balanceCents, currency, lastToppedUp|null}, read with the raw API key.
    json get();
    json get_balance();
    json get_transactions(OptInt limit = std::nullopt, OptInt offset = std::nullopt);
    json get_forecast();
    /// 1000..100000 cents; currency btc eth ltc xmr zec usdc sol usdt dai bnb link.
    json top_up_crypto(std::int64_t amount_cents, const std::string& currency);
    json get_crypto_status(const std::string& invoice_id);
    /// Every wallet transaction (page size default 50, server max 100).
    void for_each_transaction(const ItemCallback& fn, OptInt limit = std::nullopt);
private:
    HttpClient& http_;
};

// ─── 3.5 agenticWallets ─────────────────────────────────────────────────────
struct WalletPolicy {
    std::optional<std::int64_t> daily_limit_cents;
    bool clear_daily_limit = false;  // send null
    std::optional<std::vector<std::string>> allowed_domains;
    bool clear_allowed_domains = false;  // send null
};
class AgenticWalletResource {
public:
    explicit AgenticWalletResource(HttpClient& h) : http_(h) {}
    json create(const std::string& label, std::int64_t spending_limit_cents = 10000,
                std::optional<std::int64_t> daily_limit_cents = std::nullopt,
                std::optional<std::vector<std::string>> allowed_domains = std::nullopt);
    json list();
    json get(const std::string& wallet_id);
    json fund(const std::string& wallet_id, std::int64_t amount_cents);
    json update_wallet_policy(const std::string& wallet_id, const WalletPolicy& policy);
    json transactions(const std::string& wallet_id, OptInt limit = std::nullopt, OptInt offset = std::nullopt);
    json freeze(const std::string& wallet_id);
    json unfreeze(const std::string& wallet_id);
    /// `delete` in the contract (C++ keyword).
    json delete_wallet(const std::string& wallet_id);
private:
    HttpClient& http_;
};

// ─── 3.6 teams ──────────────────────────────────────────────────────────────
struct TeamKeyCreateResponse {
    std::string id;
    /// Read from the server's `prefix` field (legacy `keyPrefix` accepted).
    std::string key_prefix;
    std::string label;
    Secret key;
    /// Same value as key_prefix (added in 2.0.1).
    std::string prefix;
    std::string created_at;
};
class TeamsResource {
public:
    explicit TeamsResource(HttpClient& h) : http_(h) {}
    json create(const std::string& name, OptInt max_members = std::nullopt);
    json list();
    json get(const std::string& team_id);
    json update(const std::string& team_id, OptStr name = std::nullopt, OptInt max_members = std::nullopt);
    /// `delete` in the contract (C++ keyword).
    json delete_team(const std::string& team_id);
    json fund_wallet(const std::string& team_id, std::int64_t amount_cents);
    json get_transactions(const std::string& team_id, OptInt limit = std::nullopt, OptInt offset = std::nullopt);
    json list_members(const std::string& team_id);
    json add_member(const std::string& team_id, const std::string& email, OptStr role = std::nullopt);
    json update_member_role(const std::string& team_id, const std::string& user_id, const std::string& role);
    void remove_member(const std::string& team_id, const std::string& user_id);
    json create_invite(const std::string& team_id, const std::string& email, OptStr role = std::nullopt);
    json list_invites(const std::string& team_id);
    void cancel_invite(const std::string& team_id, const std::string& invite_id);
    json accept_invite(const std::string& token);
    TeamKeyCreateResponse create_key(const std::string& team_id, const std::string& label);
    /// {keys:[{id, prefix, label, userId, teamId, createdAt, revokedAt}]}; a legacy keyPrefix is copied to prefix.
    json list_keys(const std::string& team_id);
    void revoke_key(const std::string& team_id, const std::string& key_id);
private:
    HttpClient& http_;
};

// ─── 3.7 usage ──────────────────────────────────────────────────────────────
class UsageResource {
public:
    explicit UsageResource(HttpClient& h) : http_(h) {}
    json get(OptStr from = std::nullopt, OptStr to = std::nullopt, OptInt limit = std::nullopt, OptInt offset = std::nullopt);
    json get_daily(OptStr from = std::nullopt, OptStr to = std::nullopt);
    json get_top_hosts(OptStr from = std::nullopt, OptStr to = std::nullopt, OptInt limit = std::nullopt);
    /// Raw CSV text.
    std::string export_csv(OptStr from = std::nullopt, OptStr to = std::nullopt);
    /// Every usage record in the range (page size default 200, max 1000); stops at pagination.total.
    void for_each_record(const ItemCallback& fn, OptStr from = std::nullopt, OptStr to = std::nullopt, OptInt limit = std::nullopt);
private:
    HttpClient& http_;
};

// ─── 3.8 sessions ───────────────────────────────────────────────────────────
/// Deliberately has NO proxy/node IP field.
struct ActiveSession {
    std::string id, started_at, status;
};
struct ActiveSessions {
    std::vector<ActiveSession> sessions;
};
class SessionsResource {
public:
    explicit SessionsResource(HttpClient& h) : http_(h) {}
    ActiveSessions get_active();
    /// reason: blocked captcha rate_limited slow bad_content other.
    json report(const std::string& session_id, const std::string& reason);
private:
    HttpClient& http_;
};

// ─── 3.9 x402 ───────────────────────────────────────────────────────────────
class X402Resource {
public:
    explicit X402Resource(HttpClient& h) : http_(h) {}
    json get_info();
private:
    HttpClient& http_;
};

// ─── 3.10 network ───────────────────────────────────────────────────────────
class NetworkResource {
public:
    explicit NetworkResource(HttpClient& h) : http_(h) {}
    json policy();
    json pricing();
    json stats();
    /// GET /v1/status [none]: {status, coordinator{status, policyVersion}, gateway{status, instancesOnline,
    /// lastHeartbeatAt}, availability{last24h, last7d}, nodes|null, incidents[], generatedAt}. Aggregates only.
    json status();
private:
    HttpClient& http_;
};

// ─── 3.11 nodes ─────────────────────────────────────────────────────────────
struct RegisterNodeOptions {
    OptStr node_pubkey;
    /// A challenge from register_challenge() (same node_pubkey). Fetched when absent.
    std::optional<json> challenge;
    OptInt max_streams;  // 1..1024
    OptInt max_gb_day;   // 1..10000
    std::uint64_t max_pow_iterations = 200000000ULL;
    /// Informational class claim (2.1): residential, mobile, dc or masked. Effective class is gateway-verified.
    OptStr declared_class;
};
struct RegisteredNode {
    std::string node_id, status;
    long long attestation_version = 0;
    /// dn_node_ key, returned ONCE. Store it 0600.
    Secret node_key;
};
struct NodeCaps {
    OptInt max_streams, gb_per_day, req_per_sec;
};
class NodesResource {
public:
    explicit NodesResource(HttpClient& h) : http_(h) {}
    json register_challenge(const OptStr& node_pubkey = std::nullopt);
    /// challenge -> rebuild attestation (refuse mismatch) -> PoW -> sign -> POST /v1/nodes.
    RegisteredNode register_node(const Signer& signer, const RegisterNodeOptions& opts = {});
    json list(OptInt limit = std::nullopt, OptInt offset = std::nullopt);
    /// GET /v1/nodes?cursor= : the page after a previous nextCursor (2.1).
    json list_after(OptInt limit, const std::string& cursor);
    /// Every node you own (follows nextCursor, offset fallback; page size default 100, max 500).
    void for_each(const ItemCallback& fn, OptInt limit = std::nullopt);
    json revoke(const std::string& node_id);
    json update_caps(const std::string& node_id, const NodeCaps& caps);
    json tier();
private:
    HttpClient& http_;
};

// ─── 3.12 credits / 3.14 payouts ────────────────────────────────────────────
inline constexpr std::uint64_t MIN_CONVERT_MUSD = 10000ULL;
inline constexpr std::uint64_t MAX_CONVERT_MUSD = 10000000000ULL;
inline constexpr std::uint64_t MIN_WITHDRAW_MUSD = 1000000ULL;
inline constexpr std::uint64_t MAX_WITHDRAW_MUSD = 100000000000ULL;

class CreditsResource {
public:
    explicit CreditsResource(HttpClient& h) : http_(h) {}
    json balance();
    /// limit 1..200; cursor ^[1-9][0-9]{0,18}$; type earn mature clawback convert withdraw withdraw_reversal.
    json transactions(OptInt limit = std::nullopt, OptStr cursor = std::nullopt, OptStr type = std::nullopt);
    /// Every credit transaction (newest first), following nextCursor; limit = page size.
    void for_each_transaction(const ItemCallback& fn, OptInt limit = std::nullopt, OptStr type = std::nullopt);
    /// Result includes the idempotencyKey used (retry with it).
    /// Signed: POST /v1/credits/convert/challenge, rebuild + compare the message, sign, then
    /// POST /v1/credits/convert {amountMusd, nonce, signature} (Idempotency-Key header on both).
    json convert(const MusdInput& amount_musd, const Signer& signer, OptStr idempotency_key = std::nullopt);
    json withdraw(const MusdInput& amount_musd, const Signer& signer, OptStr idempotency_key = std::nullopt);
private:
    HttpClient& http_;
};
class PayoutsResource {
public:
    explicit PayoutsResource(HttpClient& h) : http_(h) {}
    json list(OptInt limit = std::nullopt, OptInt offset = std::nullopt);
    /// GET /v1/payouts?cursor= : the page after a previous nextCursor (2.1).
    json list_after(OptInt limit, const std::string& cursor);
    /// Every payout (follows nextCursor, offset fallback; page size default 50, max 200).
    void for_each(const ItemCallback& fn, OptInt limit = std::nullopt);
private:
    HttpClient& http_;
};

// ─── 3.13 payoutWallet ──────────────────────────────────────────────────────
class PayoutWalletResource {
public:
    explicit PayoutWalletResource(HttpClient& h) : http_(h) {}
    json get();
    /// chain "base" or "base-sepolia" (explicit staging opt-in; the server decides).
    json set(const std::string& address, const Signer& signer, const std::string& chain = "base",
             const std::optional<Signer>& old_wallet_signer = std::nullopt);
private:
    HttpClient& http_;
};

// ─── 3.15 proxy ─────────────────────────────────────────────────────────────
struct ProxyRoutingOptions {
    OptStr country;            // country-XX (OFAC refused)
    OptStr ip_class;           // class-residential|dc|mobile|masked (masked = VPN/WARP/Tor exits, opt-in)
    OptStr session_id;         // session-<1-64 alnum>
    OptStr agentic_wallet_id;  // wallet-<uuid>
    bool allow_http = false;   // allowhttp-1
};
struct ProxyFetchOptions : ProxyRoutingOptions {
    std::string method = "GET";  // GET | HEAD
    std::vector<std::pair<std::string, std::string>> headers;
    long timeout_ms = 30000;     // clamped 1..120000
    std::size_t max_bytes = 10u * 1024u * 1024u;  // clamped 1..10 MB
    OptStr api_key;
};
struct ProxyFetchResponse {
    long status = 0;
    std::string status_text;
    std::map<std::string, std::string> headers;
    std::string body;  // raw bytes
    bool truncated = false;
    const std::string& text() const { return body; }
};
/// TLS to the gateway's HTTPS proxy listener so Proxy-Authorization is encrypted; CONNECT and
/// requests run inside it. Certificate + hostname verification always on.
struct GatewayTls {
    int port = DEFAULT_TLS_PROXY_PORT;
    /// Extra PEM root for the gateway (added to the default CA store).
    std::optional<std::string> ca_pem;
    /// TLS server name / verified name (default: proxy host), e.g. when the host is an IP.
    std::optional<std::string> servername;
};

struct ProxySettings {
    std::string host;
    int http_port;
    int socks5_port;
    std::optional<GatewayTls> gateway_tls = std::nullopt;
};

std::string build_proxy_username(const ProxyRoutingOptions& opts);

/// Trust bundle for the gateway TLS connection: the system bundle with ca_pem APPENDED
/// (gatewayTls.ca adds to the system roots in every SDK; it never replaces them).
std::string gateway_trust_bundle(const std::string& system_bundle, const std::string& ca_pem);

class ProxyResource {
public:
    ProxyResource(HttpClient& h, ProxySettings s, std::function<std::string()> api_key);
    std::string build_username(const ProxyRoutingOptions& opts = {}) const;
    /// Contains the API key by design: do NOT log the result. protocol: http, https (needs
    /// gateway_tls) or socks5; empty = https when gateway_tls is configured, else http.
    std::string build_url(const ProxyRoutingOptions& opts = {}, const std::string& protocol = "",
                          const OptStr& api_key = std::nullopt) const;
    ProxyFetchResponse fetch(const std::string& url, const ProxyFetchOptions& opts = {});
    /// {status} only (the server returns only the gateway status).
    json get_health();
    json get_config();
    /// Test hook: DNS resolver used by the rebinding check.
    void set_resolver(Resolver r) { resolver_ = std::move(r); }
private:
    std::string key(const OptStr& override_key) const;
    HttpClient& http_;
    ProxySettings settings_;
    std::function<std::string()> api_key_;
    Resolver resolver_;
};

} // namespace dominusnode
