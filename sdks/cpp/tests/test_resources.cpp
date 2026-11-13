// One row per resource method: HTTP method, path (incl. encoding + query), body and auth mode.
#include "test_util.hpp"

using namespace t;

namespace {

const std::string U = "11111111-2222-4333-8444-555555555555";
const std::string ADDR = "0x00000000000000000000000000000000000000Aa";
const std::string SIG = "0x" + std::string(130, 'a');

struct Row {
    const char* name;
    std::function<void(DominusNodeClient&)> call;
    const char* method;
    std::string path;
    json body;   // null = no body
    char auth;   // 'n' none, 'j' jwt, 'a' agent (raw key)
};

std::vector<Row> rows() {
    using C = DominusNodeClient&;
    return {
        // auth (4)
        {"auth.verify_key", [](C c) { c.auth.verify_key(KEY); }, "POST", "/api/auth/verify-key", {{"apiKey", KEY}}, 'n'},
        {"auth.refresh", [](C c) { c.auth.refresh("rt"); }, "POST", "/api/auth/refresh", {{"refreshToken", "rt"}}, 'n'},
        {"auth.logout", [](C c) { c.auth.logout(); }, "POST", "/api/auth/logout", json::object(), 'j'},
        {"auth.me", [](C c) { c.auth.me(); }, "GET", "/api/auth/me", nullptr, 'j'},
        // walletAuth (3 here + sign_in in test_signed)
        {"wallet_auth.challenge", [](C c) { c.wallet_auth.challenge(ADDR); }, "POST", "/api/auth/wallet/challenge", {{"address", ADDR}}, 'n'},
        {"wallet_auth.verify", [](C c) { c.wallet_auth.verify(ADDR, SIG); }, "POST", "/api/auth/wallet/verify", {{"address", ADDR}, {"signature", SIG}}, 'n'},
        {"wallet_auth.link", [](C c) { c.wallet_auth.link(ADDR, SIG); }, "POST", "/api/auth/wallet/link", {{"address", ADDR}, {"signature", SIG}}, 'j'},
        // keys (3)
        {"keys.create", [](C c) { c.keys.create(); }, "POST", "/api/keys", {{"label", "Default"}}, 'j'},
        {"keys.list", [](C c) { c.keys.list(); }, "GET", "/api/keys", nullptr, 'j'},
        {"keys.revoke", [](C c) { c.keys.revoke("a/b"); }, "DELETE", "/api/keys/a%2Fb", nullptr, 'j'},
        // wallet (5)
        {"wallet.get_balance", [](C c) { c.wallet.get_balance(); }, "GET", "/api/wallet", nullptr, 'j'},
        {"wallet.get_transactions", [](C c) { c.wallet.get_transactions(10, 5); }, "GET", "/api/wallet/transactions?limit=10&offset=5", nullptr, 'j'},
        {"wallet.get_forecast", [](C c) { c.wallet.get_forecast(); }, "GET", "/api/wallet/forecast", nullptr, 'j'},
        {"wallet.top_up_crypto", [](C c) { c.wallet.top_up_crypto(2550, "BTC"); }, "POST", "/api/wallet/topup/crypto", {{"amountUsd", 25.5}, {"currency", "btc"}}, 'j'},
        {"wallet.get_crypto_status", [](C c) { c.wallet.get_crypto_status(U); }, "GET", "/api/wallet/crypto/status/" + U, nullptr, 'j'},
        // agenticWallets (9)
        {"agentic_wallets.create", [](C c) { c.agentic_wallets.create("bot", 500, 100, std::vector<std::string>{"a.com"}); }, "POST", "/api/agent-wallet",
         {{"label", "bot"}, {"spendingLimitCents", 500}, {"dailyLimitCents", 100}, {"allowedDomains", {"a.com"}}}, 'j'},
        {"agentic_wallets.list", [](C c) { c.agentic_wallets.list(); }, "GET", "/api/agent-wallet", nullptr, 'j'},
        {"agentic_wallets.get", [](C c) { c.agentic_wallets.get("w 1"); }, "GET", "/api/agent-wallet/w%201", nullptr, 'j'},
        {"agentic_wallets.fund", [](C c) { c.agentic_wallets.fund("w1", 100); }, "POST", "/api/agent-wallet/w1/fund", {{"amountCents", 100}}, 'j'},
        {"agentic_wallets.update_wallet_policy", [](C c) { WalletPolicy p; p.daily_limit_cents = 7; p.clear_allowed_domains = true; c.agentic_wallets.update_wallet_policy("w1", p); },
         "PATCH", "/api/agent-wallet/w1/policy", {{"dailyLimitCents", 7}, {"allowedDomains", nullptr}}, 'j'},
        {"agentic_wallets.transactions", [](C c) { c.agentic_wallets.transactions("w1", 3); }, "GET", "/api/agent-wallet/w1/transactions?limit=3", nullptr, 'j'},
        {"agentic_wallets.freeze", [](C c) { c.agentic_wallets.freeze("w1"); }, "POST", "/api/agent-wallet/w1/freeze", json::object(), 'j'},
        {"agentic_wallets.unfreeze", [](C c) { c.agentic_wallets.unfreeze("w1"); }, "POST", "/api/agent-wallet/w1/unfreeze", json::object(), 'j'},
        {"agentic_wallets.delete_wallet", [](C c) { c.agentic_wallets.delete_wallet("w1"); }, "DELETE", "/api/agent-wallet/w1", nullptr, 'j'},
        // teams (18)
        {"teams.create", [](C c) { c.teams.create("T", 5); }, "POST", "/api/teams", {{"name", "T"}, {"maxMembers", 5}}, 'j'},
        {"teams.list", [](C c) { c.teams.list(); }, "GET", "/api/teams", nullptr, 'j'},
        {"teams.get", [](C c) { c.teams.get("t?1"); }, "GET", "/api/teams/t%3F1", nullptr, 'j'},
        {"teams.update", [](C c) { c.teams.update("t1", std::string("N")); }, "PATCH", "/api/teams/t1", {{"name", "N"}}, 'j'},
        {"teams.delete_team", [](C c) { c.teams.delete_team("t1"); }, "DELETE", "/api/teams/t1", nullptr, 'j'},
        {"teams.fund_wallet", [](C c) { c.teams.fund_wallet("t1", 250); }, "POST", "/api/teams/t1/wallet/fund", {{"amountCents", 250}}, 'j'},
        {"teams.get_transactions", [](C c) { c.teams.get_transactions("t1", 1, 2); }, "GET", "/api/teams/t1/wallet/transactions?limit=1&offset=2", nullptr, 'j'},
        {"teams.list_members", [](C c) { c.teams.list_members("t1"); }, "GET", "/api/teams/t1/members", nullptr, 'j'},
        {"teams.add_member", [](C c) { c.teams.add_member("t1", "x@y.z", std::string("admin")); }, "POST", "/api/teams/t1/members", {{"email", "x@y.z"}, {"role", "admin"}}, 'j'},
        {"teams.update_member_role", [](C c) { c.teams.update_member_role("t1", "u/1", "member"); }, "PATCH", "/api/teams/t1/members/u%2F1", {{"role", "member"}}, 'j'},
        {"teams.remove_member", [](C c) { c.teams.remove_member("t1", "u1"); }, "DELETE", "/api/teams/t1/members/u1", nullptr, 'j'},
        {"teams.create_invite", [](C c) { c.teams.create_invite("t1", "x@y.z"); }, "POST", "/api/teams/t1/invites", {{"email", "x@y.z"}}, 'j'},
        {"teams.list_invites", [](C c) { c.teams.list_invites("t1"); }, "GET", "/api/teams/t1/invites", nullptr, 'j'},
        {"teams.cancel_invite", [](C c) { c.teams.cancel_invite("t1", "i1"); }, "DELETE", "/api/teams/t1/invites/i1", nullptr, 'j'},
        {"teams.accept_invite", [](C c) { c.teams.accept_invite("tok&x"); }, "POST", "/api/teams/invites/tok%26x/accept", json::object(), 'j'},
        {"teams.create_key", [](C c) { c.teams.create_key("t1", "ci"); }, "POST", "/api/teams/t1/keys", {{"label", "ci"}}, 'j'},
        {"teams.list_keys", [](C c) { c.teams.list_keys("t1"); }, "GET", "/api/teams/t1/keys", nullptr, 'j'},
        {"teams.revoke_key", [](C c) { c.teams.revoke_key("t1", "k1"); }, "DELETE", "/api/teams/t1/keys/k1", nullptr, 'j'},
        // usage (4)
        {"usage.get", [](C c) { c.usage.get(std::string("2026-01-01T00:00:00Z"), std::nullopt, 10, 0); }, "GET", "/api/usage?since=2026-01-01T00%3A00%3A00Z&limit=10&offset=0", nullptr, 'j'},
        {"usage.get_daily", [](C c) { c.usage.get_daily(std::string("a"), std::string("b")); }, "GET", "/api/usage/daily?since=a&until=b", nullptr, 'j'},
        {"usage.get_top_hosts", [](C c) { c.usage.get_top_hosts(std::nullopt, std::nullopt, 5); }, "GET", "/api/usage/top-hosts?limit=5", nullptr, 'j'},
        {"usage.export_csv", [](C c) { c.usage.export_csv(); }, "GET", "/api/usage/export", nullptr, 'j'},
        // sessions (2)
        {"sessions.get_active", [](C c) { c.sessions.get_active(); }, "GET", "/api/sessions/active", nullptr, 'j'},
        {"sessions.report", [](C c) { c.sessions.report(U, "captcha"); }, "POST", "/v1/sessions/" + U + "/report", {{"reason", "captcha"}}, 'a'},
        // x402 (1)
        {"x402.get_info", [](C c) { c.x402.get_info(); }, "GET", "/api/x402/info", nullptr, 'n'},
        // network (3)
        {"network.policy", [](C c) { c.network.policy(); }, "GET", "/v1/policy", nullptr, 'n'},
        {"network.pricing", [](C c) { c.network.pricing(); }, "GET", "/v1/pricing", nullptr, 'n'},
        {"network.stats", [](C c) { c.network.stats(); }, "GET", "/v1/network/stats", nullptr, 'n'},
        // nodes (5 here + register_node in test_signed)
        {"nodes.register_challenge", [](C c) { c.nodes.register_challenge(std::string(64, 'A')); }, "POST", "/v1/nodes/challenge", {{"nodePubkey", std::string(64, 'a')}}, 'a'},
        {"nodes.list", [](C c) { c.nodes.list(500, 0); }, "GET", "/v1/nodes?limit=500&offset=0", nullptr, 'a'},
        {"nodes.revoke", [](C c) { c.nodes.revoke(U); }, "DELETE", "/v1/nodes/" + U, nullptr, 'a'},
        {"nodes.update_caps", [](C c) { NodeCaps k; k.gb_per_day = 5; c.nodes.update_caps(U, k); }, "PATCH", "/v1/nodes/" + U, {{"gbPerDay", 5}}, 'a'},
        {"nodes.tier", [](C c) { c.nodes.tier(); }, "GET", "/v1/node/tier", nullptr, 'a'},
        // credits (2 here + convert, withdraw in test_signed)
        {"credits.balance", [](C c) { c.credits.balance(); }, "GET", "/v1/credits", nullptr, 'a'},
        {"credits.transactions", [](C c) { c.credits.transactions(50, std::string("123"), std::string("earn")); }, "GET", "/v1/credits/transactions?limit=50&cursor=123&type=earn", nullptr, 'a'},
        // payoutWallet (1 here + set in test_signed)
        {"payout_wallet.get", [](C c) { c.payout_wallet.get(); }, "GET", "/v1/payout-wallet", nullptr, 'a'},
        // payouts (1)
        {"payouts.list", [](C c) { c.payouts.list(200, 1000000); }, "GET", "/v1/payouts?limit=200&offset=1000000", nullptr, 'a'},
        // proxy (2 HTTP methods here; build_username/build_url/fetch in test_proxy)
        {"proxy.get_health", [](C c) { c.proxy.get_health(); }, "GET", "/api/proxy/health", nullptr, 'n'},
        {"proxy.get_config", [](C c) { c.proxy.get_config(); }, "GET", "/api/proxy/config", nullptr, 'j'},
    };
}

}  // namespace

