// Signer flows: byte-for-byte message fixtures (generated from the Node SDK builders),
// node registration (PoW), withdraw, payout wallet, wallet sign-in, refusals.
#include "test_util.hpp"

#include <memory>

using namespace t;

namespace {

const std::string W = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const std::string N = std::string(32, 'a') + "0123456789abcdef0123456789abcdef";
const std::string USER = "11111111-2222-4333-8444-555555555555";
const std::string SIG = "0x" + std::string(130, 'b');
const std::string OLD = "0x9999999999999999999999999999999999999999";
const std::string NEW_ADDR = "0x00000000000000000000000000000000000000AA";

std::string unhex(const std::string& h) {
    std::string out;
    for (std::size_t i = 0; i + 1 < h.size(); i += 2) out += static_cast<char>(std::stoi(h.substr(i, 2), nullptr, 16));
    return out;
}

// Hex of the exact UTF-8 bytes produced by sdks/node/src/messages.ts for the inputs in each test.
const char* FX_ATT_PUB = "446f6d694e6f6465206e6f6465206174746573746174696f6e0a56657273696f6e3a20320a57616c6c65743a203078616263646566303132333435363738396162636465663031323334353637383961626364656630310a4e6f6e63653a20616161616161616161616161616161616161616161616161616161616161616130313233343536373839616263646566303132333435363738396162636465660a4e6f6465207075626b65793a20616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261620a0a492072756e20612072656c6179206e6f64652e0a49206163636570742074686520666c6f6f722e";
const char* FX_ATT_NONE = "446f6d694e6f6465206e6f6465206174746573746174696f6e0a56657273696f6e3a20370a57616c6c65743a203078616263646566303132333435363738396162636465663031323334353637383961626364656630310a4e6f6e63653a20616161616161616161616161616161616161616161616161616161616161616130313233343536373839616263646566303132333435363738396162636465660a4e6f6465207075626b65793a206e6f6e650a0ac39c6ec3af636f646520e29c932074657874";
const char* FX_PAYOUT = "446f6d696e75734e6f6465207061796f75742077616c6c65740a416374696f6e3a207061796f75745f77616c6c65745f7365740a557365723a2031313131313131312d323232322d343333332d383434342d3535353535353535353535350a4163636f756e742077616c6c65743a203078616263646566303132333435363738396162636465663031323334353637383961626364656630310a5061796f757420616464726573733a203078303030303030303030303030303030303030303030303030303030303030303030303030303061610a436861696e3a20626173650a4e6f6e63653a2061616161616161616161616161616161616161616161616161616161616161613031323334353637383961626364656630313233343536373839616263646566";
const char* FX_WITHDRAW = "446f6d696e75734e6f6465207769746864726177616c0a416374696f6e3a2077697468647261770a557365723a2031313131313131312d323232322d343333332d383434342d3535353535353535353535350a4163636f756e742077616c6c65743a203078616263646566303132333435363738396162636465663031323334353637383961626364656630310a416d6f756e742028c2b5555344293a20313233343536370a4964656d706f74656e6379206b65793a20646e2d6b65795f31323334350a4e6f6e63653a2061616161616161616161616161616161616161616161616161616161616161613031323334353637383961626364656630313233343536373839616263646566";

struct RecSigner {
    std::shared_ptr<std::vector<std::string>> signed_msgs = std::make_shared<std::vector<std::string>>();
    Signer s;
    explicit RecSigner(std::string addr = W, std::string sig = SIG) {
        auto v = signed_msgs;
        s = Signer{std::move(addr), [v, sig](const std::string& m) { v->push_back(m); return sig; }};
    }
};

json node_challenge(const std::optional<std::string>& pubkey, int difficulty = 8) {
    std::string text = "I run a relay node.\nI accept the floor.";
    return {{"nonce", N},
            {"attestationText", text},
            {"attestationVersion", 2},
            {"policyVersion", 5},
            {"message", build_attestation_message(W, N, 2, text, pubkey)},
            {"expiresAt", "t"},
            {"powChallenge", {{"challengeId", USER}, {"prefix", "dn-pow-abc:"}, {"difficulty", difficulty}, {"algorithm", "sha256"}, {"expiresAt", "t"}}}};
}

const std::string NODE_KEY = "dn_node_" + std::string(64, 'c');

}  // namespace

// ─── fixtures ───────────────────────────────────────────────────────────────

