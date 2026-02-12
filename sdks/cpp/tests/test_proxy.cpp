#include "dominode/dominode.hpp"

#include <cassert>
#include <cstdio>
#include <stdexcept>
#include <string>

// ─── Test helpers ───────────────────────────────────────────────────────────

static int tests_passed = 0;
static int tests_failed = 0;

#define TEST(name)                                                   \
    do {                                                             \
        std::printf("  test_proxy::%s ... ", #name);                 \
        try {                                                        \
            test_##name();                                           \
            std::printf("OK\n");                                     \
            ++tests_passed;                                          \
        } catch (const std::exception& e) {                          \
            std::printf("FAILED: %s\n", e.what());                   \
            ++tests_failed;                                          \
        }                                                            \
    } while (0)

#define ASSERT_EQ(a, b)                                              \
    do {                                                             \
        if ((a) != (b)) {                                            \
            throw std::runtime_error(                                \
                std::string("Assertion failed: ") + #a " == " #b    \
                + "\n  got: \"" + (a) + "\"");                       \
        }                                                            \
    } while (0)

#define ASSERT_TRUE(cond)                                            \
    do {                                                             \
        if (!(cond)) {                                               \
            throw std::runtime_error(                                \
                std::string("Assertion failed: ") + #cond);          \
        }                                                            \
    } while (0)

// ─── Tests ──────────────────────────────────────────────────────────────────

// We need a client to get a ProxyResource, but we only test build_url
// which does not make network calls.

static void test_build_url_default() {
    dominode::DomiNodeClient client;
    auto url = client.proxy().build_url("dn_live_abc123");
    ASSERT_EQ(url, "http://user:dn_live_abc123@proxy.dominode.io:8080");
}

static void test_build_url_socks5() {
    dominode::DomiNodeClient client;
    dominode::ProxyUrlOptions opts;
    opts.protocol = "socks5";
    auto url = client.proxy().build_url("dn_live_abc123", opts);
    ASSERT_EQ(url, "socks5://user:dn_live_abc123@proxy.dominode.io:1080");
}

static void test_build_url_with_country() {
    dominode::DomiNodeClient client;
    dominode::ProxyUrlOptions opts;
    opts.country = "US";
    auto url = client.proxy().build_url("dn_live_key1", opts);
    ASSERT_EQ(url, "http://user-country_US:dn_live_key1@proxy.dominode.io:8080");
}

static void test_build_url_with_geo_targeting() {
    dominode::DomiNodeClient client;
    dominode::ProxyUrlOptions opts;
    opts.country = "US";
    opts.state = "CA";
    opts.city = "LosAngeles";
    auto url = client.proxy().build_url("dn_live_key1", opts);
    ASSERT_EQ(url, "http://user-country_US-state_CA-city_LosAngeles:dn_live_key1@proxy.dominode.io:8080");
}

static void test_build_url_with_session() {
    dominode::DomiNodeClient client;
    dominode::ProxyUrlOptions opts;
    opts.session_id = "sess_abc123";
    auto url = client.proxy().build_url("dn_live_key1", opts);
    ASSERT_EQ(url, "http://user-session_sess_abc123:dn_live_key1@proxy.dominode.io:8080");
}

static void test_build_url_with_asn() {
    dominode::DomiNodeClient client;
    dominode::ProxyUrlOptions opts;
    opts.asn = 15169;
    auto url = client.proxy().build_url("dn_live_key1", opts);
    ASSERT_EQ(url, "http://user-asn_15169:dn_live_key1@proxy.dominode.io:8080");
}

static void test_build_url_all_options() {
    dominode::ClientConfig cfg;
    cfg.proxy_host = "myproxy.example.com";
    cfg.http_proxy_port = 9090;
    cfg.socks5_proxy_port = 2080;
    dominode::DomiNodeClient client(cfg);

    dominode::ProxyUrlOptions opts;
    opts.protocol = "socks5";
    opts.country = "DE";
    opts.state = "BY";
    opts.city = "Munich";
    opts.asn = 3320;
    opts.session_id = "sticky123";

    auto url = client.proxy().build_url("dn_live_mykey", opts);
    ASSERT_EQ(url, "socks5://user-country_DE-state_BY-city_Munich-asn_3320-session_sticky123:dn_live_mykey@myproxy.example.com:2080");
}

static void test_build_url_custom_host_port() {
    dominode::ClientConfig cfg;
    cfg.proxy_host = "localhost";
    cfg.http_proxy_port = 3128;
    dominode::DomiNodeClient client(cfg);

    auto url = client.proxy().build_url("dn_live_test");
    ASSERT_EQ(url, "http://user:dn_live_test@localhost:3128");
}

static void test_proxy_resource_accessors() {
    dominode::DomiNodeClient client;
    ASSERT_EQ(client.proxy().proxy_host(), "proxy.dominode.io");
    ASSERT_EQ(client.proxy().http_proxy_port(), 8080);
    ASSERT_EQ(client.proxy().socks5_proxy_port(), 1080);
}

// ─── Main ───────────────────────────────────────────────────────────────────

int run_proxy_tests() {
    std::printf("Running proxy tests...\n");

    TEST(build_url_default);
    TEST(build_url_socks5);
    TEST(build_url_with_country);
    TEST(build_url_with_geo_targeting);
    TEST(build_url_with_session);
    TEST(build_url_with_asn);
    TEST(build_url_all_options);
    TEST(build_url_custom_host_port);
    TEST(proxy_resource_accessors);

    std::printf("Proxy tests: %d passed, %d failed\n\n", tests_passed, tests_failed);
    return tests_failed;
}

#undef TEST
#undef ASSERT_EQ
#undef ASSERT_TRUE
