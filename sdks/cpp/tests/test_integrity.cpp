// 2.0.1 server-alignment fixes: team keys, health, cursor, chain, byte counts, retries, pagination.
#include "test_util.hpp"

using namespace t;

namespace {
const std::string TEAM = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const std::string USER_ID = "11111111-2222-4333-8444-555555555555";
const std::string WALLET = "0xabcdef0123456789abcdef0123456789abcdef01";
const std::string NEW_ADDR = "0x3333333333333333333333333333333333333abc";
const std::string NONCE_HEX = std::string(64, 'c');
const std::string SIGNATURE = "0x" + std::string(130, 'a');
}  // namespace

TEST(team_key_prefix_and_list_fields) {
    Fixture f;
    f.mock.push(201, {{"id", "k"}, {"prefix", "dn_live_ab"}, {"label", "l"}, {"key", KEY}});
    auto k = f.client->teams.create_key(TEAM, "l");
    CHECK_EQ(k.prefix, std::string("dn_live_ab"));
    CHECK_EQ(k.key_prefix, std::string("dn_live_ab"));
    f.mock.push(201, {{"id", "k"}, {"keyPrefix", "dn_live_cd"}, {"label", "l"}, {"key", KEY}});
    CHECK_EQ(f.client->teams.create_key(TEAM, "l").prefix, std::string("dn_live_cd"));
    f.mock.push(200, {{"keys", json::array({
        {{"id", "k1"}, {"userId", "u1"}, {"prefix", "dn_live_x"}, {"teamId", TEAM}, {"revokedAt", nullptr}},
        {{"id", "k2"}, {"keyPrefix", "dn_live_y"}, {"revokedAt", "r"}}})}});
    json keys = f.client->teams.list_keys(TEAM)["keys"];
    CHECK_EQ(keys[0]["prefix"], json("dn_live_x"));
    CHECK_EQ(keys[0]["userId"], json("u1"));
    CHECK_EQ(keys[0]["teamId"], json(TEAM));
    CHECK(keys[0]["revokedAt"].is_null());
    CHECK_EQ(keys[1]["prefix"], json("dn_live_y"));
}

TEST(team_key_create_response_keeps_200_layout) {
    // 2.0.0 aggregate order {id, key_prefix, label, key} still compiles and lands in the same fields.
    TeamKeyCreateResponse r{"id1", "dn_live_x", "lbl", Secret("k")};
    CHECK_EQ(r.key_prefix, std::string("dn_live_x"));
    CHECK_EQ(r.label, std::string("lbl"));
    CHECK(r.prefix.empty());
}

TEST(health_status_only) {
    Fixture f(false);
    f.mock.push(200, {{"status", "ok"}, {"activeSessions", 4}});
    CHECK_EQ(f.client->proxy.get_health(), json({{"status", "ok"}}));
}

TEST(cursor_matches_server_regex) {
    Fixture f;
    for (const std::string bad : {"0", "01", "11111111111111111111", "-1", "1a"}) {
        CHECK_INVALID(f.client->credits.transactions(std::nullopt, bad));
    }
    CHECK(f.mock.calls.empty());
    f.mock.push(200, {{"transactions", json::array()}, {"nextCursor", nullptr}});
    f.client->credits.transactions(std::nullopt, std::string(19, '9'));
    CHECK(Mock::path(f.mock.last()).find("cursor=" + std::string(19, '9')) != std::string::npos);
}

TEST(byte_counts_tolerate_strings) {
    CHECK_EQ(byte_count(json("12345678901")), std::int64_t(12345678901LL));
    CHECK_EQ(byte_count(json(5)), std::int64_t(5));
    CHECK_EQ(byte_count(json(nullptr)), std::int64_t(0));
    CHECK_THROWS(byte_count(json("abc")), dominusnode::ServerError);
    CHECK_THROWS(byte_count(json("1.5")), dominusnode::ServerError);
    CHECK_THROWS(byte_count(json(1.5)), dominusnode::ServerError);
    CHECK_THROWS(byte_count(json("99999999999999999999")), dominusnode::ServerError);
    CHECK_THROWS(byte_count(json(true)), dominusnode::ServerError);
}

