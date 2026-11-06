// SSRF guards for proxy.fetch(): URL rules, private-address table, DNS-rebinding check.
#include "dominusnode/ssrf.hpp"
#include "dominusnode/errors.hpp"
#include "dominusnode/validation.hpp"

#include <arpa/inet.h>
#include <curl/curl.h>
#include <netdb.h>
#include <sys/socket.h>

#include <array>
#include <cstring>
#include <memory>
#include <regex>

namespace dominusnode {

std::vector<std::string> default_resolve(const std::string& host) {
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* res = nullptr;
    int rc = getaddrinfo(host.c_str(), nullptr, &hints, &res);
    if (rc != 0) throw std::runtime_error(gai_strerror(rc));
    std::unique_ptr<addrinfo, decltype(&freeaddrinfo)> guard(res, freeaddrinfo);
    std::vector<std::string> out;
    for (addrinfo* p = res; p; p = p->ai_next) {
        char buf[INET6_ADDRSTRLEN] = {0};
        if (p->ai_family == AF_INET) {
            inet_ntop(AF_INET, &reinterpret_cast<sockaddr_in*>(p->ai_addr)->sin_addr, buf, sizeof buf);
        } else if (p->ai_family == AF_INET6) {
            inet_ntop(AF_INET6, &reinterpret_cast<sockaddr_in6*>(p->ai_addr)->sin6_addr, buf, sizeof buf);
        } else {
            continue;
        }
        out.emplace_back(buf);
    }
    return out;
}

std::optional<std::string> normalize_ipv4(const std::string& host) {
    static const std::regex hex_re("^0[xX][0-9a-fA-F]+$"), oct_re("^0[0-7]+$"), dec_re("^(0|[1-9][0-9]*)$");
    std::vector<std::string> parts;
    std::size_t start = 0;
    while (true) {
        std::size_t dot = host.find('.', start);
        parts.push_back(host.substr(start, dot == std::string::npos ? std::string::npos : dot - start));
        if (dot == std::string::npos) break;
        start = dot + 1;
    }
    if (parts.empty() || parts.size() > 4) return std::nullopt;
    std::vector<unsigned long long> nums;
    for (const auto& p : parts) {
        if (p.size() > 20) return std::nullopt;
        unsigned long long v;
        try {
            if (std::regex_match(p, hex_re)) v = std::stoull(p.substr(2), nullptr, 16);
            else if (std::regex_match(p, oct_re)) v = std::stoull(p, nullptr, 8);
            else if (std::regex_match(p, dec_re)) v = std::stoull(p, nullptr, 10);
            else return std::nullopt;
        } catch (...) {
            return std::nullopt;
        }
        nums.push_back(v);
    }
    unsigned long long last = nums.back();
    nums.pop_back();
    for (auto n : nums) if (n > 255) return std::nullopt;
    std::size_t rem = 4 - nums.size();
    if (rem < 4 && last >= (1ULL << (8 * rem))) return std::nullopt;
    if (rem == 4 && last > 0xFFFFFFFFULL) return std::nullopt;
    std::vector<unsigned long long> bytes(nums);
    for (int i = static_cast<int>(rem) - 1; i >= 0; --i) bytes.push_back((last >> (8 * i)) & 0xFF);
    return std::to_string(bytes[0]) + "." + std::to_string(bytes[1]) + "." + std::to_string(bytes[2]) + "." +
           std::to_string(bytes[3]);
}

static bool is_private_v4(const unsigned char* b) {
    unsigned a = b[0], c = b[1];
    return a == 0 || a == 10 || a == 127 || (a == 169 && c == 254) || (a == 172 && c >= 16 && c <= 31) ||
           (a == 192 && c == 168) || (a == 100 && c >= 64 && c <= 127) ||
           (a == 192 && c == 0) /* 192.0.0.0/16 */ || (a == 198 && (c == 18 || c == 19)) || a >= 224;
}

bool is_private_ip(const std::string& host_in) {
    std::string ip = host_in;
    if (ip.size() >= 2 && ip.front() == '[' && ip.back() == ']') ip = ip.substr(1, ip.size() - 2);
    auto zone = ip.find('%');
    if (zone != std::string::npos) ip = ip.substr(0, zone);
    unsigned char b4[4];
    if (inet_pton(AF_INET, ip.c_str(), b4) == 1) return is_private_v4(b4);
    if (ip.find(':') == std::string::npos) {
        auto v4 = normalize_ipv4(ip);
        if (v4 && inet_pton(AF_INET, v4->c_str(), b4) == 1) return is_private_v4(b4);
        return false;
    }
    unsigned char b[16];
    if (inet_pton(AF_INET6, ip.c_str(), b) != 1) return false;
    bool zero10 = true;
    for (int i = 0; i < 10; ++i) zero10 = zero10 && b[i] == 0;
    if (zero10 && b[10] == 0xff && b[11] == 0xff) return is_private_v4(b + 12);  // ::ffff:a.b.c.d
    if (zero10 && b[10] == 0 && b[11] == 0) {
        if (b[12] == 0 && b[13] == 0 && b[14] == 0) return true;  // ::, ::1
        return is_private_v4(b + 12);                             // ::a.b.c.d
    }
    if (b[0] == 0 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b) return is_private_v4(b + 12);  // NAT64
    if ((b[0] & 0xfe) == 0xfc) return true;                     // fc00::/7
    if (b[0] == 0xfe && (b[1] & 0xc0) == 0x80) return true;     // fe80::/10
    if (b[0] == 0xfe && (b[1] & 0xc0) == 0xc0) return true;     // fec0::/10
    if (b[0] == 0xff) return true;                              // multicast
    if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0 && b[3] == 0) return true;        // Teredo
    if (b[0] == 0x20 && b[1] == 0x02) return true;                                  // 6to4
    if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0d && b[3] == 0xb8) return true;  // docs
    return false;
}

