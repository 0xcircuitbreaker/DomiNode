// Relay-network /v1 agent routes: nodes, credits, payouts, payoutWallet (signed flows).
#include "dominusnode/resources.hpp"
#include "dominusnode/errors.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <regex>

namespace dominusnode {

// ─── nodes ──────────────────────────────────────────────────────────────────

static OptStr norm_pubkey(const OptStr& v) {
    if (!v) return std::nullopt;
    std::string k = to_lower(*v);
    if (!is_hex64(k)) throw invalid_arg("nodePubkey must be 64 hex characters (32-byte ed25519 public key)");
    return k;
}

json NodesResource::register_challenge(const OptStr& node_pubkey) {
    OptStr k = norm_pubkey(node_pubkey);
    json body = json::object();
    if (k) body["nodePubkey"] = *k;
    return http_.post("/v1/nodes/challenge", body, AuthMode::Agent);
}

static void check_challenge(const json& ch) {
    if (!ch.is_object()) throw ProtocolError("invalid node challenge");
    if (!ch.contains("nonce") || !ch["nonce"].is_string() || !is_hex64(ch["nonce"].get<std::string>())) {
        throw ProtocolError("invalid challenge nonce");
    }
    if (!ch.contains("attestationText") || !ch["attestationText"].is_string() ||
        ch["attestationText"].get<std::string>().empty() || ch["attestationText"].get<std::string>().size() > 64 * 1024) {
        throw ProtocolError("invalid attestation text");
    }
    if (!ch.contains("attestationVersion") || !ch["attestationVersion"].is_number_integer() ||
        ch["attestationVersion"].get<long long>() < 1 || ch["attestationVersion"].get<long long>() > 100000) {
        throw ProtocolError("invalid attestation version");
    }
    if (!ch.contains("powChallenge") || !ch["powChallenge"].is_object()) throw ProtocolError("invalid PoW challenge");
    const json& p = ch["powChallenge"];
    if (!p.contains("prefix") || !p["prefix"].is_string() || !p.contains("difficulty") || !p["difficulty"].is_number() ||
        !p.contains("challengeId") || !p["challengeId"].is_string() || !is_uuid(p["challengeId"].get<std::string>())) {
        throw ProtocolError("invalid PoW challenge");
    }
    if (!ch.contains("message") || !ch["message"].is_string()) throw ProtocolError("invalid challenge message");
}

RegisteredNode NodesResource::register_node(const Signer& signer, const RegisterNodeOptions& opts) {
    assert_signer(signer);
    OptStr pubkey = norm_pubkey(opts.node_pubkey);
    if (opts.max_streams) validate_int_range(*opts.max_streams, "maxStreams", 1, 1024);
    if (opts.max_gb_day) validate_int_range(*opts.max_gb_day, "maxGbDay", 1, 10000);

    json ch = opts.challenge ? *opts.challenge : register_challenge(pubkey);
    check_challenge(ch);
    const std::string nonce = ch["nonce"].get<std::string>();
    const long long version = ch["attestationVersion"].get<long long>();
    std::string message = build_attestation_message(signer.address, nonce, version,
                                                    ch["attestationText"].get<std::string>(), pubkey);
    assert_same_message(ch["message"].get<std::string>(), message, "node attestation");

    const json& pow = ch["powChallenge"];
    double diff = pow["difficulty"].get<double>();
    if (std::floor(diff) != diff) throw ProtocolError("invalid PoW difficulty");
    std::string pow_nonce = solve_pow(pow["prefix"].get<std::string>(), static_cast<long long>(diff), opts.max_pow_iterations);
    std::string sig = sign_with(signer, message);

    json body = {{"nonce", nonce},
                 {"walletSignature", sig},
                 {"attestationVersion", version},
                 {"pow", {{"challengeId", pow["challengeId"]}, {"nonce", pow_nonce}}}};
    if (pubkey) body["nodePubkey"] = *pubkey;
    if (opts.max_streams) body["maxStreams"] = *opts.max_streams;
    if (opts.max_gb_day) body["maxGbDay"] = *opts.max_gb_day;

    json r = http_.post("/v1/nodes", body, AuthMode::Agent);
    static const std::regex node_key_re("^dn_node_[0-9a-f]{64}$");
    if (!r.contains("nodeId") || !r["nodeId"].is_string() || !is_uuid(r["nodeId"].get<std::string>())) {
        throw ProtocolError("invalid nodeId in response");
    }
    if (!r.contains("nodeKey") || !r["nodeKey"].is_string() || !std::regex_match(r["nodeKey"].get<std::string>(), node_key_re)) {
        throw ProtocolError("invalid node key in response");
    }
    RegisteredNode out;
    out.node_id = r["nodeId"].get<std::string>();
    out.status = r.contains("status") && r["status"].is_string() ? r["status"].get<std::string>() : "";
    out.attestation_version = r.contains("attestationVersion") && r["attestationVersion"].is_number_integer()
                                  ? r["attestationVersion"].get<long long>() : version;
    out.node_key = Secret(r["nodeKey"].get<std::string>());
    secure_zero_string(r["nodeKey"].get_ref<std::string&>());
    return out;
}

json NodesResource::list(OptInt limit, OptInt offset) {
    if (limit) validate_int_range(*limit, "limit", 1, 500);
    if (offset) validate_int_range(*offset, "offset", 0, 1000000);
    return http_.get("/v1/nodes" + Query().add("limit", limit).add("offset", offset).str(), AuthMode::Agent);
}

json NodesResource::revoke(const std::string& node_id) {
    return http_.del("/v1/nodes/" + url_encode(validate_uuid(node_id, "nodeId")), AuthMode::Agent);
}

json NodesResource::update_caps(const std::string& node_id, const NodeCaps& caps) {
    validate_uuid(node_id, "nodeId");
    json body = json::object();
    if (caps.max_streams) body["maxStreams"] = validate_int_range(*caps.max_streams, "maxStreams", 1, 1000000);
    if (caps.gb_per_day) body["gbPerDay"] = validate_int_range(*caps.gb_per_day, "gbPerDay", 1, 1000000);
    if (caps.req_per_sec) body["reqPerSec"] = validate_int_range(*caps.req_per_sec, "reqPerSec", 1, 1000000);
    if (body.empty()) throw invalid_arg("updateCaps needs at least one of maxStreams, gbPerDay, reqPerSec");
    return http_.patch("/v1/nodes/" + url_encode(node_id), body, AuthMode::Agent);
}

json NodesResource::tier() { return http_.get("/v1/node/tier", AuthMode::Agent); }

// ─── credits ────────────────────────────────────────────────────────────────

json CreditsResource::balance() { return http_.get("/v1/credits", AuthMode::Agent); }

json CreditsResource::transactions(OptInt limit, OptStr cursor, OptStr type) {
    if (limit) validate_int_range(*limit, "limit", 1, 200);
    static const std::regex cursor_re("^[0-9]{1,20}$");
    if (cursor && !std::regex_match(*cursor, cursor_re)) throw invalid_arg("cursor must be a nextCursor value");
    static const std::array<const char*, 6> types = {"earn", "mature", "clawback", "convert", "withdraw", "withdraw_reversal"};
    if (type && std::find(types.begin(), types.end(), *type) == types.end()) {
        throw invalid_arg("type must be one of earn, mature, clawback, convert, withdraw, withdraw_reversal");
    }
    return http_.get("/v1/credits/transactions" + Query().add("limit", limit).add("cursor", cursor).add("type", type).str(),
                     AuthMode::Agent);
}

json CreditsResource::convert(const MusdInput& amount_musd, OptStr idempotency_key) {
    std::string amount = amount_musd.normalize(MIN_CONVERT_MUSD, MAX_CONVERT_MUSD);
    std::string key = validate_idempotency_key(idempotency_key ? *idempotency_key : new_idempotency_key());
    json r = http_.post("/v1/credits/convert", {{"amountMusd", amount}}, AuthMode::Agent, {{"Idempotency-Key", key}});
    if (!r.is_object()) r = json::object();
    r["idempotencyKey"] = key;
    return r;
}

static void check_nonce_and_signer(const json& ch, const Signer& signer) {
    if (!ch.is_object() || !ch.contains("nonce") || !ch["nonce"].is_string() || !is_hex64(ch["nonce"].get<std::string>())) {
        throw ProtocolError("invalid challenge nonce");
    }
    if (!ch.contains("signer") || !ch["signer"].is_string() || to_lower(ch["signer"].get<std::string>()) != to_lower(signer.address)) {
        throw ProtocolError("the account's linked wallet is not the signer's address; refusing to sign");
    }
    if (!ch.contains("message") || !ch["message"].is_string()) throw ProtocolError("invalid challenge message");
}

json CreditsResource::withdraw(const MusdInput& amount_musd, const Signer& signer, OptStr idempotency_key) {
    assert_signer(signer);
    std::string amount = amount_musd.normalize(MIN_WITHDRAW_MUSD, MAX_WITHDRAW_MUSD);
    std::string key = validate_idempotency_key(idempotency_key ? *idempotency_key : new_idempotency_key());

    json ch = http_.post("/v1/credits/withdraw/challenge", {{"amountMusd", amount}, {"idempotencyKey", key}}, AuthMode::Agent);
    check_nonce_and_signer(ch, signer);
    const std::string server_msg = ch["message"].get<std::string>();
    const std::string nonce = ch["nonce"].get<std::string>();
    std::string local = build_withdraw_message(extract_user_id(server_msg), signer.address, amount, key, nonce);
    assert_same_message(server_msg, local, "withdrawal");
    std::string sig = sign_with(signer, local);
    json r = http_.post("/v1/credits/withdraw",
                        {{"amountMusd", amount}, {"idempotencyKey", key}, {"nonce", nonce}, {"signature", sig}},
                        AuthMode::Agent);
    if (!r.is_object()) r = json::object();
    r["idempotencyKey"] = key;
    return r;
}

json PayoutsResource::list(OptInt limit, OptInt offset) {
    if (limit) validate_int_range(*limit, "limit", 1, 200);
    if (offset) validate_int_range(*offset, "offset", 0, 1000000);
    return http_.get("/v1/payouts" + Query().add("limit", limit).add("offset", offset).str(), AuthMode::Agent);
}

// ─── payoutWallet ───────────────────────────────────────────────────────────

json PayoutWalletResource::get() { return http_.get("/v1/payout-wallet", AuthMode::Agent); }

json PayoutWalletResource::set(const std::string& address_in, const Signer& signer, const std::string& chain,
                               const std::optional<Signer>& old_signer) {
    assert_signer(signer);
    std::string address = to_lower(validate_address(address_in));
    if (chain != "base") throw invalid_arg("chain must be 'base'");
    if (old_signer) assert_signer(*old_signer, "oldWalletSigner");

    json ch = http_.post("/v1/payout-wallet/challenge", {{"address", address}, {"chain", chain}}, AuthMode::Agent);
    check_nonce_and_signer(ch, signer);
    const std::string server_msg = ch["message"].get<std::string>();
    const std::string nonce = ch["nonce"].get<std::string>();
    std::string local = build_payout_wallet_message(extract_user_id(server_msg), signer.address, address, chain, nonce);
    assert_same_message(server_msg, local, "payout wallet");

    bool old_required = ch.contains("oldWalletSignatureRequired") && ch["oldWalletSignatureRequired"] == true;
    if (old_required) {
        std::string old_addr = ch.contains("oldWalletAddress") && ch["oldWalletAddress"].is_string()
                                   ? ch["oldWalletAddress"].get<std::string>() : "";
        if (!old_signer) throw invalid_arg("changing the payout wallet requires oldWalletSigner for " + old_addr);
        if (old_addr.empty() || to_lower(old_addr) != to_lower(old_signer->address)) {
            throw invalid_arg("oldWalletSigner.address is not the current payout wallet");
        }
    }
    std::string sig = sign_with(signer, local);
    json body = {{"address", address}, {"chain", chain}, {"nonce", nonce}, {"signature", sig}};
    if (old_required) body["oldWalletSignature"] = sign_with(*old_signer, local, "oldWalletSigner");
    return http_.put("/v1/payout-wallet", body, AuthMode::Agent);
}

}  // namespace dominusnode