TEST(every_method_sends_expected_request) {
    auto rs = rows();
    // 71 methods = these rows + wallet_auth.sign_in, nodes.register_node, credits.convert,
    // credits.withdraw, payout_wallet.set (test_signed) + proxy.build_username/build_url/fetch (test_proxy).
    CHECK_EQ(rs.size() + 5 + 3, std::size_t(71));
    for (const auto& r : rs) {
        Fixture f;
        try {
            r.call(*f.client);
        } catch (const std::exception& e) {
            fail(std::string(r.name) + " threw " + e.what(), __FILE__, __LINE__);
        }
        if (f.mock.calls.size() != 1) fail(std::string(r.name) + ": expected 1 request", __FILE__, __LINE__);
        const auto& q = f.mock.last();
        std::string ctx = std::string(r.name) + ": ";
        if (q.method != r.method) fail(ctx + "method " + q.method, __FILE__, __LINE__);
        if (Mock::path(q) != r.path) fail(ctx + "path " + Mock::path(q), __FILE__, __LINE__);
        if (r.body.is_null()) {
            if (q.body || Mock::has_header(q, "Content-Type")) fail(ctx + "unexpected body", __FILE__, __LINE__);
        } else {
            if (Mock::body(q) != r.body) fail(ctx + "body " + Mock::body(q).dump(), __FILE__, __LINE__);
            if (Mock::header(q, "Content-Type") != "application/json") fail(ctx + "content-type", __FILE__, __LINE__);
        }
        std::string auth = Mock::header(q, "Authorization");
        std::string want = r.auth == 'n' ? "" : r.auth == 'j' ? "Bearer " + JWT : "Bearer " + KEY;
        if (auth != want) fail(ctx + "auth header '" + auth + "'", __FILE__, __LINE__);
        if (Mock::header(q, "User-Agent") != "dominusnode-sdk-cpp/2.3.0") fail(ctx + "user-agent", __FILE__, __LINE__);
        if (Mock::header(q, "Accept") != "application/json") fail(ctx + "accept", __FILE__, __LINE__);
    }
}

