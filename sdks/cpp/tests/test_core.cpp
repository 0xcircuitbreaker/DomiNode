// HTTP behaviour, error mapping, credential lifecycle and redaction.
#include "fake_server.hpp"
#include "test_util.hpp"

using namespace t;

namespace {

template <class E>
E capture(const std::function<void()>& f) {
    try {
        f();
    } catch (const E& e) {
        return e;
    }
    throw std::runtime_error("expected exception not thrown");
}

}  // namespace

// ─── error mapping ──────────────────────────────────────────────────────────

TEST(error_mapping_by_status) {
    Fixture f;
    auto run = [&](long status, json body) {
        f.mock.push(status, body);
        f.client->network.stats();
    };
    { auto e = capture<ValidationError>([&] { run(400, {{"error", "bad"}, {"code", "AMOUNT_OUT_OF_RANGE"}}); });
      CHECK_EQ(e.status_code(), std::optional<int>(400)); CHECK_EQ(e.code(), std::optional<std::string>("AMOUNT_OUT_OF_RANGE"));
      CHECK_EQ(std::string(e.what()), std::string("bad")); }
    { auto e = capture<AuthenticationError>([&] { run(401, {{"error", "no"}}); }); CHECK_EQ(e.status_code(), std::optional<int>(401)); }
    { auto e = capture<InsufficientBalanceError>([&] { run(402, {{"error", "x"}, {"code", "INSUFFICIENT_CREDIT"}}); });
      CHECK_EQ(e.code(), std::optional<std::string>("INSUFFICIENT_CREDIT")); }
    { auto e = capture<AuthorizationError>([&] { run(403, {{"error", "x"}, {"mfaRequired", true}}); });
      CHECK_EQ(e.code(), std::optional<std::string>("MFA_REQUIRED")); }
    { auto e = capture<NotFoundError>([&] { run(404, {{"message", "gone"}}); }); CHECK_EQ(std::string(e.what()), std::string("gone")); }
    { auto e = capture<ConflictError>([&] { run(409, {{"error", "dup"}, {"code", "ALREADY_REPORTED"}}); });
      CHECK_EQ(e.status_code(), std::optional<int>(409)); }
    { auto e = capture<ValidationError>([&] { run(400, {{"error", "cap"}, {"code", "CAP_ABOVE_DEFAULT"}, {"max", 64}, {"cap", "5"}, {"limitPerDay", 5}, {"other", 1}}); });
      CHECK_EQ(e.details().at("max"), json(64)); CHECK_EQ(e.details().at("cap"), json("5"));
      CHECK_EQ(e.details().at("limitPerDay"), json(5)); CHECK(e.details().count("other") == 0); }
    { auto e = capture<ServerError>([&] { run(503, {{"error", "down"}}); }); CHECK_EQ(e.status_code(), std::optional<int>(503)); }
    { auto e = capture<DominusNodeError>([&] { f.mock.push_raw(302, "", {{"location", "https://evil"}}); f.client->network.stats(); });
      CHECK_EQ(e.status_code(), std::optional<int>(302)); }
    { auto e = capture<ServerError>([&] { f.mock.push_raw(200, "{not json"); f.client->network.stats(); });
      CHECK_EQ(std::string(e.what()), std::string("Invalid JSON in response")); }
    { auto e = capture<ValidationError>([&] { run(400, {{"error", std::string(600, 'x')}}); });
      CHECK_EQ(std::string(e.what()).size(), std::size_t(500 + std::string("... [truncated]").size())); }
}

TEST(error_messages_are_scrubbed) {
    Fixture f;
    std::string nodekey = "dn_node_" + std::string(64, 'a');
    f.mock.push(400, {{"error", "bad key " + KEY + " node " + nodekey + " jwt " + JWT + " proxy dn_proxy_x1 test dn_test_abc"}});
    auto e = capture<ValidationError>([&] { f.client->network.stats(); });
    std::string m = e.what();
    CHECK(m.find("dn_live_") == std::string::npos && m.find("dn_node_") == std::string::npos &&
          m.find("eyJ") == std::string::npos && m.find("dn_proxy_") == std::string::npos && m.find("dn_test_") == std::string::npos);
    CHECK_EQ(m, std::string("bad key [REDACTED] node [REDACTED] jwt [REDACTED] proxy [REDACTED] test [REDACTED]"));
    // transport errors too
    ClientConfig cfg;
    cfg.base_url = "https://api.test";
    cfg.transport = [](const HttpRequest&) -> HttpResponse { throw std::runtime_error("socket died holding " + KEY); };
    DominusNodeClient c(cfg);
    auto ne = capture<NetworkError>([&] { c.network.stats(); });
    CHECK(std::string(ne.what()).find(KEY) == std::string::npos);
    CHECK(!ne.status_code());
}