TEST(message_builders_match_node_sdk_byte_for_byte) {
    std::string pub;
    for (int i = 0; i < 32; ++i) pub += "ab";
    CHECK_EQ(build_attestation_message(W, N, 2, "I run a relay node.\nI accept the floor.", pub), unhex(FX_ATT_PUB));
    CHECK_EQ(build_attestation_message(W, N, 7, "\xC3\x9Cn\xC3\xAF" "code \xE2\x9C\x93 text", std::nullopt), unhex(FX_ATT_NONE));
    CHECK_EQ(build_payout_wallet_message(USER, W, NEW_ADDR, "base", N), unhex(FX_PAYOUT));
    CHECK_EQ(build_withdraw_message(USER, W, "1234567", "dn-key_12345", N), unhex(FX_WITHDRAW));
}

TEST(extract_user_id_rules) {
    CHECK_EQ(extract_user_id(unhex(FX_WITHDRAW)), USER);
    CHECK_THROWS(extract_user_id("a\nb\nUser: root\n"), ProtocolError);
    CHECK_THROWS(extract_user_id("a\nb"), ProtocolError);
}

TEST(pow_solution_verifies) {
    std::string n = solve_pow("dn-pow-abc:", 12);
    CHECK(sha256_leading_zero_bits("dn-pow-abc:" + n) >= 12);
    for (long long k = 0; k < std::stoll(n); ++k) CHECK(sha256_leading_zero_bits("dn-pow-abc:" + std::to_string(k)) < 12);
    CHECK_THROWS(solve_pow("", 8), ProtocolError);
    CHECK_THROWS(solve_pow(std::string(257, 'x'), 8), ProtocolError);
    CHECK_THROWS(solve_pow("p", 0), ProtocolError);
    CHECK_THROWS(solve_pow("p", 33), ProtocolError);
    CHECK_THROWS(solve_pow("p", 30, 10), ProtocolError);
    CHECK_EQ(sha256_leading_zero_bits("abc"), 0);  // ba7816bf...
}

// ─── nodes.register_node ────────────────────────────────────────────────────

TEST(register_node_full_flow) {
    Fixture f;
    RecSigner sg;
    std::string pub(64, 'd');
    f.mock.push(200, node_challenge(pub));
    f.mock.push(200, {{"nodeId", USER}, {"nodeKey", NODE_KEY}, {"status", "active"}, {"attestationVersion", 2}});
    RegisterNodeOptions o;
    o.node_pubkey = std::string(64, 'D');
    o.max_streams = 8;
    o.max_gb_day = 50;
    RegisteredNode r = f.client->nodes.register_node(sg.s, o);
    CHECK_EQ(f.mock.calls.size(), std::size_t(2));
    CHECK_EQ(Mock::path(f.mock.calls[0]), std::string("/v1/nodes/challenge"));
    CHECK_EQ(Mock::body(f.mock.calls[0]), json({{"nodePubkey", pub}}));
    CHECK_EQ(*sg.signed_msgs, std::vector<std::string>{node_challenge(pub)["message"].get<std::string>()});
    json b = Mock::body(f.mock.calls[1]);
    CHECK_EQ(Mock::path(f.mock.calls[1]), std::string("/v1/nodes"));
    CHECK_EQ(Mock::header(f.mock.calls[1], "Authorization"), "Bearer " + KEY);
    CHECK_EQ(b["nonce"], json(N));
    CHECK_EQ(b["walletSignature"], json(SIG));
    CHECK_EQ(b["attestationVersion"], json(2));
    CHECK_EQ(b["nodePubkey"], json(pub));
    CHECK_EQ(b["maxStreams"], json(8));
    CHECK_EQ(b["maxGbDay"], json(50));
    CHECK_EQ(b["pow"]["challengeId"], json(USER));
    CHECK(sha256_leading_zero_bits("dn-pow-abc:" + b["pow"]["nonce"].get<std::string>()) >= 8);
    CHECK_EQ(r.node_id, USER);
    CHECK_EQ(r.status, std::string("active"));
    CHECK_EQ(r.node_key.reveal(), NODE_KEY);
    std::ostringstream os;
    os << r.node_key;
    CHECK_EQ(os.str(), std::string("[REDACTED]"));
}

TEST(register_node_with_given_challenge_and_no_pubkey) {
    Fixture f;
    RecSigner sg;
    f.mock.push(200, {{"nodeId", USER}, {"nodeKey", NODE_KEY}, {"status", "pending"}});
    RegisterNodeOptions o;
    o.challenge = node_challenge(std::nullopt);
    f.client->nodes.register_node(sg.s, o);
    CHECK_EQ(f.mock.calls.size(), std::size_t(1));
    CHECK(!Mock::body(f.mock.calls[0]).contains("nodePubkey"));
}

