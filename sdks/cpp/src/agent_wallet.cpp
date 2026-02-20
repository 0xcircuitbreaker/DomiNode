#include "dominusnode/agent_wallet.hpp"
#include "dominusnode/http_client.hpp"

#include <sstream>
#include <iomanip>
#include <cctype>
#include <stdexcept>

namespace dominusnode {

static void validate_amount_cents(int amount_cents, const char* name = "amountCents") {
    if (amount_cents <= 0 || amount_cents > 2147483647) {
        throw std::invalid_argument(std::string(name) + " must be a positive integer <= 2,147,483,647");
    }
}

// R33 H-5: Percent-encode a URI path segment to prevent path injection.
static std::string url_encode(const std::string& value) {
    std::ostringstream encoded;
    encoded.fill('0');
    encoded << std::hex;
    for (unsigned char c : value) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            encoded << c;
        } else {
            encoded << '%' << std::uppercase << std::setw(2) << static_cast<int>(c);
        }
    }
    return encoded.str();
}

AgenticWalletResource::AgenticWalletResource(HttpClient& http) : http_(http) {}

AgenticWallet AgenticWalletResource::create(const std::string& label, int spending_limit_cents) {
    validate_amount_cents(spending_limit_cents, "spendingLimitCents");
    nlohmann::json body = {
        {"label", label},
        {"spendingLimitCents", spending_limit_cents},
    };
    auto resp = http_.post("/api/agent-wallet", body);
    return resp.get<AgenticWallet>();
}

AgenticWalletListResponse AgenticWalletResource::list() {
    auto resp = http_.get("/api/agent-wallet");
    return resp.get<AgenticWalletListResponse>();
}

AgenticWallet AgenticWalletResource::get(const std::string& wallet_id) {
    auto resp = http_.get("/api/agent-wallet/" + url_encode(wallet_id));
    return resp.get<AgenticWallet>();
}

AgenticWalletFundResponse AgenticWalletResource::fund(const std::string& wallet_id, int amount_cents) {
    validate_amount_cents(amount_cents);
    nlohmann::json body = {{"amountCents", amount_cents}};
    auto resp = http_.post("/api/agent-wallet/" + url_encode(wallet_id) + "/fund", body);
    return resp.get<AgenticWalletFundResponse>();
}

AgenticWalletTransactionsResponse AgenticWalletResource::transactions(
    const std::string& wallet_id, int limit, int offset) {
    std::ostringstream path;
    path << "/api/agent-wallet/" << url_encode(wallet_id)
         << "/transactions?limit=" << limit << "&offset=" << offset;
    auto resp = http_.get(path.str());
    return resp.get<AgenticWalletTransactionsResponse>();
}

AgenticWallet AgenticWalletResource::freeze(const std::string& wallet_id) {
    nlohmann::json body = nlohmann::json::object();
    auto resp = http_.post("/api/agent-wallet/" + url_encode(wallet_id) + "/freeze", body);
    return resp.get<AgenticWallet>();
}

AgenticWallet AgenticWalletResource::unfreeze(const std::string& wallet_id) {
    nlohmann::json body = nlohmann::json::object();
    auto resp = http_.post("/api/agent-wallet/" + url_encode(wallet_id) + "/unfreeze", body);
    return resp.get<AgenticWallet>();
}

AgenticWalletDeleteResponse AgenticWalletResource::delete_wallet(const std::string& wallet_id) {
    auto resp = http_.del("/api/agent-wallet/" + url_encode(wallet_id));
    return resp.get<AgenticWalletDeleteResponse>();
}

} // namespace dominusnode
