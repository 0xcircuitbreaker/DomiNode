#pragma once

#include "dominusnode/auth.hpp"
#include "dominusnode/keys.hpp"
#include "dominusnode/wallet.hpp"
#include "dominusnode/usage.hpp"
#include "dominusnode/plans.hpp"
#include "dominusnode/sessions.hpp"
#include "dominusnode/proxy.hpp"
#include "dominusnode/admin.hpp"
#include "dominusnode/slots.hpp"
#include "dominusnode/agent_wallet.hpp"
#include "dominusnode/teams.hpp"
#include "dominusnode/x402.hpp"
#include "dominusnode/wallet_auth.hpp"

#include <memory>
#include <string>

namespace dominusnode {

/// Configuration for the Dominus Node client.
/// Credentials are securely zeroed on destruction.
struct ClientConfig {
    std::string base_url = "https://api.dominusnode.com";
    std::string api_key;
    std::string access_token;
    std::string refresh_token;
    std::string proxy_host = "proxy.dominusnode.com";
    int http_proxy_port = 8080;
    int socks5_proxy_port = 1080;

    ~ClientConfig();

    ClientConfig() = default;

    // Delete copy operations to prevent credential proliferation in memory.
    // Use move semantics to transfer ownership of credential strings.
    ClientConfig(const ClientConfig&) = delete;
    ClientConfig& operator=(const ClientConfig&) = delete;
    ClientConfig(ClientConfig&&) = default;
    ClientConfig& operator=(ClientConfig&&) = default;
};

/// Main entry point for the Dominus Node C++ SDK.
///
/// Usage:
///   dominusnode::ClientConfig cfg;
///   cfg.base_url = "https://api.dominusnode.com";
///   dominusnode::DominusNodeClient client(cfg);
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
class DominusNodeClient {
public:
    /// Construct a client with the given configuration.
    explicit DominusNodeClient(ClientConfig config = {});

    /// Destructor. Securely clears all token memory.
    ~DominusNodeClient();

    // Non-copyable, movable.
    DominusNodeClient(const DominusNodeClient&) = delete;
    DominusNodeClient& operator=(const DominusNodeClient&) = delete;
    DominusNodeClient(DominusNodeClient&&) noexcept;
    DominusNodeClient& operator=(DominusNodeClient&&) noexcept;

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

    /// Access the slots resource (slot availability, waitlist — no auth required).
    SlotsResource& slots();

    /// Access the agentic wallet resource (sub-wallets with spending limits).
    AgenticWalletResource& agentic_wallets();

    /// Access the teams resource (shared wallets, members, invites, keys).
    TeamsResource& teams();

    /// Access the x402 resource (HTTP 402 micropayment protocol info).
    X402Resource& x402();

    /// Access the wallet auth resource (EIP-191 wallet-based authentication).
    WalletAuthResource& wallet_auth();

    /// Get the configured base URL.
    const std::string& base_url() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace dominusnode
