// Proxy username/URL builder, SSRF tables, DNS rebinding and a local fake gateway.
#include "fake_server.hpp"
#include "test_util.hpp"

using namespace t;

namespace {
const std::string WID = "AAAAAAAA-2222-4333-8444-555555555555";

std::string b64(const std::string& in) {
    static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    int val = 0, bits = -6;
    for (unsigned char c : in) {
        val = (val << 8) + c;
        bits += 8;
        while (bits >= 0) { out += tbl[(val >> bits) & 0x3F]; bits -= 6; }
    }
    if (bits > -6) out += tbl[((val << 8) >> (bits + 8)) & 0x3F];
    while (out.size() % 4) out += '=';
    return out;
}

std::unique_ptr<DominusNodeClient> gateway_client(int port) {
    ClientConfig cfg;
    cfg.base_url = "https://api.test";
    cfg.proxy_host = "127.0.0.1";
    cfg.http_proxy_port = port;
    cfg.transport = [](const HttpRequest&) { return HttpResponse{200, {}, R"({"token":"x"})"}; };
    auto c = std::make_unique<DominusNodeClient>(cfg);
    c->connect_with_key(KEY);
    c->proxy.set_resolver([](const std::string&) { return std::vector<std::string>{"93.184.216.34", "2606:2800:220:1::1"}; });
    return c;
}
}  // namespace

TEST(username_flags_and_order) {
    CHECK_EQ(build_proxy_username({}), std::string("relay"));
    ProxyRoutingOptions o;
    o.country = "us";
    o.ip_class = "residential";
    o.session_id = "abc123";
    o.agentic_wallet_id = WID;
    o.allow_http = true;
    CHECK_EQ(build_proxy_username(o),
             "country-US-class-residential-session-abc123-wallet-" + to_lower(WID) + "-allowhttp-1");
    ProxyRoutingOptions d;
    d.ip_class = "dc";
    CHECK_EQ(build_proxy_username(d), std::string("class-dc"));
}

TEST(username_validation_incl_ofac) {
    for (const char* cc : {"CU", "ir", "KP", "ru", "Sy"}) {
        ProxyRoutingOptions o;
        o.country = cc;
        CHECK_INVALID(build_proxy_username(o));
    }
    auto bad = [](const std::function<void(ProxyRoutingOptions&)>& m) { ProxyRoutingOptions o; m(o); CHECK_INVALID(build_proxy_username(o)); };
    bad([](auto& o) { o.country = "USA"; });
    bad([](auto& o) { o.country = "U1"; });
    bad([](auto& o) { o.ip_class = "datacenter"; });
    bad([](auto& o) { o.session_id = ""; });
    bad([](auto& o) { o.session_id = "a-b"; });
    bad([](auto& o) { o.session_id = std::string(65, 'a'); });
    bad([](auto& o) { o.agentic_wallet_id = "w1"; });
}

TEST(build_url) {
    Fixture f;
    ProxyRoutingOptions o;
    o.country = "DE";
    CHECK_EQ(f.client->proxy.build_url(o), "http://country-DE:" + KEY + "@proxy.dominusnode.daedalusdevelopmentgroup.com:8080");
    CHECK_EQ(f.client->proxy.build_url({}, "socks5"), "socks5://relay:" + KEY + "@proxy.dominusnode.daedalusdevelopmentgroup.com:1080");
    CHECK_EQ(f.client->proxy.build_url({}, "http", std::string("dn_test_override_1")), std::string("http://relay:dn_test_override_1@proxy.dominusnode.daedalusdevelopmentgroup.com:8080"));
    CHECK_INVALID(f.client->proxy.build_url({}, "https"));
    CHECK_INVALID(f.client->proxy.build_url({}, "http", std::string("nope")));
    Fixture g(false);
    CHECK_THROWS(g.client->proxy.build_url(), AuthenticationError);
    CHECK_EQ(f.client->proxy.build_username(o), std::string("country-DE"));
}

