#include "dominode/client.hpp"
#include "dominode/http_client.hpp"
#include "dominode/token_manager.hpp"
#include "dominode/errors.hpp"

#include <cstring>

#if defined(__linux__) || defined(__APPLE__)
#include <strings.h>
#endif

namespace dominode {

// Portably zero a string's memory (credential cleanup).
static void secure_zero_string(std::string& s) {
    if (s.empty() && s.capacity() == 0) return;
    size_t cap = s.capacity();
#if defined(__linux__) || (defined(__APPLE__) && defined(__MACH__))
    explicit_bzero(s.data(), cap);
#elif defined(_WIN32)
    SecureZeroMemory(s.data(), cap);
#else
    volatile char* p = reinterpret_cast<volatile char*>(s.data());
    for (size_t i = 0; i < cap; ++i) {
        p[i] = 0;
    }
#endif
    s.clear();
    s.shrink_to_fit();
}

ClientConfig::~ClientConfig() {
    secure_zero_string(api_key);
    secure_zero_string(access_token);
    secure_zero_string(refresh_token);
}

// ─── Pimpl definition ───────────────────────────────────────────────────────

struct DomiNodeClient::Impl {
    ClientConfig config;
    TokenManager token_manager;
    HttpClient http_client;
    AuthResource auth_resource;
    KeysResource keys_resource;
    WalletResource wallet_resource;
    UsageResource usage_resource;
    PlansResource plans_resource;
    SessionsResource sessions_resource;
    ProxyResource proxy_resource;
    AdminResource admin_resource;

    explicit Impl(ClientConfig cfg)
        : config(std::move(cfg))
        , http_client(config.base_url, token_manager)
        , auth_resource(http_client)
        , keys_resource(http_client)
        , wallet_resource(http_client)
        , usage_resource(http_client)
        , plans_resource(http_client)
        , sessions_resource(http_client)
        , proxy_resource(http_client, config.proxy_host,
                         config.http_proxy_port, config.socks5_proxy_port)
        , admin_resource(http_client) {

        // Set up the token refresh function
        token_manager.set_refresh_function(
            [this](const std::string& refresh_token) -> RefreshResult {
                auto pair = auth_resource.refresh(refresh_token);
                return RefreshResult{pair.access_token,
                                     pair.refresh_token.value_or("")};
            });

        // If tokens were provided in config, set them
        if (!config.access_token.empty()) {
            token_manager.set_tokens(config.access_token, config.refresh_token);
        }
    }
};

// ─── DomiNodeClient implementation ──────────────────────────────────────────

DomiNodeClient::DomiNodeClient(ClientConfig config)
    : impl_(std::make_unique<Impl>(std::move(config))) {}

DomiNodeClient::~DomiNodeClient() = default;

DomiNodeClient::DomiNodeClient(DomiNodeClient&&) noexcept = default;
DomiNodeClient& DomiNodeClient::operator=(DomiNodeClient&&) noexcept = default;

void DomiNodeClient::connect_with_key(const std::string& api_key) {
    auto result = impl_->auth_resource.verify_key(api_key);
    if (!result.valid) {
        throw AuthenticationError("Invalid API key");
    }
    impl_->token_manager.set_tokens(result.token, result.refresh_token);
}

void DomiNodeClient::connect_with_credentials(const std::string& email, const std::string& password) {
    auto result = impl_->auth_resource.login(email, password);
    if (result.mfa_required) {
        throw AuthenticationError("MFA required - use auth().login() and auth().verify_mfa() instead");
    }
    if (result.token.has_value()) {
        impl_->token_manager.set_tokens(*result.token,
                                         result.refresh_token.value_or(""));
    } else {
        throw AuthenticationError("Login did not return tokens");
    }
}

void DomiNodeClient::disconnect() {
    try {
        impl_->auth_resource.logout();
    } catch (...) {
        // Best-effort logout
    }
    impl_->token_manager.clear();
}

AuthResource& DomiNodeClient::auth() { return impl_->auth_resource; }
KeysResource& DomiNodeClient::keys() { return impl_->keys_resource; }
WalletResource& DomiNodeClient::wallet() { return impl_->wallet_resource; }
UsageResource& DomiNodeClient::usage() { return impl_->usage_resource; }
PlansResource& DomiNodeClient::plans() { return impl_->plans_resource; }
SessionsResource& DomiNodeClient::sessions() { return impl_->sessions_resource; }
ProxyResource& DomiNodeClient::proxy() { return impl_->proxy_resource; }
AdminResource& DomiNodeClient::admin() { return impl_->admin_resource; }

const std::string& DomiNodeClient::base_url() const {
    return impl_->config.base_url;
}

} // namespace dominode
