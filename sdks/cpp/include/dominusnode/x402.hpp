#pragma once

#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace dominusnode {

class HttpClient;

// ─── Types ──────────────────────────────────────────────────────────────

struct X402Facilitator {
    std::string address;
    std::string chain;
    std::string network;
};

inline void from_json(const nlohmann::json& j, X402Facilitator& f) {
    j.at("address").get_to(f.address);
    j.at("chain").get_to(f.chain);
    j.at("network").get_to(f.network);
}

struct X402Pricing {
    int per_request_cents = 0;
    int per_gb_cents = 0;
    std::string currency;
};

inline void from_json(const nlohmann::json& j, X402Pricing& p) {
    p.per_request_cents = j.value("perRequestCents", 0);
    p.per_gb_cents = j.value("perGbCents", 0);
    p.currency = j.value("currency", "");
}

struct X402Info {
    bool supported = false;
    bool enabled = false;
    std::string protocol;
    std::string version;
    std::vector<X402Facilitator> facilitators;
    X402Pricing pricing;
    std::vector<std::string> currencies;
    std::string wallet_type;
    bool agentic_wallets = false;
};

inline void from_json(const nlohmann::json& j, X402Info& info) {
    info.supported = j.value("supported", false);
    info.enabled = j.value("enabled", false);
    info.protocol = j.value("protocol", "");
    info.version = j.value("version", "");
    if (j.contains("facilitators") && j["facilitators"].is_array()) {
        j.at("facilitators").get_to(info.facilitators);
    }
    if (j.contains("pricing") && j["pricing"].is_object()) {
        j.at("pricing").get_to(info.pricing);
    }
    if (j.contains("currencies") && j["currencies"].is_array()) {
        j.at("currencies").get_to(info.currencies);
    }
    info.wallet_type = j.value("walletType", "");
    info.agentic_wallets = j.value("agenticWallets", false);
}

// ─── Resource ───────────────────────────────────────────────────────────

class X402Resource {
public:
    explicit X402Resource(HttpClient& http);

    /// Get x402 protocol information (no auth required).
    X402Info get_info();

private:
    HttpClient& http_;
};

} // namespace dominusnode
