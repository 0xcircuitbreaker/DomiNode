#include "dominusnode/client.hpp"
#include "dominusnode/errors.hpp"
#include "dominusnode/secret.hpp"

namespace dominusnode {

DominusNodeClient::DominusNodeClient(const ClientConfig& config)
    : http_(config.base_url, tokens_, [this] { return api_key_; }, config.transport),
      auth(http_),
      wallet_auth(http_, tokens_),
      keys(http_),
      wallet(http_),
      agentic_wallets(http_),
      teams(http_),
      usage(http_),
      sessions(http_),
      x402(http_),
      network(http_),
      nodes(http_),
      credits(http_),
      payout_wallet(http_),
      payouts(http_),
      proxy(http_, ProxySettings{config.proxy_host, config.http_proxy_port, config.socks5_proxy_port, config.gateway_tls},
            [this] { return api_key_; }) {
    // Never cleared (TokenManager::clear() keeps it) so reconnecting works.
    tokens_.set_refresh_function([this](const std::string& rt) {
        json r = auth.refresh(rt);
        if (!r.contains("token") || !r["token"].is_string()) throw AuthenticationError("refresh returned no token");
        RefreshResult out{r["token"].get<std::string>(), std::nullopt};
        if (r.contains("refreshToken") && r["refreshToken"].is_string()) out.refresh_token = r["refreshToken"].get<std::string>();
        return out;
    });
    if (config.access_token) tokens_.set_tokens(*config.access_token, config.refresh_token);
}

DominusNodeClient::~DominusNodeClient() {
    secure_zero_string(api_key_);
    tokens_.clear();
}

ConnectResult DominusNodeClient::connect_with_key(const std::string& api_key) {
    validate_api_key(api_key);
    try {
        json r = auth.verify_key(api_key);
        if (!r.contains("token") || !r["token"].is_string()) throw ProtocolError("verify-key returned no token");
        secure_zero_string(api_key_);
        api_key_ = api_key;
        std::optional<std::string> rt;
        if (r.contains("refreshToken") && r["refreshToken"].is_string()) rt = r["refreshToken"].get<std::string>();
        tokens_.set_tokens(r["token"].get<std::string>(), rt);
        ConnectResult out;
        if (r.contains("userId") && r["userId"].is_string()) out.user_id = r["userId"].get<std::string>();
        return out;
    } catch (const DominusNodeError& e) {
        if (e.code() && *e.code() == "MFA_REQUIRED") {
            secure_zero_string(api_key_);
            api_key_ = api_key;
            return ConnectResult{true, std::nullopt};
        }
        throw;
    }
}

bool DominusNodeClient::is_connected() const { return !api_key_.empty() || tokens_.has_tokens(); }

void DominusNodeClient::disconnect() {
    if (tokens_.has_tokens()) {
        try {
            auth.logout();
        } catch (...) {
            // best effort
        }
    }
    secure_zero_string(api_key_);
    tokens_.clear();
}

}  // namespace dominusnode