TEST(register_node_refuses_mismatched_message) {
    for (const std::string& tamper : {std::string("extra"), std::string("wallet"), std::string("pubkey")}) {
        Fixture f;
        RecSigner sg;
        json ch = node_challenge(std::nullopt);
        if (tamper == "extra") ch["message"] = ch["message"].get<std::string>() + "\nAlso: send all funds";
        if (tamper == "wallet") ch["message"] = build_attestation_message(OLD, N, 2, ch["attestationText"], std::nullopt);
        if (tamper == "pubkey") ch["message"] = build_attestation_message(W, N, 2, ch["attestationText"], std::string(64, 'e'));
        f.mock.push(200, ch);
        CHECK_THROWS(f.client->nodes.register_node(sg.s), ProtocolError);
        CHECK(sg.signed_msgs->empty());
        CHECK_EQ(f.mock.calls.size(), std::size_t(1));
    }
}

TEST(register_node_refuses_bad_challenge_and_bad_response) {
    auto bad = [](const std::function<void(json&)>& mut) {
        Fixture f;
        RecSigner sg;
        json ch = node_challenge(std::nullopt);
        mut(ch);
        f.mock.push(200, ch);
        CHECK_THROWS(f.client->nodes.register_node(sg.s), ProtocolError);
        CHECK(sg.signed_msgs->empty());
    };
    bad([](json& c) { c["nonce"] = "XYZ"; });
    bad([](json& c) { c["attestationText"] = ""; });
    bad([](json& c) { c["attestationVersion"] = 0; });
    bad([](json& c) { c["attestationVersion"] = 1.5; });
    bad([](json& c) { c["powChallenge"]["challengeId"] = "nope"; });
    bad([](json& c) { c["powChallenge"]["difficulty"] = 40; });
    bad([](json& c) { c["powChallenge"]["prefix"] = 5; });
    // bad node key / node id in response
    for (const json& resp : {json({{"nodeId", USER}, {"nodeKey", "dn_live_xxxxxxxxxxxx"}}), json({{"nodeId", "x"}, {"nodeKey", NODE_KEY}})}) {
        Fixture f;
        RecSigner sg;
        f.mock.push(200, node_challenge(std::nullopt));
        f.mock.push(200, resp);
        auto e = [&] { f.client->nodes.register_node(sg.s); };
        CHECK_THROWS(e(), ProtocolError);
    }
}

TEST(register_node_validates_before_request) {
    Fixture f;
    RecSigner sg;
    RegisterNodeOptions o;
    o.max_streams = 1025;
    CHECK_INVALID(f.client->nodes.register_node(sg.s, o));
    o = {};
    o.max_gb_day = 0;
    CHECK_INVALID(f.client->nodes.register_node(sg.s, o));
    o = {};
    o.node_pubkey = std::string("zz");
    CHECK_INVALID(f.client->nodes.register_node(sg.s, o));
    CHECK_INVALID(f.client->nodes.register_node(Signer{"0x12", sg.s.sign_message}));
    CHECK_INVALID(f.client->nodes.register_node(Signer{W, nullptr}));
    CHECK(f.mock.calls.empty());
}

TEST(signer_bad_signature_or_exception_is_protocol_error) {
    for (const std::string& badsig : {"0x" + std::string(129, 'a'), "0x" + std::string(199, 'a'), "0x" + std::string(130, 'g'), std::string("nope")}) {
        Fixture f;
        RecSigner sg(W, badsig);
        f.mock.push(200, node_challenge(std::nullopt));
        CHECK_THROWS(f.client->nodes.register_node(sg.s), ProtocolError);
        CHECK_EQ(f.mock.calls.size(), std::size_t(1));
    }
    Fixture f;
    Signer thrower{W, [](const std::string&) -> std::string { throw std::runtime_error("hsm offline"); }};
    f.mock.push(200, node_challenge(std::nullopt));
    CHECK_THROWS(f.client->nodes.register_node(thrower), ProtocolError);
}

// ─── credits.withdraw ───────────────────────────────────────────────────────

namespace {
json withdraw_challenge(const std::string& amount, const std::string& key, const std::string& signer = "") {
    return {{"nonce", N},
            {"message", build_withdraw_message(USER, W, amount, key, N)},
            {"expiresAt", "t"},
            {"signer", signer.empty() ? to_lower(W) : signer}};
}
}  // namespace

