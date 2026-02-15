#include "dominusnode/token_manager.hpp"
#include "dominusnode/errors.hpp"

#include <cassert>
#include <cstdio>
#include <ctime>
#include <stdexcept>
#include <string>
#include <sstream>

// ─── Test helpers ───────────────────────────────────────────────────────────

static int tests_passed = 0;
static int tests_failed = 0;

#define TEST(name)                                                       \
    do {                                                                 \
        std::printf("  test_token_manager::%s ... ", #name);             \
        try {                                                            \
            test_##name();                                               \
            std::printf("OK\n");                                         \
            ++tests_passed;                                              \
        } catch (const std::exception& e) {                              \
            std::printf("FAILED: %s\n", e.what());                       \
            ++tests_failed;                                              \
        }                                                                \
    } while (0)

#define ASSERT_EQ(a, b)                                                  \
    do {                                                                 \
        if ((a) != (b)) {                                                \
            throw std::runtime_error(                                    \
                std::string("Assertion failed: ") + #a " != " #b);      \
        }                                                                \
    } while (0)

#define ASSERT_TRUE(cond)                                                \
    do {                                                                 \
        if (!(cond)) {                                                   \
            throw std::runtime_error(                                    \
                std::string("Assertion failed: ") + #cond);              \
        }                                                                \
    } while (0)

#define ASSERT_FALSE(cond)                                               \
    do {                                                                 \
        if ((cond)) {                                                    \
            throw std::runtime_error(                                    \
                std::string("Assertion failed: NOT ") + #cond);          \
        }                                                                \
    } while (0)

#define ASSERT_THROWS(expr, exception_type)                              \
    do {                                                                 \
        bool caught = false;                                             \
        try { expr; } catch (const exception_type&) { caught = true; }   \
        if (!caught) {                                                   \
            throw std::runtime_error(                                    \
                std::string("Expected ") + #exception_type               \
                + " but none thrown");                                    \
        }                                                                \
    } while (0)

// ─── JWT crafting helpers ───────────────────────────────────────────────────

// Simple base64url encode (no padding) for crafting test JWTs.
static std::string base64url_encode(const std::string& input) {
    static const char table[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    std::string encoded;
    int val = 0, valb = -6;
    for (unsigned char c : input) {
        val = (val << 8) + c;
        valb += 8;
        while (valb >= 0) {
            encoded += table[(val >> valb) & 0x3F];
            valb -= 6;
        }
    }
    if (valb > -6) {
        encoded += table[((val << 8) >> (valb + 8)) & 0x3F];
    }
    // No padding for base64url
    // Convert + to -, / to _
    for (auto& c : encoded) {
        if (c == '+') c = '-';
        else if (c == '/') c = '_';
    }
    return encoded;
}

/// Create a fake JWT with the given expiry timestamp.
static std::string make_jwt(int64_t exp) {
    std::string header = R"({"alg":"HS256","typ":"JWT"})";
    std::ostringstream payload;
    payload << R"({"sub":"user123","exp":)" << exp << R"(,"iat":)" << (exp - 900) << "}";
    std::string signature = "fake_signature_for_testing";

    return base64url_encode(header) + "." + base64url_encode(payload.str()) + "." + base64url_encode(signature);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

static void test_initial_state() {
    dominusnode::TokenManager mgr;
    ASSERT_FALSE(mgr.has_access_token());
    ASSERT_FALSE(mgr.has_refresh_token());
}

static void test_set_tokens() {
    dominusnode::TokenManager mgr;
    mgr.set_tokens("access_abc", "refresh_xyz");
    ASSERT_TRUE(mgr.has_access_token());
    ASSERT_TRUE(mgr.has_refresh_token());
}

static void test_set_access_only() {
    dominusnode::TokenManager mgr;
    mgr.set_tokens("access_only");
    ASSERT_TRUE(mgr.has_access_token());
    ASSERT_FALSE(mgr.has_refresh_token());
}

static void test_clear_tokens() {
    dominusnode::TokenManager mgr;
    mgr.set_tokens("access", "refresh");
    ASSERT_TRUE(mgr.has_access_token());
    mgr.clear();
    ASSERT_FALSE(mgr.has_access_token());
    ASSERT_FALSE(mgr.has_refresh_token());
}

static void test_expired_empty_token() {
    dominusnode::TokenManager mgr;
    ASSERT_TRUE(mgr.is_expired(""));
}

static void test_expired_garbage_token() {
    dominusnode::TokenManager mgr;
    ASSERT_TRUE(mgr.is_expired("not.a.jwt"));
    ASSERT_TRUE(mgr.is_expired("garbage"));
    ASSERT_TRUE(mgr.is_expired("a.b"));
}

static void test_expired_token() {
    dominusnode::TokenManager mgr;
    // Token that expired 1 hour ago
    int64_t past = static_cast<int64_t>(std::time(nullptr)) - 3600;
    std::string token = make_jwt(past);
    ASSERT_TRUE(mgr.is_expired(token));
}

static void test_valid_token_not_expired() {
    dominusnode::TokenManager mgr;
    // Token that expires 1 hour from now (well beyond the 60s buffer)
    int64_t future = static_cast<int64_t>(std::time(nullptr)) + 3600;
    std::string token = make_jwt(future);
    ASSERT_FALSE(mgr.is_expired(token));
}

static void test_token_within_buffer_is_expired() {
    dominusnode::TokenManager mgr;
    // Token that expires in 30 seconds (within the 60s buffer)
    int64_t near_future = static_cast<int64_t>(std::time(nullptr)) + 30;
    std::string token = make_jwt(near_future);
    ASSERT_TRUE(mgr.is_expired(token));
}

static void test_get_valid_token_returns_valid() {
    dominusnode::TokenManager mgr;
    int64_t future = static_cast<int64_t>(std::time(nullptr)) + 3600;
    std::string token = make_jwt(future);
    mgr.set_tokens(token);

    std::string result = mgr.get_valid_token();
    ASSERT_EQ(result, token);
}

static void test_get_valid_token_throws_when_expired_no_refresh() {
    dominusnode::TokenManager mgr;
    int64_t past = static_cast<int64_t>(std::time(nullptr)) - 3600;
    std::string token = make_jwt(past);
    mgr.set_tokens(token);

    ASSERT_THROWS(mgr.get_valid_token(), dominusnode::AuthenticationError);
}

static void test_get_valid_token_throws_when_no_token() {
    dominusnode::TokenManager mgr;
    ASSERT_THROWS(mgr.get_valid_token(), dominusnode::AuthenticationError);
}

static void test_refresh_called_when_expired() {
    dominusnode::TokenManager mgr;

    // Set an expired access token and a refresh token
    int64_t past = static_cast<int64_t>(std::time(nullptr)) - 3600;
    int64_t future = static_cast<int64_t>(std::time(nullptr)) + 3600;
    std::string expired_token = make_jwt(past);
    std::string new_token = make_jwt(future);

    mgr.set_tokens(expired_token, "refresh_token_123");

    bool refresh_called = false;
    mgr.set_refresh_function(
        [&](const std::string& rt) -> dominusnode::RefreshResult {
            refresh_called = true;
            ASSERT_EQ(rt, "refresh_token_123");
            return dominusnode::RefreshResult{new_token, "new_refresh_456"};
        });

    std::string result = mgr.get_valid_token();
    ASSERT_TRUE(refresh_called);
    ASSERT_EQ(result, new_token);
}

static void test_refresh_rotates_refresh_token() {
    dominusnode::TokenManager mgr;

    int64_t past = static_cast<int64_t>(std::time(nullptr)) - 3600;
    int64_t future = static_cast<int64_t>(std::time(nullptr)) + 3600;
    std::string expired_token = make_jwt(past);
    std::string new_access = make_jwt(future);

    mgr.set_tokens(expired_token, "old_refresh");
    mgr.set_refresh_function(
        [&](const std::string& /* rt */) -> dominusnode::RefreshResult {
            return dominusnode::RefreshResult{new_access, "rotated_refresh"};
        });

    mgr.get_valid_token();
    ASSERT_TRUE(mgr.has_refresh_token());

    // Make token expire again to trigger another refresh
    int64_t past2 = static_cast<int64_t>(std::time(nullptr)) - 100;
    int64_t future2 = static_cast<int64_t>(std::time(nullptr)) + 7200;
    std::string expired2 = make_jwt(past2);
    std::string new_access2 = make_jwt(future2);

    mgr.set_tokens(expired2);  // Overwrite access but keep refresh
    mgr.set_refresh_function(
        [&](const std::string& rt) -> dominusnode::RefreshResult {
            ASSERT_EQ(rt, "rotated_refresh");  // Should use the rotated token
            return dominusnode::RefreshResult{new_access2, ""};
        });

    mgr.get_valid_token();
}

static void test_overwrite_tokens() {
    dominusnode::TokenManager mgr;
    int64_t future = static_cast<int64_t>(std::time(nullptr)) + 3600;
    std::string token1 = make_jwt(future);
    std::string token2 = make_jwt(future + 100);

    mgr.set_tokens(token1, "r1");
    ASSERT_EQ(mgr.get_valid_token(), token1);

    mgr.set_tokens(token2, "r2");
    ASSERT_EQ(mgr.get_valid_token(), token2);
}

// ─── Main ───────────────────────────────────────────────────────────────────

int run_token_manager_tests() {
    std::printf("Running token manager tests...\n");

    TEST(initial_state);
    TEST(set_tokens);
    TEST(set_access_only);
    TEST(clear_tokens);
    TEST(expired_empty_token);
    TEST(expired_garbage_token);
    TEST(expired_token);
    TEST(valid_token_not_expired);
    TEST(token_within_buffer_is_expired);
    TEST(get_valid_token_returns_valid);
    TEST(get_valid_token_throws_when_expired_no_refresh);
    TEST(get_valid_token_throws_when_no_token);
    TEST(refresh_called_when_expired);
    TEST(refresh_rotates_refresh_token);
    TEST(overwrite_tokens);

    std::printf("Token manager tests: %d passed, %d failed\n\n", tests_passed, tests_failed);
    return tests_failed;
}

#undef TEST
#undef ASSERT_EQ
#undef ASSERT_TRUE
#undef ASSERT_FALSE
#undef ASSERT_THROWS
