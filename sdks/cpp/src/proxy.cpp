// Proxy gateway helpers: username/URL builder and the GET/HEAD fetch helper.
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include "dominusnode/resources.hpp"
#include "dominusnode/constants.hpp"
#include "dominusnode/errors.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <fstream>
#include <memory>
#include <sstream>
#include <vector>
#include <regex>

namespace dominusnode {

std::string gateway_trust_bundle(const std::string& system_bundle, const std::string& ca_pem) {
    std::string out = system_bundle;
    if (!out.empty() && out.back() != '\n') out.push_back('\n');
    out += ca_pem;
    return out;
}

std::string build_proxy_username(const ProxyRoutingOptions& o) {
    std::vector<std::string> parts;
    if (o.country) {
        static const std::regex cc("^[A-Za-z]{2}$");
        if (!std::regex_match(*o.country, cc)) throw invalid_arg("country must be a 2-letter ISO code");
        std::string c = to_upper(*o.country);
        if (c == "CU" || c == "IR" || c == "KP" || c == "RU" || c == "SY") {
            throw invalid_arg("country " + c + " is sanctioned (OFAC) and cannot be targeted");
        }
        parts.push_back("country-" + c);
    }
    if (o.ip_class) {
        if (*o.ip_class != "residential" && *o.ip_class != "dc" && *o.ip_class != "mobile") {
            throw invalid_arg("ipClass must be residential, dc or mobile");
        }
        parts.push_back("class-" + *o.ip_class);
    }
    if (o.session_id) {
        static const std::regex sid("^[A-Za-z0-9]{1,64}$");
        if (!std::regex_match(*o.session_id, sid)) throw invalid_arg("sessionId must be 1-64 alphanumeric characters");
        parts.push_back("session-" + *o.session_id);
    }
    if (o.agentic_wallet_id) {
        if (!is_uuid(*o.agentic_wallet_id)) throw invalid_arg("agenticWalletId must be a UUID");
        parts.push_back("wallet-" + to_lower(*o.agentic_wallet_id));
    }
    if (o.allow_http) parts.push_back("allowhttp-1");
    if (parts.empty()) return "relay";
    std::string out = parts[0];
    for (std::size_t i = 1; i < parts.size(); ++i) out += "-" + parts[i];
    return out;
}

static int valid_port(int p, const std::string& name) {
    if (p < 1 || p > 65535) throw invalid_arg(name + " must be a TCP port");
    return p;
}

ProxyResource::ProxyResource(HttpClient& h, ProxySettings s, std::function<std::string()> api_key)
    : http_(h), settings_(std::move(s)), api_key_(std::move(api_key)) {
    static const std::regex host_re("^[A-Za-z0-9.-]{1,253}$|^\\[[0-9A-Fa-f:.]+\\]$");
    if (!std::regex_match(settings_.host, host_re)) throw invalid_arg("proxyHost contains invalid characters");
    valid_port(settings_.http_port, "httpProxyPort");
    valid_port(settings_.socks5_port, "socks5ProxyPort");
    if (settings_.gateway_tls) {
        valid_port(settings_.gateway_tls->port, "gatewayTls.port");
        static const std::regex sn_re("^[A-Za-z0-9.-]{1,253}$");
        if (settings_.gateway_tls->servername && !std::regex_match(*settings_.gateway_tls->servername, sn_re)) {
            throw invalid_arg("gatewayTls.servername is invalid");
        }
        if (settings_.gateway_tls->ca_pem && settings_.gateway_tls->ca_pem->find("-----BEGIN CERTIFICATE-----") == std::string::npos) {
            throw invalid_arg("gatewayTls.ca must be a PEM certificate");
        }
    }
}

std::string ProxyResource::key(const OptStr& override_key) const {
    std::string k = override_key ? *override_key : (api_key_ ? api_key_() : "");
    if (k.empty()) throw AuthenticationError("proxy access needs an API key: call connect_with_key() or pass api_key");
    return validate_api_key(k);
}

std::string ProxyResource::build_username(const ProxyRoutingOptions& opts) const { return build_proxy_username(opts); }

std::string ProxyResource::build_url(const ProxyRoutingOptions& opts, const std::string& protocol, const OptStr& api_key) const {
    const std::string proto = protocol.empty() ? (settings_.gateway_tls ? "https" : "http") : protocol;
    if (proto != "http" && proto != "https" && proto != "socks5") throw invalid_arg("protocol must be http, https or socks5");
    if (proto == "https" && !settings_.gateway_tls) throw invalid_arg("protocol https needs the gateway_tls config");
    int port = proto == "socks5" ? settings_.socks5_port : proto == "https" ? settings_.gateway_tls->port : settings_.http_port;
    std::string user = build_proxy_username(opts);
    return proto + "://" + url_encode(user) + ":" + url_encode(key(api_key)) + "@" + settings_.host + ":" + std::to_string(port);
}

json ProxyResource::get_health() { return http_.get("/api/proxy/health", AuthMode::None); }
json ProxyResource::get_config() { return http_.get("/api/proxy/config", AuthMode::Jwt); }

// ─── fetch ──────────────────────────────────────────────────────────────────

namespace {

struct FetchCapture {
    ProxyFetchResponse* res;
    std::size_t max_bytes;
};

size_t fetch_header_cb(char* buf, size_t size, size_t n, void* ud) {
    auto* c = static_cast<FetchCapture*>(ud);
    size_t total = size * n;
    std::string line(buf, total);
    while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
    if (line.rfind("HTTP/", 0) == 0) {
        c->res->headers.clear();
        auto s1 = line.find(' ');
        auto s2 = s1 == std::string::npos ? s1 : line.find(' ', s1 + 1);
        c->res->status_text = s2 == std::string::npos ? "" : line.substr(s2 + 1);
        return total;
    }
    auto colon = line.find(':');
    if (colon != std::string::npos) {
        std::string k = to_lower(line.substr(0, colon));
        std::string v = line.substr(colon + 1);
        v.erase(0, v.find_first_not_of(" \t"));
        auto it = c->res->headers.find(k);
        if (it != c->res->headers.end()) it->second += ", " + v;
        else c->res->headers[k] = v;
    }
    return total;
}

size_t fetch_write_cb(char* ptr, size_t size, size_t n, void* ud) {
    auto* c = static_cast<FetchCapture*>(ud);
    size_t total = size * n;
    std::string& body = c->res->body;
    if (body.size() + total > c->max_bytes) {
        body.append(ptr, c->max_bytes - body.size());
        c->res->truncated = true;
        return 0;  // stop the transfer
    }
    body.append(ptr, total);
    return total;
}

/// Contents of libcurl's default CA bundle (empty if none can be read).
std::string default_ca_bundle(CURL* c) {
    std::vector<std::string> paths;
#if LIBCURL_VERSION_NUM >= 0x075400
    char* p = nullptr;
    if (curl_easy_getinfo(c, CURLINFO_CAINFO, &p) == CURLE_OK && p) paths.emplace_back(p);
#else
    (void)c;
#endif
    for (const char* f : {"/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt",
                          "/etc/ssl/cert.pem", "/etc/ssl/ca-bundle.pem"}) paths.emplace_back(f);
    for (const auto& path : paths) {
        std::ifstream in(path, std::ios::binary);
        if (!in) continue;
        std::ostringstream ss;
        ss << in.rdbuf();
        if (ss.str().find("-----BEGIN CERTIFICATE-----") != std::string::npos) return ss.str();
    }
    return {};
}

bool is_ip_literal(const std::string& h) {
    if (!h.empty() && h.front() == '[') return true;
    unsigned char buf[sizeof(in6_addr)];
    return inet_pton(AF_INET, h.c_str(), buf) == 1;
}

std::string resolve_first(const std::string& host) {
    addrinfo hints{};
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* res = nullptr;
    if (getaddrinfo(host.c_str(), nullptr, &hints, &res) != 0 || !res) throw ProxyError("DNS resolution failed for the proxy host");
    char out[INET6_ADDRSTRLEN] = {0};
    std::string addr;
    if (res->ai_family == AF_INET6) {
        inet_ntop(AF_INET6, &reinterpret_cast<sockaddr_in6*>(res->ai_addr)->sin6_addr, out, sizeof out);
        addr = std::string("[") + out + "]";
    } else {
        inet_ntop(AF_INET, &reinterpret_cast<sockaddr_in*>(res->ai_addr)->sin_addr, out, sizeof out);
        addr = out;
    }
    freeaddrinfo(res);
    return addr;
}

void clean_headers(const std::vector<std::pair<std::string, std::string>>& in,
                   std::vector<std::pair<std::string, std::string>>& out) {
    static const std::regex token_re("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$");
    static const char* forbidden[] = {"host", "connection", "content-length", "transfer-encoding", "proxy-authorization",
                                      "proxy-connection", "authorization", "upgrade", "te", "trailer", "keep-alive"};
    for (const auto& [k, v] : in) {
        bool bad_char = k.find_first_of(std::string("\r\n\0", 3)) != std::string::npos ||
                        v.find_first_of(std::string("\r\n\0", 3)) != std::string::npos;
        if (bad_char || !std::regex_match(k, token_re)) {
            throw invalid_arg("header \"" + k.substr(0, 40) + "\" contains invalid characters");
        }
        std::string lk = to_lower(k);
        if (std::find(std::begin(forbidden), std::end(forbidden), lk) == std::end(forbidden)) out.emplace_back(k, v);
    }
}

}  // namespace

ProxyFetchResponse ProxyResource::fetch(const std::string& url, const ProxyFetchOptions& opts) {
    std::string method = to_upper(opts.method.empty() ? "GET" : opts.method);
    if (method != "GET" && method != "HEAD") throw invalid_arg("proxy.fetch only allows GET and HEAD");
    TargetUrl target = validate_target_url(url);
    if (target.scheme == "http" && !opts.allow_http) {
        throw invalid_arg("plaintext http:// requires allow_http (the exit node can read and modify it); prefer https://");
    }
    std::string username = build_proxy_username(opts);
    std::vector<std::pair<std::string, std::string>> headers;
    clean_headers(opts.headers, headers);
    long timeout_ms = std::min(std::max(opts.timeout_ms, 1L), 120000L);
    std::size_t max_bytes = std::min(std::max<std::size_t>(opts.max_bytes, 1), MAX_RESPONSE_BYTES);
    std::string api_key = key(opts.api_key);
    assert_public_resolution(target.host, resolver_);

    ProxyFetchResponse res;
    FetchCapture cap{&res, max_bytes};
    std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> h(curl_easy_init(), curl_easy_cleanup);
    if (!h) throw ProxyError("Failed to initialize libcurl");
    CURL* c = h.get();
    // TLS verification explicit (certificate + hostname, TLS >= 1.2); never follow redirects.
    curl_easy_setopt(c, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(c, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(c, CURLOPT_SSLVERSION, static_cast<long>(CURL_SSLVERSION_TLSv1_2));
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(c, CURLOPT_PROTOCOLS_STR, "http,https");
    curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(c, CURLOPT_URL, target.url.c_str());

    std::string proxy = "http://" + settings_.host + ":" + std::to_string(settings_.http_port);
    struct curl_slist* resolve = nullptr;
    if (settings_.gateway_tls) {
        // HTTPS proxy: TLS to the gateway (verified), CONNECT / requests inside it.
        const GatewayTls& g = *settings_.gateway_tls;
        const std::string port = std::to_string(g.port);
        if (g.servername) {
            // Connect to proxy_host but verify and send SNI for servername: pin the name to the host's address.
            std::string addr = settings_.host;
            if (!is_ip_literal(addr)) addr = resolve_first(addr);
            proxy = "https://" + *g.servername + ":" + port;
            resolve = curl_slist_append(resolve, (*g.servername + ":" + port + ":" + addr).c_str());
            curl_easy_setopt(c, CURLOPT_RESOLVE, resolve);
        } else {
            proxy = "https://" + settings_.host + ":" + port;
        }
        curl_easy_setopt(c, CURLOPT_PROXY_SSL_VERIFYPEER, 1L);
        curl_easy_setopt(c, CURLOPT_PROXY_SSL_VERIFYHOST, 2L);
        curl_easy_setopt(c, CURLOPT_PROXY_SSLVERSION, static_cast<long>(CURL_SSLVERSION_TLSv1_2));
        if (g.ca_pem) {
            // CAINFO_BLOB replaces the trust store; ca is ADDED to the system roots
            // (cross-SDK contract), so prepend the default bundle.
            const std::string bundle = gateway_trust_bundle(default_ca_bundle(c), *g.ca_pem);
            curl_blob blob{const_cast<char*>(bundle.data()), bundle.size(), CURL_BLOB_COPY};
            curl_easy_setopt(c, CURLOPT_PROXY_CAINFO_BLOB, &blob);
        }
    }
    curl_easy_setopt(c, CURLOPT_PROXY, proxy.c_str());
    curl_easy_setopt(c, CURLOPT_PROXYTYPE, static_cast<long>(settings_.gateway_tls ? CURLPROXY_HTTPS : CURLPROXY_HTTP));
    curl_easy_setopt(c, CURLOPT_NOPROXY, "");  // the gateway is never bypassed via NO_PROXY
    curl_easy_setopt(c, CURLOPT_PROXYAUTH, static_cast<long>(CURLAUTH_BASIC));
    curl_easy_setopt(c, CURLOPT_PROXYUSERNAME, username.c_str());
    curl_easy_setopt(c, CURLOPT_PROXYPASSWORD, api_key.c_str());
    curl_easy_setopt(c, CURLOPT_HTTPPROXYTUNNEL, target.scheme == "https" ? 1L : 0L);
    curl_easy_setopt(c, CURLOPT_SUPPRESS_CONNECT_HEADERS, 1L);
    curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, timeout_ms);
    if (method == "HEAD") curl_easy_setopt(c, CURLOPT_NOBODY, 1L);
    curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, fetch_header_cb);
    curl_easy_setopt(c, CURLOPT_HEADERDATA, &cap);
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, fetch_write_cb);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &cap);

    struct curl_slist* hl = nullptr;
    for (const auto& [k, v] : headers) hl = curl_slist_append(hl, (k + ": " + v).c_str());
    hl = curl_slist_append(hl, "Connection: close");
    hl = curl_slist_append(hl, "Proxy-Connection:");
    curl_easy_setopt(c, CURLOPT_HTTPHEADER, hl);

    CURLcode rc = curl_easy_perform(c);
    curl_slist_free_all(hl);
    curl_slist_free_all(resolve);
    secure_zero_string(api_key);
    long connect_code = 0;
    curl_easy_getinfo(c, CURLINFO_HTTP_CONNECTCODE, &connect_code);
    curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &res.status);

    if (target.scheme == "https" && connect_code != 0 && connect_code != 200) {
        throw ProxyError("Proxy refused CONNECT (HTTP " + std::to_string(connect_code) + ")", static_cast<int>(connect_code));
    }
    if (rc == CURLE_WRITE_ERROR && res.truncated) return res;
    if (rc == CURLE_OPERATION_TIMEDOUT) throw ProxyError("Proxy request timed out after " + std::to_string(timeout_ms) + "ms");
    if (rc != CURLE_OK) throw ProxyError(std::string("Proxy request failed: ") + curl_easy_strerror(rc));
    return res;
}

}  // namespace dominusnode