TEST(withdraw_full_flow) {
    Fixture f;
    RecSigner sg;
    f.mock.push(200, withdraw_challenge("1234567", "dn-key_12345"));
    f.mock.push(200, {{"payout", {{"id", "p1"}, {"status", "pending"}}}, {"duplicate", false}});
    json r = f.client->credits.withdraw(1234567ULL, sg.s, std::string("dn-key_12345"));
    CHECK_EQ(Mock::body(f.mock.calls[0]), json({{"amountMusd", "1234567"}, {"idempotencyKey", "dn-key_12345"}}));
    CHECK_EQ(Mock::path(f.mock.calls[0]), std::string("/v1/credits/withdraw/challenge"));
    CHECK_EQ(*sg.signed_msgs, std::vector<std::string>{unhex(FX_WITHDRAW)});
    CHECK_EQ(Mock::path(f.mock.calls[1]), std::string("/v1/credits/withdraw"));
    CHECK_EQ(Mock::body(f.mock.calls[1]),
             json({{"amountMusd", "1234567"}, {"idempotencyKey", "dn-key_12345"}, {"nonce", N}, {"signature", SIG}}));
    CHECK_EQ(Mock::header(f.mock.calls[1], "Authorization"), "Bearer " + KEY);
    CHECK_EQ(r["idempotencyKey"], json("dn-key_12345"));
    CHECK_EQ(r["payout"]["id"], json("p1"));
}

TEST(withdraw_refusals) {
    {   // different amount in server message
        Fixture f;
        RecSigner sg;
        json ch = withdraw_challenge("1234567", "dn-key_12345");
        ch["message"] = build_withdraw_message(USER, W, "9999999", "dn-key_12345", N);
        f.mock.push(200, ch);
        CHECK_THROWS(f.client->credits.withdraw("1234567", sg.s, std::string("dn-key_12345")), ProtocolError);
        CHECK(sg.signed_msgs->empty());
        CHECK_EQ(f.mock.calls.size(), std::size_t(1));
    }
    {   // non-UUID user line
        Fixture f;
        RecSigner sg;
        json ch = withdraw_challenge("1234567", "dn-key_12345");
        std::string m = ch["message"];
        m.replace(m.find(USER), USER.size(), "root");
        ch["message"] = m;
        f.mock.push(200, ch);
        CHECK_THROWS(f.client->credits.withdraw("1234567", sg.s, std::string("dn-key_12345")), ProtocolError);
        CHECK(sg.signed_msgs->empty());
    }
    {   // server signer != signer.address
        Fixture f;
        RecSigner sg;
        f.mock.push(200, withdraw_challenge("1234567", "dn-key_12345", OLD));
        CHECK_THROWS(f.client->credits.withdraw("1234567", sg.s, std::string("dn-key_12345")), ProtocolError);
        CHECK(sg.signed_msgs->empty());
    }
    {   // bad nonce
        Fixture f;
        RecSigner sg;
        json ch = withdraw_challenge("1234567", "dn-key_12345");
        ch["nonce"] = "abc";
        f.mock.push(200, ch);
        CHECK_THROWS(f.client->credits.withdraw("1234567", sg.s, std::string("dn-key_12345")), ProtocolError);
    }
    {   // bad signature from signer
        Fixture f;
        RecSigner sg(W, "0x1234");
        f.mock.push(200, withdraw_challenge("1234567", "dn-key_12345"));
        CHECK_THROWS(f.client->credits.withdraw("1234567", sg.s, std::string("dn-key_12345")), ProtocolError);
        CHECK_EQ(f.mock.calls.size(), std::size_t(1));
    }
    Fixture f;
    RecSigner sg;
    CHECK_INVALID(f.client->credits.withdraw(999999LL, sg.s));
    CHECK_INVALID(f.client->credits.withdraw(100000000001ULL, sg.s));
    CHECK_INVALID(f.client->credits.withdraw("1000000", sg.s, std::string("bad key")));
    CHECK(f.mock.calls.empty());
}

// ─── payout_wallet.set ──────────────────────────────────────────────────────

namespace {
json payout_challenge(bool old_required = false, const std::string& old_addr = "") {
    json c = {{"nonce", N},
              {"message", build_payout_wallet_message(USER, W, NEW_ADDR, "base", N)},
              {"expiresAt", "t"},
              {"signer", W},
              {"oldWalletSignatureRequired", old_required},
              {"oldWalletAddress", old_addr.empty() ? json(nullptr) : json(old_addr)}};
    return c;
}
}  // namespace