TEST(private_ip_table) {
    const char* blocked[] = {
        "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1",
        "100.64.0.1", "100.127.255.255", "192.0.0.1", "192.0.2.5", "192.0.1.1", "192.0.255.255", "198.18.0.1", "198.19.255.1", "224.0.0.1",
        "255.255.255.255", "2130706433", "0x7f000001", "0177.0.0.1", "127.1", "0x0a.1", "017700000001",
        "::", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "::7f00:1", "::ffff:10.0.0.1",
        "64:ff9b::127.0.0.1", "64:ff9b::a00:1", "fc00::1", "fd12::1", "fe80::1%eth0", "fec0::1", "ff02::1",
        "2001:0000:4136:e378::1", "2002:c000:0204::1", "2001:db8::1", "0:0:0:0:0:ffff:192.168.0.1",
    };
    for (const char* ip : blocked) {
        if (!is_private_ip(ip)) fail(std::string("should be private: ") + ip, __FILE__, __LINE__);
    }
    const char* allowed[] = {"8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "192.1.0.1", "198.20.0.1",
                             "223.255.255.255", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808",
                             "2001:4860::8888", "example.com", "1.2.3.4.5"};
    for (const char* ip : allowed) {
        if (is_private_ip(ip)) fail(std::string("should be public: ") + ip, __FILE__, __LINE__);
    }
    CHECK_EQ(normalize_ipv4("2130706433"), std::optional<std::string>("127.0.0.1"));
    CHECK_EQ(normalize_ipv4("0x7f.1"), std::optional<std::string>("127.0.0.1"));
    CHECK(!normalize_ipv4("256.1.1.1"));
    CHECK(!normalize_ipv4("4294967296"));
}

TEST(target_url_refusals) {
    const char* bad[] = {
        "ftp://example.com/", "file:///etc/passwd", "https://user:pw@example.com/", "https://example.com:8443/",
        "http://localhost/", "https://LOCALHOST./", "https://localhost.localdomain/", "https://ip6-localhost/",
        "https://foo.localhost/", "https://printer.local/", "https://db.internal/", "https://1.0.0.127.in-addr.arpa/",
        "https://127.0.0.1/", "https://[::1]/", "https://2130706433/", "https://0x7f000001/", "https://10.0.0.1:443/",
        "https://[::ffff:169.254.169.254]/", "not a url", "",
    };
    for (const char* u : bad) {
        bool ok = false;
        try { validate_target_url(u); } catch (const ProxyError&) { ok = true; }
        if (!ok) fail(std::string("should refuse: ") + u, __FILE__, __LINE__);
    }
    TargetUrl t = validate_target_url("https://Example.COM./a/b?x=1&y=2");
    CHECK_EQ(t.host, std::string("example.com"));
    CHECK_EQ(t.scheme, std::string("https"));
    CHECK_EQ(t.path_query, std::string("/a/b?x=1&y=2"));
    CHECK_EQ(validate_target_url("http://example.com:80/").port, std::string("80"));
}

TEST(dns_rebinding_mixed_answer_refused) {
    Resolver mixed = [](const std::string&) { return std::vector<std::string>{"93.184.216.34", "10.0.0.5"}; };
    CHECK_THROWS(assert_public_resolution("evil.example", mixed), ProxyError);
    Resolver v6 = [](const std::string&) { return std::vector<std::string>{"2606:4700::1", "::ffff:127.0.0.1"}; };
    CHECK_THROWS(assert_public_resolution("evil.example", v6), ProxyError);
    Resolver empty = [](const std::string&) { return std::vector<std::string>{}; };
    CHECK_THROWS(assert_public_resolution("x.example", empty), ProxyError);
    Resolver boom = [](const std::string&) -> std::vector<std::string> { throw std::runtime_error("NXDOMAIN"); };
    CHECK_THROWS(assert_public_resolution("x.example", boom), ProxyError);
    Resolver good = [](const std::string&) { return std::vector<std::string>{"93.184.216.34"}; };
    assert_public_resolution("ok.example", good);

    // fetch refuses before any connection
    FakeServer srv([](const std::string&) { return std::string("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"); });
    auto c = gateway_client(srv.port());
    c->proxy.set_resolver(mixed);
    CHECK_THROWS(c->proxy.fetch("https://evil.example/"), ProxyError);
    CHECK(srv.requests().empty());
}

TEST(fetch_argument_checks_before_io) {
    FakeServer srv([](const std::string&) { return std::string("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"); });
    auto c = gateway_client(srv.port());
    ProxyFetchOptions o;
    o.method = "POST";
    CHECK_INVALID(c->proxy.fetch("https://example.com/", o));
    CHECK_INVALID(c->proxy.fetch("http://example.com/"));  // allow_http required
    ProxyFetchOptions h;
    h.headers = {{"X-Bad\r\nInjected", "1"}};
    CHECK_INVALID(c->proxy.fetch("https://example.com/", h));
    ProxyFetchOptions v;
    v.headers = {{"X-Ok", "a\r\nb"}};
    CHECK_INVALID(c->proxy.fetch("https://example.com/", v));
    ProxyFetchOptions cc;
    cc.country = "RU";
    CHECK_INVALID(c->proxy.fetch("https://example.com/", cc));
    CHECK_THROWS(c->proxy.fetch("https://169.254.169.254/latest/meta-data"), ProxyError);
    CHECK(srv.requests().empty());
    Fixture nokey(false);
    CHECK_THROWS(nokey.client->proxy.fetch("https://example.com/"), AuthenticationError);
}

