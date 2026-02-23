#include "dominusnode/wallet.hpp"
#include "dominusnode/http_client.hpp"

#include <sstream>
#include <stdexcept>

namespace dominusnode {

static void validate_amount_cents(int amount_cents, const char* name = "amountCents") {
    if (amount_cents <= 0 || amount_cents > 2147483647) {
        throw std::invalid_argument(std::string(name) + " must be a positive integer <= 2,147,483,647");
    }
}

WalletResource::WalletResource(HttpClient& http) : http_(http) {}

WalletBalance WalletResource::get_balance() {
    auto resp = http_.get("/api/wallet");
    return resp.get<WalletBalance>();
}

TransactionsResult WalletResource::get_transactions(std::optional<int> limit,
                                                     std::optional<int> offset) {
    std::ostringstream path;
    path << "/api/wallet/transactions";

    bool has_param = false;
    auto append = [&](const std::string& key, int value) {
        path << (has_param ? '&' : '?') << key << '=' << value;
        has_param = true;
    };

    if (limit.has_value()) append("limit", *limit);
    if (offset.has_value()) append("offset", *offset);

    auto resp = http_.get(path.str());
    return resp.get<TransactionsResult>();
}

StripeCheckoutResult WalletResource::top_up_stripe(int amount_cents) {
    validate_amount_cents(amount_cents);
    nlohmann::json body = {{"amountCents", amount_cents}};
    auto resp = http_.post("/api/wallet/topup/stripe", body);
    return resp.get<StripeCheckoutResult>();
}

CryptoInvoiceResult WalletResource::top_up_crypto(int amount_cents, const std::string& currency) {
    validate_amount_cents(amount_cents);
    if (amount_cents < 1000) {
        throw std::invalid_argument("Minimum crypto top-up is $10.00 (1000 cents) — NOWPayments requirement");
    }
    double amount_usd = amount_cents / 100.0;
    nlohmann::json body = {{"amountUsd", amount_usd}, {"currency", currency}};
    auto resp = http_.post("/api/wallet/topup/crypto", body);
    return resp.get<CryptoInvoiceResult>();
}

WalletForecast WalletResource::get_forecast() {
    auto resp = http_.get("/api/wallet/forecast");
    return resp.get<WalletForecast>();
}

} // namespace dominusnode