TEST(json_strips_dangerous_keys) {
    Fixture f;
    f.mock.push_raw(200, R"({"a":1,"__proto__":{"x":1},"n":{"constructor":2,"k":[{"prototype":3,"ok":true}]}})");
    json r = f.client->network.stats();
    CHECK_EQ(r, json::parse(R"({"a":1,"n":{"k":[{"ok":true}]}})"));
    f.mock.push_raw(200, "");
    CHECK_EQ(f.client->network.stats(), json::object());
}

// ─── 429 ────────────────────────────────────────────────────────────────────

TEST(rate_limit_retries_once_then_succeeds) {
    Fixture f;
    f.mock.push(429, {{"error", "slow"}}, {{"retry-after", "2"}});
    f.mock.push(200, {{"ok", true}});
    CHECK_EQ(f.client->network.stats(), json({{"ok", true}}));
    CHECK_EQ(f.mock.calls.size(), std::size_t(2));
    CHECK_EQ(f.sleeps.size(), std::size_t(1));
    CHECK(f.sleeps[0] >= 1800 && f.sleeps[0] <= 2200);
}

TEST(rate_limit_second_429_raises) {
    Fixture f;
    f.mock.push(429, {{"error", "slow"}});
    f.mock.push(429, {{"error", "slow"}, {"code", "RATE_LIMITED"}}, {{"retry-after", "30"}});
    auto e = capture<RateLimitError>([&] { f.client->network.stats(); });
    CHECK_EQ(e.retry_after_seconds(), 30);
    CHECK_EQ(e.code(), std::optional<std::string>("RATE_LIMITED"));
    CHECK_EQ(f.mock.calls.size(), std::size_t(2));
    CHECK(f.sleeps[0] >= 4500 && f.sleeps[0] <= 5500);  // default Retry-After 5 s
    f.mock.push(429, json::object());
    f.mock.push(429, json::object());
    auto e2 = capture<RateLimitError>([&] { f.client->network.stats(); });
    CHECK_EQ(e2.retry_after_seconds(), 60);
}

TEST(retry_delay_bounds) {
    for (int i = 0; i < 2000; ++i) {
        long big = retry_delay_ms(3600);
        CHECK(big >= 9000 && big <= 11000);
        CHECK(retry_delay_ms(0) == 100);
        long one = retry_delay_ms(1);
        CHECK(one >= 900 && one <= 1100);
    }
}

// ─── 401 refresh ────────────────────────────────────────────────────────────

TEST(jwt_401_refreshes_and_retries) {
    Fixture f;
    f.mock.push(401, {{"error", "expired"}});
    f.mock.push(200, {{"token", JWT2}, {"refreshToken", "rt2"}});
    f.mock.push(200, {{"user", {{"id", "u"}}}});
    f.client->auth.me();
    CHECK_EQ(f.mock.calls.size(), std::size_t(3));
    CHECK_EQ(Mock::path(f.mock.calls[1]), std::string("/api/auth/refresh"));
    CHECK_EQ(Mock::body(f.mock.calls[1]), json({{"refreshToken", RT}}));
    CHECK_EQ(Mock::header(f.mock.calls[2], "Authorization"), "Bearer " + JWT2);
}

TEST(api_key_401_does_not_refresh) {
    Fixture f;
    f.mock.push(401, {{"error", "bad key"}});
    CHECK_THROWS(f.client->credits.balance(), AuthenticationError);
    CHECK_EQ(f.mock.calls.size(), std::size_t(1));
}

TEST(refresh_failure_clears_tokens) {
    Fixture f;
    f.mock.push(401, {{"error", "expired"}});
    f.mock.push(401, {{"error", "refresh revoked"}});
    auto e = capture<AuthenticationError>([&] { f.client->auth.me(); });
    CHECK_EQ(std::string(e.what()), std::string("Session expired and token refresh failed"));
    CHECK_EQ(f.mock.calls.size(), std::size_t(2));
    // tokens gone; the API key remains (agent routes still work)
    CHECK_THROWS(f.client->auth.me(), AuthenticationError);
    CHECK_EQ(f.mock.calls.size(), std::size_t(2));
}

