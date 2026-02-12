#pragma once

#include "dominode/auth.hpp"
#include "dominode/keys.hpp"
#include "dominode/wallet.hpp"
#include "dominode/usage.hpp"
#include "dominode/plans.hpp"
#include "dominode/sessions.hpp"
#include "dominode/proxy.hpp"
#include "dominode/admin.hpp"

#include <memory>
#include <string>

namespace dominode {

/// Configuration for the DomiNode client.
/// Credentials are securely zeroed on destruction.
struct ClientConfig {
    std::string base_url = "https://api.dominode.io";
    std::string api_key;
    std::string access_token;
    std::string refresh_token;
    std::string proxy_host = "proxy.dominode.io";
    int http_proxy_port = 8080;
    int socks5_proxy_port = 1080;

    ~ClientConfig();

    ClientConfig() = default;

    // R16-C1: Delete copy operations to prevent credential proliferation in memory.
    // Use move semantics to transfer ownership of credential strings.
    ClientConfig(const ClientConfig&) = delete;
    ClientConfig& operator=(const ClientConfig&) = delete;
    ClientConfig(ClientConfig&&) = default;
    ClientConfig& operator=(ClientConfig&&) = default;
};

/// Main entry point for the DomiNode C++ SDK.
///
/// Usage:
///   dominode::ClientConfig cfg;
///   cfg.base_url = "https://api.dominode.io";
///   dominode::DomiNodeClient client(cfg);
///
///   // Connect with API key (for proxy usage):
///   client.connect_with_key("dn_live_xxxxx");
///
///   // Or connect with credentials (for dashboard):
///   client.connect_with_credentials("user@example.com", "password");
///
///   // Access resources:
///   auto balance = client.wallet().get_balance();
///   auto keys = client.keys().list();
///
/// The client uses the Pimpl pattern for ABI stability. All token memory
/// is securely zeroed on destruction via explicit_bzero.
class DomiNodeClient {
public:
    /// Construct a client with the given configuration.
    explicit DomiNodeClient(ClientConfig config = {});

    /// Destructor. Securely clears all token memory.
    ~DomiNodeClient();

    // Non-copyable, movable.
    DomiNodeClient(const DomiNodeClient&) = delete;
    DomiNodeClient& operator=(const DomiNodeClient&) = delete;
    DomiNodeClient(DomiNodeClient&&) noexcept;
    DomiNodeClient& operator=(DomiNodeClient&&) noexcept;

    /// Authenticate using an API key. Calls verify-key to get JWT tokens.
    void connect_with_key(const std::string& api_key);

    /// Authenticate using email and password. Gets JWT tokens.
    void connect_with_credentials(const std::string& email, const std::string& password);

    /// Clear authentication state.
    void disconnect();

    /// Access the auth resource (register, login, MFA, etc.).
    AuthResource& auth();

    /// Access the API keys resource.
    KeysResource& keys();

    /// Access the wallet resource (balance, transactions, top-up).
    WalletResource& wallet();

    /// Access the usage resource (records, daily, top hosts, CSV export).
    UsageResource& usage();

    /// Access the plans resource (list, get/change user plan).
    PlansResource& plans();

    /// Access the sessions resource (active proxy sessions).
    SessionsResource& sessions();

    /// Access the proxy resource (config, health, URL builder).
    ProxyResource& proxy();

    /// Access the admin resource (user management, revenue, stats).
    AdminResource& admin();

    /// Get the configured base URL.
    const std::string& base_url() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace dominode
