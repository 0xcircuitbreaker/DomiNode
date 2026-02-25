#pragma once

#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace dominusnode {

class HttpClient;

// ─── Types ──────────────────────────────────────────────────────────────

struct AgenticWallet {
    std::string id;
    std::string label;
    int balance_cents = 0;
    int spending_limit_cents = 0;
    int daily_limit_cents = -1;           // -1 means not set / null
    std::vector<std::string> allowed_domains;
    std::string status;
    std::string created_at;
};

inline void from_json(const nlohmann::json& j, AgenticWallet& w) {
    j.at("id").get_to(w.id);
    j.at("label").get_to(w.label);
    w.balance_cents = j.value("balanceCents", 0);
    w.spending_limit_cents = j.value("spendingLimitCents", 0);
    w.daily_limit_cents = j.contains("dailyLimitCents") && !j["dailyLimitCents"].is_null()
        ? j["dailyLimitCents"].get<int>() : -1;
    if (j.contains("allowedDomains") && j["allowedDomains"].is_array()) {
        j["allowedDomains"].get_to(w.allowed_domains);
    }
    w.status = j.value("status", "");
    w.created_at = j.value("createdAt", "");
}

struct AgenticWalletTransaction {
    std::string id;
    std::string wallet_id;
    std::string type;
    int amount_cents = 0;
    std::string description;
    std::string session_id;
    std::string created_at;
};

inline void from_json(const nlohmann::json& j, AgenticWalletTransaction& t) {
    j.at("id").get_to(t.id);
    t.wallet_id = j.value("walletId", "");
    j.at("type").get_to(t.type);
    t.amount_cents = j.value("amountCents", 0);
    t.description = j.value("description", "");
    t.session_id = j.value("sessionId", "");
    t.created_at = j.value("createdAt", "");
}

struct AgenticWalletListResponse {
    std::vector<AgenticWallet> wallets;
};

inline void from_json(const nlohmann::json& j, AgenticWalletListResponse& r) {
    j.at("wallets").get_to(r.wallets);
}

struct AgenticWalletFundResponse {
    AgenticWalletTransaction transaction;
};

inline void from_json(const nlohmann::json& j, AgenticWalletFundResponse& r) {
    j.at("transaction").get_to(r.transaction);
}

struct AgenticWalletTransactionsResponse {
    std::vector<AgenticWalletTransaction> transactions;
};

inline void from_json(const nlohmann::json& j, AgenticWalletTransactionsResponse& r) {
    j.at("transactions").get_to(r.transactions);
}

struct AgenticWalletDeleteResponse {
    bool deleted = false;
    int refunded_cents = 0;
};

inline void from_json(const nlohmann::json& j, AgenticWalletDeleteResponse& r) {
    r.deleted = j.value("deleted", false);
    r.refunded_cents = j.value("refundedCents", 0);
}

// ─── Resource ───────────────────────────────────────────────────────────

class AgenticWalletResource {
public:
    explicit AgenticWalletResource(HttpClient& http);

    AgenticWallet create(const std::string& label, int spending_limit_cents = 10000,
                         int daily_limit_cents = -1,
                         const std::vector<std::string>& allowed_domains = {});
    AgenticWalletListResponse list();
    AgenticWallet get(const std::string& wallet_id);
    AgenticWalletFundResponse fund(const std::string& wallet_id, int amount_cents);
    AgenticWalletTransactionsResponse transactions(
        const std::string& wallet_id, int limit = 50, int offset = 0);
    AgenticWallet freeze(const std::string& wallet_id);
    AgenticWallet unfreeze(const std::string& wallet_id);
    AgenticWalletDeleteResponse delete_wallet(const std::string& wallet_id);
    AgenticWallet update_wallet_policy(const std::string& wallet_id,
                                       int daily_limit_cents,
                                       const std::vector<std::string>& allowed_domains);

private:
    HttpClient& http_;
};

} // namespace dominusnode
