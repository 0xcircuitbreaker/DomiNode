#pragma once

#include "dominusnode/types.hpp"
#include <string>

namespace dominusnode {

class HttpClient;

/// Proxy configuration and health resource.
/// Also provides helper methods for building proxy URLs.
class ProxyResource {
public:
    ProxyResource(HttpClient& http,
                  const std::string& proxy_host,
                  int http_proxy_port,
                  int socks5_proxy_port);

    /// Get proxy server configuration (countries, geo-targeting, endpoints).
    ProxyConfig get_config();

    /// Get public proxy health status.
    ProxyHealth get_health();

    /// Get detailed proxy status (requires auth).
    ProxyStatus get_status();

    /// Build a proxy URL for use with HTTP clients.
    /// Format: protocol://username:api_key@host:port
    std::string build_url(const std::string& api_key,
                          const ProxyUrlOptions& options = {}) const;

    /// Get the configured proxy host.
    const std::string& proxy_host() const { return proxy_host_; }

    /// Get the configured HTTP proxy port.
    int http_proxy_port() const { return http_proxy_port_; }

    /// Get the configured SOCKS5 proxy port.
    int socks5_proxy_port() const { return socks5_proxy_port_; }

private:
    HttpClient& http_;
    std::string proxy_host_;
    int http_proxy_port_;
    int socks5_proxy_port_;
};

} // namespace dominusnode
