#pragma once

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace dominusnode {

/// Resolves a hostname to ALL addresses (A + AAAA) as text. Throws on failure.
using Resolver = std::function<std::vector<std::string>(const std::string& host)>;
/// getaddrinfo(AF_UNSPEC) — every result.
std::vector<std::string> default_resolve(const std::string& host);

/// Decode decimal/hex/octal/short IPv4 forms (2130706433, 0x7f000001, 0177.0.0.1, 127.1).
std::optional<std::string> normalize_ipv4(const std::string& host);
/// Private/reserved address check (IPv4 in any spelling, IPv6 incl. embedded IPv4).
bool is_private_ip(const std::string& host);

struct TargetUrl {
    std::string scheme;    // "http" | "https"
    std::string host;      // lowercased, no trailing dot; IPv6 without brackets
    std::string port;      // "" | "80" | "443"
    std::string path_query;  // "/path?q"
    std::string url;       // normalised full URL
};

/// proxy.fetch() URL rules; ProxyError on refusal.
TargetUrl validate_target_url(const std::string& url);
/// DNS-rebinding guard: ProxyError if resolution fails/returns nothing or ANY address is private.
void assert_public_resolution(const std::string& host, const Resolver& resolve);

} // namespace dominusnode