TEST(payout_wallet_first_set) {
    Fixture f;
    RecSigner sg;
    f.mock.push(200, payout_challenge());
    f.mock.push(200, {{"payoutWallet", {{"address", to_lower(NEW_ADDR)}, {"chain", "base"}, {"status", "active"}}}, {"changed", false}, {"cooldownHours", 0}});
    json r = f.client->payout_wallet.set(NEW_ADDR, sg.s);
    CHECK_EQ(Mock::body(f.mock.calls[0]), json({{"address", to_lower(NEW_ADDR)}, {"chain", "base"}}));
    CHECK_EQ(*sg.signed_msgs, std::vector<std::string>{unhex(FX_PAYOUT)});
    CHECK_EQ(f.mock.calls[1].method, std::string("PUT"));
    CHECK_EQ(Mock::path(f.mock.calls[1]), std::string("/v1/payout-wallet"));
    CHECK_EQ(Mock::body(f.mock.calls[1]), json({{"address", to_lower(NEW_ADDR)}, {"chain", "base"}, {"nonce", N}, {"signature", SIG}}));
    CHECK_EQ(r["changed"], json(false));
}

TEST(payout_wallet_change_old_signer_signs_same_message) {
    Fixture f;
    RecSigner sg;
    std::string old_sig = "0x" + std::string(130, 'c');
    RecSigner old(OLD, old_sig);
    f.mock.push(200, payout_challenge(true, OLD));
    f.mock.push(200, {{"changed", true}, {"cooldownHours", 72}});
    f.client->payout_wallet.set(NEW_ADDR, sg.s, "base", old.s);
    CHECK_EQ(*sg.signed_msgs, std::vector<std::string>{unhex(FX_PAYOUT)});
    CHECK_EQ(*old.signed_msgs, std::vector<std::string>{unhex(FX_PAYOUT)});
    CHECK_EQ(Mock::body(f.mock.calls[1])["oldWalletSignature"], json(old_sig));
}

TEST(payout_wallet_refusals) {
    {   // old signer missing
        Fixture f;
        RecSigner sg;
        f.mock.push(200, payout_challenge(true, OLD));
        CHECK_INVALID(f.client->payout_wallet.set(NEW_ADDR, sg.s));
        CHECK(sg.signed_msgs->empty());
    }
    {   // old signer address mismatch
        Fixture f;
        RecSigner sg, other("0x8888888888888888888888888888888888888888");
        f.mock.push(200, payout_challenge(true, OLD));
        CHECK_INVALID(f.client->payout_wallet.set(NEW_ADDR, sg.s, "base", other.s));
        CHECK(sg.signed_msgs->empty() && other.signed_msgs->empty());
    }
    {   // message names a different payout address
        Fixture f;
        RecSigner sg;
        json ch = payout_challenge();
        ch["message"] = build_payout_wallet_message(USER, W, OLD, "base", N);
        f.mock.push(200, ch);
        CHECK_THROWS(f.client->payout_wallet.set(NEW_ADDR, sg.s), ProtocolError);
        CHECK(sg.signed_msgs->empty());
        CHECK_EQ(f.mock.calls.size(), std::size_t(1));
    }
    {   // server signer differs
        Fixture f;
        RecSigner sg;
        json ch = payout_challenge();
        ch["signer"] = OLD;
        f.mock.push(200, ch);
        CHECK_THROWS(f.client->payout_wallet.set(NEW_ADDR, sg.s), ProtocolError);
        CHECK(sg.signed_msgs->empty());
    }
    Fixture f;
    RecSigner sg;
    CHECK_INVALID(f.client->payout_wallet.set("0x12", sg.s));
    CHECK_INVALID(f.client->payout_wallet.set(NEW_ADDR, sg.s, "ethereum"));
    CHECK(f.mock.calls.empty());
}

// ─── wallet_auth.sign_in ────────────────────────────────────────────────────

TEST(wallet_sign_in_flow_and_refusal) {
    Fixture f(false);
    RecSigner sg;
    std::string msg = "Sign in to DominusNode\nAddress: " + to_lower(W) + "\nNonce: 1";
    f.mock.push(200, {{"message", msg}, {"nonce", "1"}, {"challenge", msg}, {"expiresAt", "t"}});
    f.mock.push(200, {{"token", JWT}, {"refreshToken", RT}, {"user", {{"id", "u"}}}});
    f.client->wallet_auth.sign_in(sg.s);
    CHECK_EQ(*sg.signed_msgs, std::vector<std::string>{msg});
    CHECK_EQ(Mock::body(f.mock.calls[1]), json({{"address", W}, {"signature", SIG}}));
    CHECK(f.client->is_connected());

    Fixture g(false);
    RecSigner sg2;
    g.mock.push(200, {{"message", "Sign in as " + OLD}, {"nonce", "1"}});
    CHECK_THROWS(g.client->wallet_auth.sign_in(sg2.s), ProtocolError);
    CHECK(sg2.signed_msgs->empty());
}