TEST(agent_mode_falls_back_to_wallet_jwt) {
    Fixture f(false);
    f.mock.push(200, {{"token", JWT}, {"refreshToken", RT}});
    f.client->wallet_auth.verify(ADDR, SIG);
    f.client->credits.balance();
    CHECK_EQ(Mock::header(f.mock.last(), "Authorization"), "Bearer " + JWT);
}

TEST(no_credential_raises_without_request) {
    Fixture f(false);
    CHECK_THROWS(f.client->auth.me(), AuthenticationError);
    CHECK_THROWS(f.client->credits.balance(), AuthenticationError);
    CHECK(f.mock.calls.empty());
    f.client->network.pricing();  // none-mode works
    CHECK_EQ(f.mock.calls.size(), std::size_t(1));
}

TEST(validation_failures_send_no_request) {
    Fixture f;
    auto& c = *f.client;
    const Signer cs{"0x" + std::string(40, 'a'), [](const std::string&) { return "0x" + std::string(130, 'b'); }};
    CHECK_INVALID(c.agentic_wallets.fund("w", 0));
    CHECK_INVALID(c.agentic_wallets.fund("w", 2147483648LL));
    CHECK_INVALID(c.teams.fund_wallet("t", 0));
    CHECK_INVALID(c.teams.fund_wallet("t", 2147483648LL));
    CHECK_INVALID(c.agentic_wallets.create("x", -1));
    CHECK_INVALID(c.agentic_wallets.create("x", 2147483648LL));
    CHECK_INVALID(c.agentic_wallets.create("x", 10, -1));
    { WalletPolicy p; p.daily_limit_cents = 2147483648LL; CHECK_INVALID(c.agentic_wallets.update_wallet_policy("w", p)); }
    CHECK_INVALID(c.wallet.top_up_crypto(999, "btc"));
    CHECK_INVALID(c.wallet.top_up_crypto(100001, "btc"));
    CHECK_INVALID(c.wallet.top_up_crypto(1000, "doge"));
    CHECK_INVALID(c.wallet.get_crypto_status("not-a-uuid"));
    CHECK_INVALID(c.credits.convert(9999LL, cs));
    CHECK_INVALID(c.credits.convert(10000000001LL, cs));
    CHECK_INVALID(c.credits.convert("010000", cs));
    CHECK_INVALID(c.credits.convert("1.5", cs));
    CHECK_INVALID(c.credits.convert(-5, cs));
    CHECK_INVALID(c.credits.convert("12345678901234567", cs));
    CHECK_INVALID(c.credits.convert(20000LL, cs, std::string("short")));
    CHECK_INVALID(c.credits.convert(20000LL, cs, std::string("bad key!!")));
    CHECK_INVALID(c.credits.transactions(0));
    CHECK_INVALID(c.credits.transactions(201));
    CHECK_INVALID(c.credits.transactions(std::nullopt, std::string("abc")));
    CHECK_INVALID(c.credits.transactions(std::nullopt, std::nullopt, std::string("refund")));
    CHECK_INVALID(c.payouts.list(0));
    CHECK_INVALID(c.payouts.list(std::nullopt, 1000001));
    CHECK_INVALID(c.nodes.list(501));
    CHECK_INVALID(c.nodes.revoke("x"));
    CHECK_INVALID(c.nodes.update_caps(U, NodeCaps{}));
    { NodeCaps k; k.max_streams = 0; CHECK_INVALID(c.nodes.update_caps(U, k)); }
    CHECK_INVALID(c.nodes.register_challenge(std::string("abc")));
    CHECK_INVALID(c.sessions.report("nope", "captcha"));
    CHECK_INVALID(c.sessions.report(U, "angry"));
    CHECK_INVALID(c.keys.create(""));
    CHECK_INVALID(c.keys.create(std::string(101, 'x')));
    CHECK_INVALID(c.teams.create_key("t", ""));
    CHECK_INVALID(c.wallet_auth.challenge("0x123"));
    CHECK_INVALID(c.wallet_auth.verify(ADDR, "0x" + std::string(129, 'a')));
    CHECK_INVALID(c.wallet_auth.verify(ADDR, "0x" + std::string(199, 'a')));
    CHECK_INVALID(c.wallet_auth.verify(ADDR, "0x" + std::string(129, 'a') + "g"));
    CHECK_INVALID(c.wallet_auth.link("0x" + std::string(40, 'z'), SIG));
    CHECK_INVALID(c.auth.verify_key("sk_live_abcdefghij"));
    CHECK_INVALID(c.connect_with_key("dn_live_short"));
    CHECK(f.mock.calls.empty());
}