TEST(expired_access_token_refreshes_before_request) {
    ClientConfig cfg;
    Mock m;
    cfg.base_url = "https://api.test";
    cfg.transport = m.transport();
    cfg.access_token = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.c2ln";  // exp 1
    cfg.refresh_token = RT;
    DominusNodeClient c(cfg);
    m.push(200, {{"token", JWT}});
    m.push(200, json::object());
    c.auth.me();
    CHECK_EQ(Mock::path(m.calls[0]), std::string("/api/auth/refresh"));
    CHECK_EQ(Mock::header(m.calls[1], "Authorization"), "Bearer " + JWT);
}

// ─── size cap ───────────────────────────────────────────────────────────────

TEST(size_cap_by_content_length_and_body) {
    Fixture f;
    f.mock.push_raw(200, "{}", {{"content-length", std::to_string(10 * 1024 * 1024 + 1)}});
    CHECK_THROWS(f.client->network.stats(), ServerError);
    f.mock.push_raw(200, std::string(10 * 1024 * 1024 + 1, ' '));
    CHECK_THROWS(f.client->network.stats(), ServerError);
}

TEST(curl_transport_caps_size_and_never_follows_redirects) {
    FakeServer srv([](const std::string& req) -> std::string {
        if (req.find("GET /redirect") == 0) {
            return "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        }
        if (req.find("GET /big-cl") == 0) {
            return "HTTP/1.1 200 OK\r\nContent-Length: 20000000\r\nConnection: close\r\n\r\n{}";
        }
        if (req.find("GET /big") == 0) {
            return "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + std::string(10 * 1024 * 1024 + 10, ' ');
        }
        return "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}";
    });
    HttpRequest r;
    r.method = "GET";
    std::string base = "http://127.0.0.1:" + std::to_string(srv.port());
    Transport tr = make_curl_transport();
    r.url = base + "/ok";
    HttpResponse ok = tr(r);
    CHECK_EQ(ok.status, 200L);
    CHECK_EQ(ok.body, std::string("{\"ok\":true}"));
    r.url = base + "/redirect";
    HttpResponse red = tr(r);
    CHECK_EQ(red.status, 302L);  // returned, not followed
    CHECK_EQ(srv.requests().size(), std::size_t(2));
    r.url = base + "/big-cl";
    CHECK_THROWS(tr(r), ServerError);
    r.url = base + "/big";
    CHECK_THROWS(tr(r), ServerError);

    // Through the client: a 3xx raises.
    ClientConfig cfg;
    cfg.base_url = base;
    DominusNodeClient c(cfg);
    auto e = capture<DominusNodeError>([&] { c.http().get("/redirect", AuthMode::None); });
    CHECK_EQ(e.status_code(), std::optional<int>(302));
}

// ─── config ─────────────────────────────────────────────────────────────────

TEST(config_validation) {
    ClientConfig def;
    CHECK_EQ(def.base_url, std::string("https://api.dominusnode.daedalusdevelopmentgroup.com"));
    CHECK_EQ(def.proxy_host, std::string("proxy.dominusnode.daedalusdevelopmentgroup.com"));
    CHECK_EQ(def.http_proxy_port, 8080);
    CHECK_EQ(def.socks5_proxy_port, 1080);
    auto mk = [](ClientConfig c) { c.transport = [](const HttpRequest&) { return HttpResponse{200, {}, "{}"}; }; DominusNodeClient x(c); };
    { ClientConfig c; c.base_url = "ftp://x"; CHECK_INVALID(mk(c)); }
    { ClientConfig c; c.base_url = "https://user:pw@x"; CHECK_INVALID(mk(c)); }
    { ClientConfig c; c.proxy_host = "bad host"; CHECK_INVALID(mk(c)); }
    { ClientConfig c; c.proxy_host = "[::1]"; mk(c); }
    { ClientConfig c; c.http_proxy_port = 0; CHECK_INVALID(mk(c)); }
    { ClientConfig c; c.socks5_proxy_port = 65536; CHECK_INVALID(mk(c)); }
}

// ─── connect / disconnect / redaction ───────────────────────────────────────

TEST(connect_with_key_stores_key_and_jwt) {
    Fixture f(false);
    f.mock.push(200, {{"valid", true}, {"token", JWT}, {"refreshToken", RT}, {"userId", "u-1"}});
    auto r = f.client->connect_with_key(KEY);
    CHECK(!r.mfa_required);
    CHECK_EQ(r.user_id, std::optional<std::string>("u-1"));
    CHECK_EQ(Mock::body(f.mock.calls[0]), json({{"apiKey", KEY}}));
    CHECK(!Mock::has_header(f.mock.calls[0], "Authorization"));
    CHECK(f.client->is_connected());
}

TEST(connect_with_key_mfa_stores_only_key) {
    Fixture f(false);
    f.mock.push(403, {{"error", "MFA required"}, {"mfaRequired", true}});
    auto r = f.client->connect_with_key(KEY);
    CHECK(r.mfa_required);
    CHECK(!r.user_id);
    CHECK(f.client->is_connected());
    f.client->credits.balance();
    CHECK_EQ(Mock::header(f.mock.last(), "Authorization"), "Bearer " + KEY);
    CHECK_THROWS(f.client->auth.me(), AuthenticationError);
}

TEST(connect_with_key_error_stores_nothing) {
    Fixture f(false);
    f.mock.push(401, {{"error", "invalid key"}});
    CHECK_THROWS(f.client->connect_with_key(KEY), AuthenticationError);
    CHECK(!f.client->is_connected());
}

TEST(disconnect_logs_out_and_clears_everything) {
    Fixture f;
    f.client->disconnect();
    CHECK_EQ(f.mock.calls.size(), std::size_t(1));
    CHECK_EQ(Mock::path(f.mock.calls[0]), std::string("/api/auth/logout"));
    CHECK(!f.client->is_connected());
    CHECK_THROWS(f.client->credits.balance(), AuthenticationError);
    CHECK_THROWS(f.client->proxy.build_url(), AuthenticationError);
    // logout failure is ignored
    Fixture g;
    g.mock.push(500, {{"error", "x"}});
    g.client->disconnect();
    CHECK(!g.client->is_connected());
    // reconnect works (refresh callback survives)
    g.mock.push(200, {{"token", JWT}, {"refreshToken", RT}});
    g.client->connect_with_key(KEY);
    g.mock.push(401, json::object());
    g.mock.push(200, {{"token", JWT2}});
    g.mock.push(200, json::object());
    g.client->auth.me();
    CHECK_EQ(Mock::header(g.mock.last(), "Authorization"), "Bearer " + JWT2);
}

TEST(token_manager_clear_keeps_refresh_callback) {
    TokenManager tm;
    int calls = 0;
    tm.set_refresh_function([&](const std::string& rt) { ++calls; CHECK_EQ(rt, std::string("r")); return RefreshResult{JWT, std::nullopt}; });
    tm.set_tokens("a", std::string("r"));
    tm.clear();
    CHECK(!tm.has_tokens());
    CHECK(tm.has_refresh_function());
    CHECK_THROWS(tm.force_refresh(), AuthenticationError);
    tm.set_tokens("a", std::string("r"));
    CHECK_EQ(tm.get_valid_token(), JWT);  // "a" is not a JWT -> expired -> refresh
    CHECK_EQ(calls, 1);
    CHECK(TokenManager::is_expired("x.y.z"));
    CHECK(!TokenManager::is_expired(JWT));
}

TEST(redaction_everywhere) {
    Fixture f;
    std::ostringstream a, b, c;
    a << *f.client;
    CHECK_EQ(a.str(), std::string("DominusNodeClient(connected=true)"));
    CHECK_EQ(json(*f.client).dump(), std::string("{\"connected\":true}"));
    TokenManager tm;
    tm.set_tokens(JWT, RT);
    b << tm;
    CHECK_EQ(b.str(), std::string("TokenManager([REDACTED])"));
    CHECK_EQ(json(tm).dump(), std::string("\"[REDACTED]\""));
    c << f.client->http();
    CHECK_EQ(c.str(), std::string("HttpClient(https://api.test)"));
    Secret s("dn_node_" + std::string(64, 'f'));
    std::ostringstream d;
    d << s;
    CHECK_EQ(d.str(), std::string("[REDACTED]"));
    CHECK_EQ(s.to_string(), std::string("[REDACTED]"));
    CHECK_EQ(json(s).dump(), std::string("\"[REDACTED]\""));
    CHECK_EQ(s.prefix(), std::string("dn_node_"));
    std::string z = "secret";
    secure_zero_string(z);
    CHECK(z.empty());
}

TEST(url_encode_semantics) {
    CHECK_EQ(url_encode("a b/c?d&e=f#g%"), std::string("a%20b%2Fc%3Fd%26e%3Df%23g%25"));
    CHECK_EQ(url_encode("AZaz09-_.!~*'()"), std::string("AZaz09-_.!~*'()"));
    CHECK_EQ(url_encode("\xC2\xB5"), std::string("%C2%B5"));
}

TEST(default_hosts) {
    CHECK_EQ(std::string(dominusnode::DEFAULT_BASE_URL), std::string("https://api.dominusnode.daedalusdevelopmentgroup.com"));
    CHECK_EQ(std::string(dominusnode::DEFAULT_PROXY_HOST), std::string("proxy.dominusnode.daedalusdevelopmentgroup.com"));
}
