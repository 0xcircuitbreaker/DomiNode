#pragma once

#include "dominusnode/types.hpp"
#include <optional>

namespace dominusnode {

class HttpClient;

/// Wallet and billing resource.
class WalletResource {
public:
    explicit WalletResource(HttpClient& http);

    /// Get current wallet balance.
    WalletBalance get_balance();

    /// Get wallet transaction history.
    TransactionsResult get_transactions(std::optional<int> limit = std::nullopt,
                                        std::optional<int> offset = std::nullopt);

    /// Create a Stripe checkout session for wallet top-up.
    StripeCheckoutResult top_up_stripe(int amount_cents);

    /// Create a crypto invoice for wallet top-up.
    CryptoInvoiceResult top_up_crypto(int amount_cents, const std::string& currency);

    /// Create a PayPal order for wallet top-up.
    PaypalOrderResult top_up_paypal(int amount_cents);

    /// Get spending forecast based on recent usage.
    WalletForecast get_forecast();

private:
    HttpClient& http_;
};

} // namespace dominusnode