TEST(get_active_drops_unknown_fields) {
    Fixture f;
    f.mock.push(200, {{"sessions", {{{"id", "s1"}, {"startedAt", "t"}, {"status", "active"}, {"proxyIp", "1.2.3.4"}, {"proxy_ip", "x"}}}}});
    auto r = f.client->sessions.get_active();
    CHECK_EQ(r.sessions.size(), std::size_t(1));
    CHECK_EQ(r.sessions[0].id, std::string("s1"));
    CHECK_EQ(r.sessions[0].started_at, std::string("t"));
    CHECK_EQ(r.sessions[0].status, std::string("active"));
}

TEST(keys_create_wraps_secret) {
    Fixture f;
    f.mock.push(200, {{"id", "k1"}, {"prefix", "dn_live_"}, {"label", "L"}, {"created_at", "t"}, {"key", "dn_live_SECRETSECRET"}});
    auto k = f.client->keys.create("L");
    CHECK_EQ(k.key.reveal(), std::string("dn_live_SECRETSECRET"));
    CHECK_EQ(k.key.prefix(), std::string("dn_live_"));
    std::ostringstream os;
    os << k.key;
    CHECK_EQ(os.str(), std::string("[REDACTED]"));
    f.mock.push(200, {{"id", "tk"}, {"keyPrefix", "dn_live_"}, {"label", "ci"}, {"key", "dn_live_TEAMKEYTEAM"}});
    auto tk = f.client->teams.create_key("t1", "ci");
    CHECK_EQ(tk.key.reveal(), std::string("dn_live_TEAMKEYTEAM"));
    CHECK_EQ(json(tk.key).dump(), std::string("\"[REDACTED]\""));
}

TEST(export_csv_returns_raw_text) {
    Fixture f;
    f.mock.push_raw(200, "date,bytes\n2026-01-01,5\n");
    CHECK_EQ(f.client->usage.export_csv(), std::string("date,bytes\n2026-01-01,5\n"));
}

TEST(wallet_verify_mfa_stores_nothing) {
    Fixture f(false);
    f.mock.push(200, {{"mfaRequired", true}, {"mfaChallengeToken", "mct"}, {"token", JWT}});
    json r = f.client->wallet_auth.verify(ADDR, SIG);
    CHECK_EQ(r, json({{"mfaRequired", true}, {"mfaChallengeToken", "mct"}}));
    CHECK(!f.client->is_connected());
    f.mock.push(200, {{"token", JWT}, {"refreshToken", RT}, {"user", {{"id", "u"}}}});
    f.client->wallet_auth.verify(ADDR, SIG);
    CHECK(f.client->is_connected());
}