TEST(payout_wallet_base_sepolia) {
    Fixture f;
    auto signed_msgs = std::make_shared<std::vector<std::string>>();
    Signer s{WALLET, [signed_msgs](const std::string& m) { signed_msgs->push_back(m); return SIGNATURE; }};
    f.mock.push(200, {{"nonce", NONCE_HEX},
                      {"message", build_payout_wallet_message(USER_ID, WALLET, NEW_ADDR, "base-sepolia", NONCE_HEX)},
                      {"expiresAt", "t"}, {"signer", WALLET}, {"oldWalletSignatureRequired", false}, {"oldWalletAddress", nullptr}});
    f.mock.push(200, {{"payoutWallet", nullptr}, {"changed", true}, {"cooldownHours", 0}});
    f.client->payout_wallet.set(NEW_ADDR, s, "base-sepolia");
    CHECK_EQ(Mock::body(f.mock.calls[0]), json({{"address", NEW_ADDR}, {"chain", "base-sepolia"}}));
    CHECK_EQ(signed_msgs->size(), std::size_t(1));
    std::size_t before = f.mock.calls.size();
    CHECK_INVALID(f.client->payout_wallet.set(NEW_ADDR, s, "eth"));
    CHECK_EQ(f.mock.calls.size(), before);
}

TEST(report_limit_not_retried) {
    Fixture f;
    f.mock.push(409, {{"error", "At most 20 reports"}, {"code", "REPORT_LIMIT"}});
    bool got = false;
    try {
        f.client->sessions.report(TEAM, "blocked");
    } catch (const dominusnode::ConflictError& e) {
        got = e.code() == std::optional<std::string>("REPORT_LIMIT");
    }
    CHECK(got);
    CHECK_EQ(f.mock.calls.size(), std::size_t(1));
    f.mock.push(429, json::object(), {{"retry-after", "0"}});
    f.mock.push(429, {{"code", "REPORT_LIMIT"}}, {{"retry-after", "0"}});
    got = false;
    try {
        f.client->sessions.report(TEAM, "blocked");
    } catch (const dominusnode::RateLimitError& e) {
        got = e.code() == std::optional<std::string>("REPORT_LIMIT");
    }
    CHECK(got);
    CHECK_EQ(f.mock.calls.size(), std::size_t(3));
}

TEST(pagination_helpers) {
    Fixture f;
    f.mock.push(200, {{"transactions", json::array({{{"id", "3"}}, {{"id", "2"}}})}, {"nextCursor", "2"}});
    f.mock.push(200, {{"transactions", json::array({{{"id", "1"}}})}, {"nextCursor", nullptr}});
    std::vector<std::string> ids;
    f.client->credits.for_each_transaction([&](const json& t) { ids.push_back(t["id"]); return true; }, 2, std::string("earn"));
    CHECK_EQ(ids, (std::vector<std::string>{"3", "2", "1"}));
    CHECK_EQ(Mock::path(f.mock.calls[1]), std::string("/v1/credits/transactions?limit=2&cursor=2&type=earn"));

    f.mock.calls.clear();
    f.mock.push(200, {{"payouts", json::array({{{"id", "a"}}, {{"id", "b"}}})}});
    f.mock.push(200, {{"payouts", json::array({{{"id", "c"}}})}});
    int n = 0;
    f.client->payouts.for_each([&](const json&) { ++n; return true; }, 2);
    CHECK_EQ(n, 3);
    CHECK_EQ(Mock::path(f.mock.calls[1]), std::string("/v1/payouts?limit=2&offset=2"));

    f.mock.calls.clear();
    f.mock.push(200, {{"nodes", json::array({{{"id", "a"}}, {{"id", "b"}}})}});
    n = 0;
    f.client->nodes.for_each([&](const json&) { ++n; return false; }, 2);
    CHECK_EQ(n, 1);
    CHECK_EQ(f.mock.calls.size(), std::size_t(1));

    f.mock.calls.clear();
    f.mock.push(200, {{"nodes", json::array({{{"id", "a"}, {"verifiedClass", "masked"}, {"tierWeight", 0.25}}})}, {"nextCursor", "abc="}});
    f.mock.push(200, {{"nodes", json::array({{{"id", "b"}}})}, {"nextCursor", nullptr}});
    n = 0;
    f.client->nodes.for_each([&](const json&) { ++n; return true; }, 1);
    CHECK_EQ(n, 2);
    CHECK(Mock::path(f.mock.calls[1]).find("cursor=abc%3D") != std::string::npos);

    f.mock.calls.clear();
    f.mock.push(200, {{"records", json::array({{{"id", "a"}}, {{"id", "b"}}})}, {"pagination", {{"total", 2}}}});
    n = 0;
    f.client->usage.for_each_record([&](const json&) { ++n; return true; }, std::string("2026-01-01"), std::nullopt, 2);
    CHECK_EQ(n, 2);
    CHECK_EQ(f.mock.calls.size(), std::size_t(1));

    f.mock.calls.clear();
    f.mock.push(200, {{"transactions", json::array({{{"id", "a"}}})}});
    n = 0;
    f.client->wallet.for_each_transaction([&](const json&) { ++n; return true; }, 5);
    CHECK_EQ(n, 1);
    CHECK_INVALID(f.client->wallet.for_each_transaction([](const json&) { return true; }, 101));
}
