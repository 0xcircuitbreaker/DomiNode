package io.dominode.sdk.resources;

import io.dominode.sdk.errors.DomiNodeException;
import io.dominode.sdk.internal.HttpClient;
import io.dominode.sdk.internal.JsonUtil;
import io.dominode.sdk.types.CryptoInvoice;
import io.dominode.sdk.types.StripeCheckout;
import io.dominode.sdk.types.Wallet;
import io.dominode.sdk.types.WalletForecast;
import io.dominode.sdk.types.WalletTransaction;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Wallet operations: balance inquiry, transaction history, and top-up.
 */
public final class WalletResource {

    private final HttpClient http;

    /**
     * @param http the HTTP client
     */
    public WalletResource(HttpClient http) {
        this.http = http;
    }

    /**
     * Get the current wallet balance.
     *
     * @return wallet balance information
     * @throws DomiNodeException on API errors
     */
    public Wallet getBalance() throws DomiNodeException {
        return http.get("/api/wallet", Wallet.class);
    }

    /**
     * Get wallet transaction history with default pagination.
     *
     * @return list of transactions
     * @throws DomiNodeException on API errors
     */
    public List<WalletTransaction> getTransactions() throws DomiNodeException {
        return getTransactions(-1, -1);
    }

    /**
     * Get wallet transaction history with pagination.
     *
     * @param limit  maximum number of transactions to return (pass -1 to use server default)
     * @param offset number of transactions to skip (pass -1 to use server default)
     * @return list of transactions
     * @throws DomiNodeException on API errors
     */
    public List<WalletTransaction> getTransactions(int limit, int offset) throws DomiNodeException {
        StringBuilder path = new StringBuilder("/api/wallet/transactions");
        String sep = "?";
        if (limit >= 0) {
            path.append(sep).append("limit=").append(limit);
            sep = "&";
        }
        if (offset >= 0) {
            path.append(sep).append("offset=").append(offset);
        }
        // Server returns { transactions: [...] }
        Map<?, ?> raw = http.get(path.toString(), Map.class);
        String json = JsonUtil.toJson(raw.get("transactions"));
        WalletTransaction[] txns = JsonUtil.fromJson(json, WalletTransaction[].class);
        return Arrays.asList(txns);
    }

    /**
     * Create a Stripe checkout session for wallet top-up.
     *
     * @param amountCents the amount in cents to top up
     * @return Stripe checkout session with redirect URL
     * @throws DomiNodeException on API errors
     */
    public StripeCheckout topupStripe(int amountCents) throws DomiNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("amountCents", amountCents);
        return http.post("/api/wallet/topup/stripe", body, StripeCheckout.class);
    }

    /**
     * Create a crypto invoice for wallet top-up via NOWPayments.
     *
     * @param amountUsd the amount in USD
     * @param currency  the cryptocurrency code (e.g., "btc", "eth", "xmr", "sol", "zec")
     * @return crypto invoice with payment URL
     * @throws DomiNodeException on API errors
     */
    public CryptoInvoice topupCrypto(double amountUsd, String currency) throws DomiNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("amountUsd", amountUsd);
        body.put("currency", currency);
        return http.post("/api/wallet/topup/crypto", body, CryptoInvoice.class);
    }

    /**
     * Get spending forecast based on recent usage patterns.
     *
     * @return wallet forecast with estimated days remaining
     * @throws DomiNodeException on API errors
     */
    public WalletForecast getForecast() throws DomiNodeException {
        return http.get("/api/wallet/forecast", WalletForecast.class);
    }
}
