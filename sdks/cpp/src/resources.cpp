// auth, walletAuth, keys, wallet, agenticWallets, teams, usage, sessions, x402, network.
#include "dominusnode/resources.hpp"
#include "dominusnode/errors.hpp"

#include <algorithm>
#include <array>

namespace dominusnode {

namespace {
std::string str_field(const json& j, const char* k) {
    if (j.is_object() && j.contains(k) && !j[k].is_null()) return j[k].is_string() ? j[k].get<std::string>() : j[k].dump();
    return "";
}
}  // namespace

// ─── auth ───────────────────────────────────────────────────────────────────

json AuthResource::verify_key(const std::string& api_key) {
    return http_.post("/api/auth/verify-key", {{"apiKey", validate_api_key(api_key)}}, AuthMode::None);
}
json AuthResource::refresh(const std::string& refresh_token) {
    if (refresh_token.empty()) throw invalid_arg("refreshToken is required");
    return http_.post("/api/auth/refresh", {{"refreshToken", refresh_token}}, AuthMode::None);
}
void AuthResource::logout() { http_.post("/api/auth/logout", json::object(), AuthMode::Jwt); }
json AuthResource::me() { return http_.get("/api/auth/me", AuthMode::Jwt); }

// ─── walletAuth ─────────────────────────────────────────────────────────────

json WalletAuthResource::challenge(const std::string& address) {
    return http_.post("/api/auth/wallet/challenge", {{"address", validate_address(address)}}, AuthMode::None);
}

json WalletAuthResource::verify(const std::string& address, const std::string& signature) {
    json body = {{"address", validate_address(address)}, {"signature", validate_signature(signature)}};
    json r = http_.post("/api/auth/wallet/verify", body, AuthMode::None);
    if (r.contains("mfaRequired") && r["mfaRequired"] == true) {
        return {{"mfaRequired", true}, {"mfaChallengeToken", r.value("mfaChallengeToken", json())}};
    }
    if (r.contains("token") && r["token"].is_string() && r.contains("refreshToken") && r["refreshToken"].is_string()) {
        tokens_.set_tokens(r["token"].get<std::string>(), r["refreshToken"].get<std::string>());
    }
    return r;
}

json WalletAuthResource::sign_in(const Signer& signer) {
    assert_signer(signer);
    json ch = challenge(signer.address);
    if (!ch.contains("message") || !ch["message"].is_string() ||
        to_lower(ch["message"].get<std::string>()).find(to_lower(signer.address)) == std::string::npos) {
        throw ProtocolError("wallet challenge does not name the signer's address; refusing to sign");
    }
    std::string sig = sign_with(signer, ch["message"].get<std::string>());
    return verify(signer.address, sig);
}

json WalletAuthResource::link(const std::string& address, const std::string& signature) {
    return http_.post("/api/auth/wallet/link",
                      {{"address", validate_address(address)}, {"signature", validate_signature(signature)}});
}

// ─── keys ───────────────────────────────────────────────────────────────────

CreatedApiKey KeysResource::create(const std::string& label) {
    validate_non_empty(label, "label", 100);
    json r = http_.post("/api/keys", {{"label", label}});
    CreatedApiKey k{str_field(r, "id"), str_field(r, "prefix"), str_field(r, "label"), str_field(r, "created_at"),
                    Secret(str_field(r, "key"))};
    if (r.contains("key") && r["key"].is_string()) {
        std::string& raw = r["key"].get_ref<std::string&>();
        secure_zero_string(raw);
    }
    return k;
}
json KeysResource::list() { return http_.get("/api/keys"); }
void KeysResource::revoke(const std::string& id) { http_.del("/api/keys/" + url_encode(validate_non_empty(id, "id"))); }

// ─── wallet ─────────────────────────────────────────────────────────────────

json WalletResource::get() { return http_.get("/v1/wallet", AuthMode::Agent); }
json WalletResource::get_balance() { return http_.get("/api/wallet"); }
json WalletResource::get_transactions(OptInt limit, OptInt offset) {
    return http_.get("/api/wallet/transactions" + Query().add("limit", limit).add("offset", offset).str());
}
json WalletResource::get_forecast() { return http_.get("/api/wallet/forecast"); }
json WalletResource::top_up_crypto(std::int64_t amount_cents, const std::string& currency) {
    validate_cents(amount_cents);
    if (amount_cents < 1000 || amount_cents > 100000) {
        throw invalid_arg("crypto top-up must be between 1000 and 100000 cents ($10-$1,000)");
    }
    static const std::array<const char*, 11> currencies = {"btc", "eth", "ltc", "xmr", "zec", "usdc",
                                                           "sol", "usdt", "dai", "bnb", "link"};
    std::string c = to_lower(currency);
    if (std::find(currencies.begin(), currencies.end(), c) == currencies.end()) {
        throw invalid_arg("currency must be one of btc, eth, ltc, xmr, zec, usdc, sol, usdt, dai, bnb, link");
    }
    return http_.post("/api/wallet/topup/crypto",
                      {{"amountUsd", static_cast<double>(amount_cents) / 100.0}, {"currency", c}});
}
json WalletResource::get_crypto_status(const std::string& invoice_id) {
    return http_.get("/api/wallet/crypto/status/" + url_encode(validate_uuid(invoice_id, "invoiceId")));
}

// ─── agenticWallets ─────────────────────────────────────────────────────────

static std::string aw(const std::string& id) { return "/api/agent-wallet/" + url_encode(id); }

json AgenticWalletResource::create(const std::string& label, std::int64_t spending_limit_cents,
                                   std::optional<std::int64_t> daily_limit_cents,
                                   std::optional<std::vector<std::string>> allowed_domains) {
    validate_cents(spending_limit_cents, "spendingLimitCents", true);
    if (daily_limit_cents) validate_cents(*daily_limit_cents, "dailyLimitCents", true);
    json body = {{"label", label}, {"spendingLimitCents", spending_limit_cents}};
    if (daily_limit_cents) body["dailyLimitCents"] = *daily_limit_cents;
    if (allowed_domains) body["allowedDomains"] = *allowed_domains;
    return http_.post("/api/agent-wallet", body);
}
json AgenticWalletResource::list() { return http_.get("/api/agent-wallet"); }
json AgenticWalletResource::get(const std::string& id) { return http_.get(aw(id)); }
json AgenticWalletResource::fund(const std::string& id, std::int64_t amount_cents) {
    validate_cents(amount_cents);
    return http_.post(aw(id) + "/fund", {{"amountCents", amount_cents}});
}
json AgenticWalletResource::update_wallet_policy(const std::string& id, const WalletPolicy& p) {
    json body = json::object();
    if (p.daily_limit_cents) body["dailyLimitCents"] = validate_cents(*p.daily_limit_cents, "dailyLimitCents", true);
    else if (p.clear_daily_limit) body["dailyLimitCents"] = nullptr;
    if (p.allowed_domains) body["allowedDomains"] = *p.allowed_domains;
    else if (p.clear_allowed_domains) body["allowedDomains"] = nullptr;
    return http_.patch(aw(id) + "/policy", body);
}
json AgenticWalletResource::transactions(const std::string& id, OptInt limit, OptInt offset) {
    return http_.get(aw(id) + "/transactions" + Query().add("limit", limit).add("offset", offset).str());
}
json AgenticWalletResource::freeze(const std::string& id) { return http_.post(aw(id) + "/freeze", json::object()); }
json AgenticWalletResource::unfreeze(const std::string& id) { return http_.post(aw(id) + "/unfreeze", json::object()); }
json AgenticWalletResource::delete_wallet(const std::string& id) { return http_.del(aw(id)); }

// ─── teams ──────────────────────────────────────────────────────────────────

static std::string tm(const std::string& id) { return "/api/teams/" + url_encode(id); }

json TeamsResource::create(const std::string& name, OptInt max_members) {
    json body = {{"name", name}};
    if (max_members) body["maxMembers"] = *max_members;
    return http_.post("/api/teams", body);
}
json TeamsResource::list() { return http_.get("/api/teams"); }
json TeamsResource::get(const std::string& t) { return http_.get(tm(t)); }
json TeamsResource::update(const std::string& t, OptStr name, OptInt max_members) {
    json body = json::object();
    if (name) body["name"] = *name;
    if (max_members) body["maxMembers"] = *max_members;
    return http_.patch(tm(t), body);
}
json TeamsResource::delete_team(const std::string& t) { return http_.del(tm(t)); }
json TeamsResource::fund_wallet(const std::string& t, std::int64_t amount_cents) {
    validate_cents(amount_cents);
    return http_.post(tm(t) + "/wallet/fund", {{"amountCents", amount_cents}});
}
json TeamsResource::get_transactions(const std::string& t, OptInt limit, OptInt offset) {
    return http_.get(tm(t) + "/wallet/transactions" + Query().add("limit", limit).add("offset", offset).str());
}
json TeamsResource::list_members(const std::string& t) { return http_.get(tm(t) + "/members"); }
json TeamsResource::add_member(const std::string& t, const std::string& email, OptStr role) {
    json body = {{"email", email}};
    if (role) body["role"] = *role;
    return http_.post(tm(t) + "/members", body);
}
json TeamsResource::update_member_role(const std::string& t, const std::string& user_id, const std::string& role) {
    return http_.patch(tm(t) + "/members/" + url_encode(user_id), {{"role", role}});
}
void TeamsResource::remove_member(const std::string& t, const std::string& user_id) {
    http_.del(tm(t) + "/members/" + url_encode(user_id));
}
json TeamsResource::create_invite(const std::string& t, const std::string& email, OptStr role) {
    json body = {{"email", email}};
    if (role) body["role"] = *role;
    return http_.post(tm(t) + "/invites", body);
}
json TeamsResource::list_invites(const std::string& t) { return http_.get(tm(t) + "/invites"); }
void TeamsResource::cancel_invite(const std::string& t, const std::string& invite_id) {
    http_.del(tm(t) + "/invites/" + url_encode(invite_id));
}
json TeamsResource::accept_invite(const std::string& token) {
    return http_.post("/api/teams/invites/" + url_encode(token) + "/accept", json::object());
}
TeamKeyCreateResponse TeamsResource::create_key(const std::string& t, const std::string& label) {
    validate_non_empty(label, "label", 100);
    json r = http_.post(tm(t) + "/keys", {{"label", label}});
    std::string prefix = r.contains("prefix") && r["prefix"].is_string() ? str_field(r, "prefix") : str_field(r, "keyPrefix");
    TeamKeyCreateResponse k{str_field(r, "id"), prefix, str_field(r, "label"), Secret(str_field(r, "key")), prefix,
                            str_field(r, "createdAt")};
    if (r.contains("key") && r["key"].is_string()) secure_zero_string(r["key"].get_ref<std::string&>());
    return k;
}
json TeamsResource::list_keys(const std::string& t) {
    json r = http_.get(tm(t) + "/keys");
    if (r.is_object() && r.contains("keys") && r["keys"].is_array()) {
        for (auto& k : r["keys"]) {
            if (k.is_object() && !(k.contains("prefix") && k["prefix"].is_string()) && k.contains("keyPrefix") && k["keyPrefix"].is_string())
                k["prefix"] = k["keyPrefix"];
        }
    }
    return r;
}
void TeamsResource::revoke_key(const std::string& t, const std::string& key_id) {
    http_.del(tm(t) + "/keys/" + url_encode(key_id));
}

// ─── usage ──────────────────────────────────────────────────────────────────

json UsageResource::get(OptStr from, OptStr to, OptInt limit, OptInt offset) {
    return http_.get("/api/usage" + Query().add("since", from).add("until", to).add("limit", limit).add("offset", offset).str());
}
json UsageResource::get_daily(OptStr from, OptStr to) {
    return http_.get("/api/usage/daily" + Query().add("since", from).add("until", to).str());
}
json UsageResource::get_top_hosts(OptStr from, OptStr to, OptInt limit) {
    return http_.get("/api/usage/top-hosts" + Query().add("since", from).add("until", to).add("limit", limit).str());
}
std::string UsageResource::export_csv(OptStr from, OptStr to) {
    return http_.request_raw("GET", "/api/usage/export" + Query().add("since", from).add("until", to).str(),
                             std::nullopt, AuthMode::Jwt);
}

// ─── sessions ───────────────────────────────────────────────────────────────

ActiveSessions SessionsResource::get_active() {
    json r = http_.get("/api/sessions/active");
    ActiveSessions out;
    if (r.contains("sessions") && r["sessions"].is_array()) {
        // Whitelist fields: never surface an IP even if a server regression sends one.
        for (const auto& s : r["sessions"]) {
            out.sessions.push_back({str_field(s, "id"), str_field(s, "startedAt"), str_field(s, "status")});
        }
    }
    return out;
}

json SessionsResource::report(const std::string& session_id, const std::string& reason) {
    validate_uuid(session_id, "sessionId");
    static const std::array<const char*, 6> reasons = {"blocked", "captcha", "rate_limited", "slow", "bad_content", "other"};
    if (std::find(reasons.begin(), reasons.end(), reason) == reasons.end()) {
        throw invalid_arg("reason must be one of blocked, captcha, rate_limited, slow, bad_content, other");
    }
    return http_.post("/v1/sessions/" + url_encode(session_id) + "/report", {{"reason", reason}}, AuthMode::Agent);
}

// ─── x402 / network ─────────────────────────────────────────────────────────

json X402Resource::get_info() { return http_.get("/api/x402/info", AuthMode::None); }
json NetworkResource::policy() { return http_.get("/v1/policy", AuthMode::None); }
json NetworkResource::pricing() { return http_.get("/v1/pricing", AuthMode::None); }
json NetworkResource::stats() { return http_.get("/v1/network/stats", AuthMode::None); }
json NetworkResource::status() { return http_.get("/v1/status", AuthMode::None); }

}  // namespace dominusnode
