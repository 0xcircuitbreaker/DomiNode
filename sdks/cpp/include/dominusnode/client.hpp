#pragma once

#include "dominusnode/constants.hpp"
#include "dominusnode/http_client.hpp"
#include "dominusnode/resources.hpp"

#include <optional>
#include <ostream>
#include <string>

namespace dominusnode {

struct ClientConfig {
    std::string base_url = DEFAULT_BASE_URL;
    std::string proxy_host = DEFAULT_PROXY_HOST;
    int http_proxy_port = DEFAULT_HTTP_PROXY_PORT;
    int socks5_proxy_port = DEFAULT_SOCKS5_PROXY_PORT;
    /// TLS to the gateway (HTTPS proxy); build_url then defaults to https://. Default since 2.2:
    /// GatewayTls{} (port 8443): production gateways refuse credentials on plaintext 8080/1080.
    /// Self-hosted coordinators usually publish 8444. std::nullopt selects plaintext (local dev only).
    std::optional<GatewayTls> gateway_tls = GatewayTls{};
    std::optional<std::string> access_token;
    std::optional<std::string> refresh_token;
    /// Injectable HTTP transport (tests). Default: libcurl.
    Transport transport;
};

struct ConnectResult {
    bool mfa_required = false;
    std::optional<std::string> user_id;
};

/// DominusNode relay-network client for AI agents.
///   dominusnode::DominusNodeClient dn;
///   dn.connect_with_key(std::getenv("DOMINUSNODE_API_KEY"));
///   auto r = dn.proxy.fetch("https://example.com", opts);
class DominusNodeClient {
public:
    explicit DominusNodeClient(const ClientConfig& config = {});
    ~DominusNodeClient();
    DominusNodeClient(const DominusNodeClient&) = delete;
    DominusNodeClient& operator=(const DominusNodeClient&) = delete;

    ConnectResult connect_with_key(const std::string& api_key);
    /// Best-effort logout, then zeroize API key, access and refresh token.
    void disconnect();
    bool is_connected() const;

    /// Test hook.
    HttpClient& http() { return http_; }

private:
    TokenManager tokens_;
    std::string api_key_;
    HttpClient http_;

public:
    AuthResource auth;
    WalletAuthResource wallet_auth;
    KeysResource keys;
    WalletResource wallet;
    AgenticWalletResource agentic_wallets;
    TeamsResource teams;
    UsageResource usage;
    SessionsResource sessions;
    X402Resource x402;
    NetworkResource network;
    NodesResource nodes;
    CreditsResource credits;
    PayoutWalletResource payout_wallet;
    PayoutsResource payouts;
    ProxyResource proxy;
};

inline std::ostream& operator<<(std::ostream& os, const DominusNodeClient& c) {
    return os << "DominusNodeClient(connected=" << (c.is_connected() ? "true" : "false") << ")";
}
inline void to_json(nlohmann::json& j, const DominusNodeClient& c) { j = {{"connected", c.is_connected()}}; }

} // namespace dominusnode
