#include "dominode/dominode.hpp"

#include <cassert>
#include <cstdio>
#include <iostream>
#include <string>

// ─── Test helpers ───────────────────────────────────────────────────────────

static int tests_passed = 0;
static int tests_failed = 0;

#define TEST(name)                                                   \
    do {                                                             \
        std::printf("  test_client::%s ... ", #name);                \
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
                std::string("Assertion failed: ") + #a " != " #b);  \
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

static void test_default_config() {
    dominode::ClientConfig cfg;
    ASSERT_EQ(cfg.base_url, "https://api.dominode.io");
    ASSERT_EQ(cfg.proxy_host, "proxy.dominode.io");
    ASSERT_EQ(cfg.http_proxy_port, 8080);
    ASSERT_EQ(cfg.socks5_proxy_port, 1080);
    ASSERT_TRUE(cfg.api_key.empty());
    ASSERT_TRUE(cfg.access_token.empty());
    ASSERT_TRUE(cfg.refresh_token.empty());
}

static void test_custom_config() {
    dominode::ClientConfig cfg;
    cfg.base_url = "http://localhost:3000";
    cfg.proxy_host = "localhost";
    cfg.http_proxy_port = 9090;
    cfg.socks5_proxy_port = 2080;
    cfg.api_key = "dn_live_test123";

    ASSERT_EQ(cfg.base_url, "http://localhost:3000");
    ASSERT_EQ(cfg.proxy_host, "localhost");
    ASSERT_EQ(cfg.http_proxy_port, 9090);
    ASSERT_EQ(cfg.socks5_proxy_port, 2080);
    ASSERT_EQ(cfg.api_key, "dn_live_test123");
}

static void test_client_construction() {
    dominode::ClientConfig cfg;
    cfg.base_url = "http://localhost:3000";

    // Should not throw
    dominode::DomiNodeClient client(cfg);
    ASSERT_EQ(client.base_url(), "http://localhost:3000");
}

static void test_client_default_construction() {
    dominode::DomiNodeClient client;
    ASSERT_EQ(client.base_url(), "https://api.dominode.io");
}

static void test_client_move() {
    dominode::ClientConfig cfg;
    cfg.base_url = "http://localhost:4000";
    dominode::DomiNodeClient client1(cfg);

    dominode::DomiNodeClient client2(std::move(client1));
    ASSERT_EQ(client2.base_url(), "http://localhost:4000");
}

static void test_client_resource_accessors() {
    dominode::DomiNodeClient client;

    // These should not throw - just verify the references are valid
    [[maybe_unused]] auto& auth_ref = client.auth();
    [[maybe_unused]] auto& keys_ref = client.keys();
    [[maybe_unused]] auto& wallet_ref = client.wallet();
    [[maybe_unused]] auto& usage_ref = client.usage();
    [[maybe_unused]] auto& plans_ref = client.plans();
    [[maybe_unused]] auto& sessions_ref = client.sessions();
    [[maybe_unused]] auto& proxy_ref = client.proxy();
    [[maybe_unused]] auto& admin_ref = client.admin();

    ASSERT_TRUE(true);  // If we got here, all accessors work
}

static void test_constants() {
    ASSERT_EQ(std::string(dominode::SDK_VERSION), "1.0.0");
    ASSERT_EQ(std::string(dominode::USER_AGENT), "dominode-sdk-cpp/1.0.0");
    ASSERT_EQ(std::string(dominode::DEFAULT_BASE_URL), "https://api.dominode.io");
    ASSERT_EQ(std::string(dominode::DEFAULT_PROXY_HOST), "proxy.dominode.io");
    ASSERT_EQ(dominode::DEFAULT_HTTP_PROXY_PORT, 8080);
    ASSERT_EQ(dominode::DEFAULT_SOCKS5_PROXY_PORT, 1080);
    ASSERT_EQ(dominode::TOKEN_REFRESH_BUFFER_SECONDS, 60);
    ASSERT_EQ(dominode::MAX_RATE_LIMIT_RETRIES, 1);
}

static void test_trailing_slash_stripped() {
    dominode::ClientConfig cfg;
    cfg.base_url = "http://localhost:3000/";

    dominode::DomiNodeClient client(cfg);
    ASSERT_EQ(client.base_url(), "http://localhost:3000");
}

// ─── Main ───────────────────────────────────────────────────────────────────

int run_client_tests() {
    std::printf("Running client tests...\n");

    TEST(default_config);
    TEST(custom_config);
    TEST(client_construction);
    TEST(client_default_construction);
    TEST(client_move);
    TEST(client_resource_accessors);
    TEST(constants);
    TEST(trailing_slash_stripped);

    std::printf("Client tests: %d passed, %d failed\n\n", tests_passed, tests_failed);
    return tests_failed;
}

#undef TEST
#undef ASSERT_EQ
#undef ASSERT_TRUE
