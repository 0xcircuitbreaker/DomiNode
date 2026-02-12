#include "dominode/errors.hpp"

#include <cassert>
#include <cstdio>
#include <stdexcept>
#include <string>

// ─── Test helpers ───────────────────────────────────────────────────────────

static int tests_passed = 0;
static int tests_failed = 0;

#define TEST(name)                                                   \
    do {                                                             \
        std::printf("  test_errors::%s ... ", #name);                \
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

static void test_base_error() {
    dominode::DomiNodeError err("something went wrong", 418);
    ASSERT_EQ(std::string(err.what()), "something went wrong");
    ASSERT_EQ(err.status_code(), 418);
}

static void test_base_error_default_status() {
    dominode::DomiNodeError err("error");
    ASSERT_EQ(err.status_code(), 0);
}

static void test_authentication_error() {
    dominode::AuthenticationError err;
    ASSERT_EQ(std::string(err.what()), "Authentication failed");
    ASSERT_EQ(err.status_code(), 401);
}

static void test_authentication_error_custom_message() {
    dominode::AuthenticationError err("Invalid token");
    ASSERT_EQ(std::string(err.what()), "Invalid token");
    ASSERT_EQ(err.status_code(), 401);
}

static void test_authorization_error() {
    dominode::AuthorizationError err;
    ASSERT_EQ(std::string(err.what()), "Access denied");
    ASSERT_EQ(err.status_code(), 403);
}

static void test_rate_limit_error() {
    dominode::RateLimitError err("Too many requests", 120);
    ASSERT_EQ(std::string(err.what()), "Too many requests");
    ASSERT_EQ(err.status_code(), 429);
    ASSERT_EQ(err.retry_after_seconds(), 120);
}

static void test_rate_limit_error_default_retry() {
    dominode::RateLimitError err;
    ASSERT_EQ(err.retry_after_seconds(), 60);
}

static void test_insufficient_balance_error() {
    dominode::InsufficientBalanceError err;
    ASSERT_EQ(std::string(err.what()), "Insufficient balance");
    ASSERT_EQ(err.status_code(), 402);
}

static void test_validation_error() {
    dominode::ValidationError err("Email is invalid");
    ASSERT_EQ(std::string(err.what()), "Email is invalid");
    ASSERT_EQ(err.status_code(), 400);
}

static void test_not_found_error() {
    dominode::NotFoundError err;
    ASSERT_EQ(std::string(err.what()), "Resource not found");
    ASSERT_EQ(err.status_code(), 404);
}

static void test_conflict_error() {
    dominode::ConflictError err("Email already registered");
    ASSERT_EQ(std::string(err.what()), "Email already registered");
    ASSERT_EQ(err.status_code(), 409);
}

static void test_server_error() {
    dominode::ServerError err;
    ASSERT_EQ(std::string(err.what()), "Server error");
    ASSERT_EQ(err.status_code(), 500);
}

static void test_network_error() {
    dominode::NetworkError err("Connection refused");
    ASSERT_EQ(std::string(err.what()), "Connection refused");
    ASSERT_EQ(err.status_code(), 0);
}

static void test_proxy_error() {
    dominode::ProxyError err("Tunnel failed", "UPSTREAM_TIMEOUT");
    ASSERT_EQ(std::string(err.what()), "Tunnel failed");
    ASSERT_EQ(err.proxy_error_code(), "UPSTREAM_TIMEOUT");
    ASSERT_EQ(err.status_code(), 0);
}

static void test_proxy_error_no_code() {
    dominode::ProxyError err("Generic proxy error");
    ASSERT_TRUE(err.proxy_error_code().empty());
}

static void test_error_hierarchy_dominode() {
    // All errors should be catchable as DomiNodeError
    try {
        throw dominode::AuthenticationError("test");
    } catch (const dominode::DomiNodeError& e) {
        ASSERT_EQ(e.status_code(), 401);
    }

    try {
        throw dominode::RateLimitError("test", 30);
    } catch (const dominode::DomiNodeError& e) {
        ASSERT_EQ(e.status_code(), 429);
    }
}

static void test_error_hierarchy_runtime() {
    // All errors should be catchable as std::runtime_error
    try {
        throw dominode::ServerError("internal error");
    } catch (const std::runtime_error& e) {
        ASSERT_EQ(std::string(e.what()), "internal error");
    }
}

static void test_error_hierarchy_exception() {
    // All errors should be catchable as std::exception
    try {
        throw dominode::NetworkError("dns failed");
    } catch (const std::exception& e) {
        ASSERT_EQ(std::string(e.what()), "dns failed");
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────

int run_error_tests() {
    std::printf("Running error tests...\n");

    TEST(base_error);
    TEST(base_error_default_status);
    TEST(authentication_error);
    TEST(authentication_error_custom_message);
    TEST(authorization_error);
    TEST(rate_limit_error);
    TEST(rate_limit_error_default_retry);
    TEST(insufficient_balance_error);
    TEST(validation_error);
    TEST(not_found_error);
    TEST(conflict_error);
    TEST(server_error);
    TEST(network_error);
    TEST(proxy_error);
    TEST(proxy_error_no_code);
    TEST(error_hierarchy_dominode);
    TEST(error_hierarchy_runtime);
    TEST(error_hierarchy_exception);

    std::printf("Error tests: %d passed, %d failed\n\n", tests_passed, tests_failed);
    return tests_failed;
}

#undef TEST
#undef ASSERT_EQ
#undef ASSERT_TRUE