TEST(fetch_http_via_fake_gateway) {
    FakeServer srv([](const std::string& req) -> std::string {
        if (req.find("/redirect") != std::string::npos) {
            return "HTTP/1.1 301 Moved Permanently\r\nLocation: http://127.0.0.1/secret\r\nContent-Length: 0\r\n\r\n";
        }
        if (req.find("/big") != std::string::npos) {
            return "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n" + std::string(100, 'x');
        }
        return "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-Multi: a\r\nX-Multi: b\r\nContent-Length: 5\r\n\r\nhello";
    });
    auto c = gateway_client(srv.port());
    ProxyFetchOptions o;
    o.allow_http = true;
    o.country = "US";
    o.headers = {{"X-Trace", "1"}, {"Authorization", "Bearer leak"}, {"Host", "evil"}};
    ProxyFetchResponse r = c->proxy.fetch("http://example.com/path?q=1", o);
    CHECK_EQ(r.status, 200L);
    CHECK_EQ(r.status_text, std::string("OK"));
    CHECK_EQ(r.text(), std::string("hello"));
    CHECK(!r.truncated);
    CHECK_EQ(r.headers.at("x-multi"), std::string("a, b"));
    auto reqs = srv.requests();
    CHECK_EQ(reqs.size(), std::size_t(1));
    const std::string& q = reqs[0];
    CHECK(q.rfind("GET http://example.com/path?q=1 HTTP/1.1\r\n", 0) == 0);  // absolute URI
    CHECK(q.find("Proxy-Authorization: Basic " + b64("country-US-allowhttp-1:" + KEY) + "\r\n") != std::string::npos);
    CHECK(q.find("Host: example.com\r\n") != std::string::npos);
    CHECK(q.find("Connection: close\r\n") != std::string::npos);
    CHECK(q.find("X-Trace: 1\r\n") != std::string::npos);
    CHECK(q.find("Bearer leak") == std::string::npos);
    CHECK(q.find("evil") == std::string::npos);

    ProxyFetchResponse red = c->proxy.fetch("http://example.com/redirect", o);
    CHECK_EQ(red.status, 301L);  // returned as-is, never followed
    CHECK_EQ(srv.requests().size(), std::size_t(2));

    ProxyFetchOptions small = o;
    small.max_bytes = 10;
    ProxyFetchResponse big = c->proxy.fetch("http://example.com/big", small);
    CHECK(big.truncated);
    CHECK_EQ(big.body, std::string(10, 'x'));

    ProxyFetchOptions head = o;
    head.method = "head";
    ProxyFetchResponse hr = c->proxy.fetch("http://example.com/", head);
    CHECK_EQ(hr.status, 200L);
    CHECK(hr.body.empty());
    CHECK(srv.requests().back().rfind("HEAD http://example.com/ HTTP/1.1", 0) == 0);
}

TEST(fetch_connect_refused_reports_status) {
    FakeServer srv([](const std::string&) {
        return std::string("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
    });
    auto c = gateway_client(srv.port());
    try {
        c->proxy.fetch("https://example.com/x");
        fail("expected ProxyError", __FILE__, __LINE__);
    } catch (const ProxyError& e) {
        CHECK_EQ(e.status_code(), std::optional<int>(407));
        CHECK(std::string(e.what()).find(KEY) == std::string::npos);
    }
    auto reqs = srv.requests();
    CHECK_EQ(reqs.size(), std::size_t(1));
    CHECK(reqs[0].rfind("CONNECT example.com:443 HTTP/1.1\r\n", 0) == 0);
    CHECK(reqs[0].find("Proxy-Authorization: Basic " + b64("relay:" + KEY)) != std::string::npos);
}

TEST(fetch_timeout_is_proxy_error) {
    FakeServer srv([](const std::string&) {
        std::this_thread::sleep_for(std::chrono::milliseconds(600));
        return std::string("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    });
    auto c = gateway_client(srv.port());
    ProxyFetchOptions o;
    o.allow_http = true;
    o.timeout_ms = 150;
    CHECK_THROWS(c->proxy.fetch("http://example.com/", o), ProxyError);
}
