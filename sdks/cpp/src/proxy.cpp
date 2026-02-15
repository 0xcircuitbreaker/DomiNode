#include "dominusnode/proxy.hpp"
#include "dominusnode/http_client.hpp"

#include <sstream>
#include <iomanip>
#include <cctype>

namespace dominusnode {

// URL-encode a string for safe inclusion in proxy URLs
static std::string url_encode(const std::string& value) {
    std::ostringstream encoded;
    encoded.fill('0');
    encoded << std::hex;
    for (unsigned char c : value) {
        // Keep unreserved characters per RFC 3986
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            encoded << c;
        } else {
            encoded << '%' << std::uppercase << std::setw(2)
                    << static_cast<int>(c) << std::nouppercase;
        }
    }
    return encoded.str();
}

ProxyResource::ProxyResource(HttpClient& http,
                              const std::string& proxy_host,
                              int http_proxy_port,
                              int socks5_proxy_port)
    : http_(http)
    , proxy_host_(proxy_host)
    , http_proxy_port_(http_proxy_port)
    , socks5_proxy_port_(socks5_proxy_port) {}

ProxyConfig ProxyResource::get_config() {
    auto resp = http_.get("/api/proxy/config");
    return resp.get<ProxyConfig>();
}

ProxyHealth ProxyResource::get_health() {
    auto resp = http_.get("/api/proxy/health", false);
    return resp.get<ProxyHealth>();
}

ProxyStatus ProxyResource::get_status() {
    auto resp = http_.get("/api/proxy/status");
    return resp.get<ProxyStatus>();
}

std::string ProxyResource::build_url(const std::string& api_key,
                                      const ProxyUrlOptions& options) const {
    // Build username from geo/session options
    // Format: user-country-XX-state-YY-city-ZZ-session-ID
    std::ostringstream username;
    username << "user";

    if (!options.country.empty()) {
        username << "-country_" << url_encode(options.country);
    }
    if (!options.state.empty()) {
        username << "-state_" << url_encode(options.state);
    }
    if (!options.city.empty()) {
        username << "-city_" << url_encode(options.city);
    }
    if (options.asn.has_value()) {
        username << "-asn_" << *options.asn;
    }
    if (!options.session_id.empty()) {
        username << "-session_" << url_encode(options.session_id);
    }

    // Determine protocol and port
    std::string protocol = options.protocol.empty() ? "http" : options.protocol;
    int port = (protocol == "socks5") ? socks5_proxy_port_ : http_proxy_port_;
    std::string scheme = (protocol == "socks5") ? "socks5" : "http";

    std::ostringstream url;
    // R14 C-2: Don't double-encode username — individual components are already encoded
    url << scheme << "://" << username.str() << ":" << url_encode(api_key)
        << "@" << proxy_host_ << ":" << port;

    return url.str();
}

} // namespace dominusnode
