// CONNECT tunnel integrity (no direct dial to the target) and gateway_tls (TLS to the gateway).
#include "test_util.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <openssl/err.h>
#include <openssl/ssl.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <fstream>
#include <mutex>
#include <sstream>
#include <thread>

using namespace t;

namespace {

struct Cert {
    std::string dir, crt, key, pem;
};

const Cert& cert() {
    static Cert c = [] {
        char tmpl[] = "/tmp/dn-cpp-tls-XXXXXX";
        Cert x;
        x.dir = mkdtemp(tmpl);
        x.crt = x.dir + "/gw.crt";
        x.key = x.dir + "/gw.key";
        std::string cmd = "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost "
                          "-addext subjectAltName=DNS:localhost,IP:127.0.0.1 -keyout " + x.key + " -out " + x.crt +
                          " >/dev/null 2>&1";
        if (std::system(cmd.c_str()) != 0) throw std::runtime_error("openssl req failed");
        std::ifstream in(x.crt);
        std::stringstream ss;
        ss << in.rdbuf();
        x.pem = ss.str();
        return x;
    }();
    return c;
}

/// Fake gateway (plain or TLS). After a 200 to CONNECT it records the first bytes the client sends on
/// the SAME connection: a TLS ClientHello there proves the inner TLS rides the tunnel.
class Gateway {
public:
    Gateway(bool tls, std::string http_resp) : http_resp_(std::move(http_resp)) {
        std::signal(SIGPIPE, SIG_IGN);  // SSL_write to a client that already hung up
        if (tls) {
            ctx_ = SSL_CTX_new(TLS_server_method());
            SSL_CTX_use_certificate_file(ctx_, cert().crt.c_str(), SSL_FILETYPE_PEM);
            SSL_CTX_use_PrivateKey_file(ctx_, cert().key.c_str(), SSL_FILETYPE_PEM);
        }
        fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (::bind(fd_, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0 || ::listen(fd_, 8) != 0) throw std::runtime_error("bind");
        socklen_t len = sizeof a;
        getsockname(fd_, reinterpret_cast<sockaddr*>(&a), &len);
        port_ = ntohs(a.sin_port);
        thread_ = std::thread([this] { loop(); });
    }
    ~Gateway() {
        ::shutdown(fd_, SHUT_RDWR);
        ::close(fd_);
        if (thread_.joinable()) thread_.join();
        if (ctx_) SSL_CTX_free(ctx_);
    }
    int port() const { return port_; }
    int accepted() const { return accepted_; }
    std::vector<std::string> heads() { std::lock_guard<std::mutex> l(mu_); return heads_; }
    std::vector<std::string> tunneled() { std::lock_guard<std::mutex> l(mu_); return tunneled_; }

private:
    void loop() {
        while (true) {
            int c = ::accept(fd_, nullptr, nullptr);
            if (c < 0) return;
            ++accepted_;
            timeval tv{3, 0};
            setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
            SSL* ssl = nullptr;
            if (ctx_) {
                ssl = SSL_new(ctx_);
                SSL_set_fd(ssl, c);
                if (SSL_accept(ssl) != 1) { SSL_free(ssl); ::close(c); continue; }
            }
            auto rd = [&](char* b, int n) { return ssl ? SSL_read(ssl, b, n) : static_cast<int>(::recv(c, b, n, 0)); };
            auto wr = [&](const std::string& s) { if (ssl) SSL_write(ssl, s.data(), static_cast<int>(s.size())); else ::send(c, s.data(), s.size(), MSG_NOSIGNAL); };
            std::string head;
            char ch;
            while (head.size() < 65536 && (head.size() < 4 || head.compare(head.size() - 4, 4, "\r\n\r\n") != 0)) {
                if (rd(&ch, 1) != 1) break;
                head += ch;
            }
            { std::lock_guard<std::mutex> l(mu_); heads_.push_back(head); }
            if (head.rfind("CONNECT ", 0) == 0) {
                wr("HTTP/1.1 200 Connection Established\r\n\r\n");
                char buf[8192];
                int n = rd(buf, sizeof buf);
                std::lock_guard<std::mutex> l(mu_);
                tunneled_.emplace_back(buf, n > 0 ? static_cast<size_t>(n) : 0);
            } else {
                wr(http_resp_);
            }
            if (ssl) { SSL_shutdown(ssl); SSL_free(ssl); }
            ::shutdown(c, SHUT_RDWR);
            ::close(c);
        }
    }
    std::string http_resp_;
    SSL_CTX* ctx_ = nullptr;
    int fd_ = -1;
    int port_ = 0;
    std::atomic<int> accepted_{0};
    std::thread thread_;
    std::mutex mu_;
    std::vector<std::string> heads_, tunneled_;
};

std::unique_ptr<DominusNodeClient> make_client(const std::string& host, int http_port, std::optional<GatewayTls> g) {
    ClientConfig cfg;
    cfg.base_url = "https://api.test";
    cfg.proxy_host = host;
    if (http_port) cfg.http_proxy_port = http_port;
    cfg.gateway_tls = std::move(g);
    cfg.transport = [](const HttpRequest&) { return HttpResponse{200, {}, R"({"token":"x"})"}; };
    auto c = std::make_unique<DominusNodeClient>(cfg);
    c->connect_with_key(KEY);
    c->proxy.set_resolver([](const std::string&) { return std::vector<std::string>{"93.184.216.34"}; });
    return c;
}

void check_client_hello(const std::string& data, const std::string& sni) {
    CHECK(!data.empty() && static_cast<unsigned char>(data[0]) == 0x16);
    CHECK(data.find(sni) != std::string::npos);
}

ProxyFetchOptions fopts() {
    ProxyFetchOptions o;
    o.timeout_ms = 3000;
    return o;
}

}  // namespace

TEST(https_rides_connect_tunnel_plain_gateway) {
    Gateway gw(false, "");
    auto c = make_client("127.0.0.1", gw.port(), std::nullopt);
    CHECK_THROWS(c->proxy.fetch("https://example.com/x", fopts()), ProxyError);
    CHECK_EQ(gw.accepted(), 1);
    CHECK(gw.heads()[0].rfind("CONNECT example.com:443 HTTP/1.1\r\n", 0) == 0);
    check_client_hello(gw.tunneled()[0], "example.com");
}

TEST(gateway_tls_connect_inside_tls) {
    Gateway gw(true, "");
    GatewayTls g;
    g.port = gw.port();
    g.ca_pem = cert().pem;
    auto c = make_client("localhost", 0, g);
    auto o = fopts();
    o.country = "US";
    try {
        c->proxy.fetch("https://example.com/x", o);
        fail("expected inner TLS failure (fake target cert)", __FILE__, __LINE__);
    } catch (const ProxyError& e) {
        CHECK(std::string(e.what()).find(KEY) == std::string::npos);
    }
    auto heads = gw.heads();
    CHECK(!heads.empty() && heads[0].rfind("CONNECT example.com:443 HTTP/1.1\r\n", 0) == 0);
    CHECK(heads[0].find("Proxy-Authorization: Basic ") != std::string::npos);
    check_client_hello(gw.tunneled()[0], "example.com");
}

TEST(gateway_tls_http_with_ip_host_and_servername) {
    Gateway gw(true, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi");
    GatewayTls g;
    g.port = gw.port();
    g.ca_pem = cert().pem;
    g.servername = "localhost";
    auto c = make_client("127.0.0.1", 0, g);
    auto o = fopts();
    o.allow_http = true;
    auto r = c->proxy.fetch("http://example.com/p", o);
    CHECK_EQ(r.body, std::string("hi"));
    CHECK(gw.heads()[0].rfind("GET http://example.com/p HTTP/1.1\r\n", 0) == 0);
}

TEST(gateway_tls_unverified_refused_before_sending) {
    Gateway gw(true, "");
    GatewayTls no_ca;
    no_ca.port = gw.port();
    GatewayTls bad_name = no_ca;
    bad_name.ca_pem = cert().pem;
    bad_name.servername = "other.example";
    for (const auto& g : {no_ca, bad_name}) {
        auto c = make_client("localhost", 0, g);
        CHECK_THROWS(c->proxy.fetch("https://example.com/", fopts()), ProxyError);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    // TLS 1.3 may finish the server handshake before the client rejects the cert; no bytes may follow.
    for (const auto& h : gw.heads()) CHECK(h.empty());
}

TEST(gateway_tls_build_url_and_config) {
    auto c = make_client("proxy.example.com", 0, GatewayTls{});
    CHECK_EQ(c->proxy.build_url(), "https://relay:" + KEY + "@proxy.example.com:8443");
    CHECK_EQ(c->proxy.build_url({}, "http"), "http://relay:" + KEY + "@proxy.example.com:8080");
    auto plain = make_client("proxy.example.com", 0, std::nullopt);
    CHECK_EQ(plain->proxy.build_url(), "http://relay:" + KEY + "@proxy.example.com:8080");
    CHECK_INVALID(plain->proxy.build_url({}, "https"));
    GatewayTls bad;
    bad.port = 70000;
    CHECK_INVALID(make_client("localhost", 0, bad));
    GatewayTls bad_sn;
    bad_sn.servername = "bad name";
    CHECK_INVALID(make_client("localhost", 0, bad_sn));
    GatewayTls bad_ca;
    bad_ca.ca_pem = "not pem";
    CHECK_INVALID(make_client("localhost", 0, bad_ca));
}