namespace {
struct UrlHandle {
    CURLU* h = curl_url();
    ~UrlHandle() { curl_url_cleanup(h); }
    std::optional<std::string> part(CURLUPart p, unsigned flags = 0) const {
        char* v = nullptr;
        if (curl_url_get(h, p, &v, flags) != CURLUE_OK || !v) return std::nullopt;
        std::string s(v);
        curl_free(v);
        return s;
    }
};
bool ends_with(const std::string& s, const std::string& suf) {
    return s.size() >= suf.size() && s.compare(s.size() - suf.size(), suf.size(), suf) == 0;
}
}  // namespace

TargetUrl validate_target_url(const std::string& url) {
    UrlHandle u;
    if (!u.h || url.find_first_of(" \r\n\t") != std::string::npos ||
        curl_url_set(u.h, CURLUPART_URL, url.c_str(), CURLU_NON_SUPPORT_SCHEME) != CURLUE_OK) {
        throw ProxyError("Invalid URL");
    }
    TargetUrl t;
    t.scheme = to_lower(u.part(CURLUPART_SCHEME).value_or(""));
    if (t.scheme != "http" && t.scheme != "https") throw ProxyError("Only http: and https: URLs are supported");
    if (u.part(CURLUPART_USER) || u.part(CURLUPART_PASSWORD)) {
        throw ProxyError("URLs with embedded credentials are not allowed");
    }
    t.port = u.part(CURLUPART_PORT).value_or("");
    if (!t.port.empty() && t.port != "80" && t.port != "443") {
        throw ProxyError("Only ports 80 and 443 are reachable through the relay network");
    }
    std::string host = to_lower(u.part(CURLUPART_HOST).value_or(""));
    if (host.size() >= 2 && host.front() == '[' && host.back() == ']') host = host.substr(1, host.size() - 2);
    if (!host.empty() && host.back() == '.') host.pop_back();
    if (host.empty()) throw ProxyError("URL has no host");
    if (host == "localhost" || host == "localhost.localdomain" || host == "ip6-localhost" || host == "ip6-loopback" ||
        ends_with(host, ".localhost") || ends_with(host, ".local") || ends_with(host, ".internal") ||
        ends_with(host, ".arpa")) {
        throw ProxyError("Requests to local/internal hostnames are blocked");
    }
    if (is_private_ip(host)) throw ProxyError("Requests to private/internal IP addresses are blocked");
    t.host = host;
    t.path_query = u.part(CURLUPART_PATH).value_or("/");
    if (auto q = u.part(CURLUPART_QUERY)) t.path_query += "?" + *q;
    t.url = u.part(CURLUPART_URL).value_or(url);
    return t;
}

void assert_public_resolution(const std::string& host_in, const Resolver& resolve) {
    std::string host = host_in;
    if (host.size() >= 2 && host.front() == '[' && host.back() == ']') host = host.substr(1, host.size() - 2);
    unsigned char buf[16];
    if (inet_pton(AF_INET, host.c_str(), buf) == 1 || inet_pton(AF_INET6, host.c_str(), buf) == 1) {
        if (is_private_ip(host)) throw ProxyError("Requests to private/internal IP addresses are blocked");
        return;
    }
    std::vector<std::string> addrs;
    try {
        addrs = resolve ? resolve(host) : default_resolve(host);
    } catch (...) {
        throw ProxyError("DNS resolution failed for " + host);
    }
    if (addrs.empty()) throw ProxyError("DNS resolution returned no addresses for " + host);
    for (const auto& a : addrs) {
        if (is_private_ip(a)) throw ProxyError("Hostname resolves to a private/internal IP address (blocked)");
    }
}

}  // namespace dominusnode
