package io.dominusnode.sdk.resources;

import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.internal.HttpClient;
import io.dominusnode.sdk.types.AgenticWallet;
import io.dominusnode.sdk.types.AgenticWalletDeleteResponse;
import io.dominusnode.sdk.types.AgenticWalletFundResponse;
import io.dominusnode.sdk.types.AgenticWalletListResponse;
import io.dominusnode.sdk.types.AgenticWalletTransactionsResponse;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Agentic wallet operations — server-side custodial sub-wallets with spending limits.
 */
public final class AgenticWalletResource {

    private final HttpClient http;

    public AgenticWalletResource(HttpClient http) {
        this.http = http;
    }

    /**
     * Create a new agentic wallet.
     *
     * @param label              label for the wallet (1-100 chars)
     * @param spendingLimitCents maximum spend per transaction in cents (0 = no limit)
     * @return the created wallet
     * @throws DominusNodeException on API errors
     */
    public AgenticWallet create(String label, int spendingLimitCents) throws DominusNodeException {
        WalletResource.validateAmountCents(spendingLimitCents);
        return http.post("/api/agent-wallet",
                Map.of("label", label, "spendingLimitCents", spendingLimitCents),
                AgenticWallet.class);
    }

    /**
     * List all agentic wallets for the authenticated user.
     *
     * @return list of wallets
     * @throws DominusNodeException on API errors
     */
    public AgenticWalletListResponse list() throws DominusNodeException {
        return http.get("/api/agent-wallet", AgenticWalletListResponse.class);
    }

    /**
     * Get a single agentic wallet by ID.
     *
     * @param walletId the wallet UUID
     * @return the wallet
     * @throws DominusNodeException on API errors
     */
    public AgenticWallet get(String walletId) throws DominusNodeException {
        return http.get("/api/agent-wallet/" + URLEncoder.encode(walletId, StandardCharsets.UTF_8), AgenticWallet.class);
    }

    /**
     * Fund an agentic wallet from the main wallet.
     *
     * @param walletId    the wallet UUID
     * @param amountCents amount in cents to transfer (min 100, max 1000000)
     * @return the fund transaction
     * @throws DominusNodeException on API errors
     */
    public AgenticWalletFundResponse fund(String walletId, int amountCents) throws DominusNodeException {
        WalletResource.validateAmountCents(amountCents);
        return http.post("/api/agent-wallet/" + URLEncoder.encode(walletId, StandardCharsets.UTF_8) + "/fund",
                Map.of("amountCents", amountCents),
                AgenticWalletFundResponse.class);
    }

    /**
     * Get transaction history for an agentic wallet.
     *
     * @param walletId the wallet UUID
     * @param limit    max number of transactions to return
     * @param offset   pagination offset
     * @return transaction history
     * @throws DominusNodeException on API errors
     */
    public AgenticWalletTransactionsResponse transactions(String walletId, int limit, int offset)
            throws DominusNodeException {
        return http.get("/api/agent-wallet/" + URLEncoder.encode(walletId, StandardCharsets.UTF_8) + "/transactions?limit=" + limit + "&offset=" + offset,
                AgenticWalletTransactionsResponse.class);
    }

    /**
     * Freeze an agentic wallet.
     *
     * @param walletId the wallet UUID
     * @return the frozen wallet
     * @throws DominusNodeException on API errors
     */
    public AgenticWallet freeze(String walletId) throws DominusNodeException {
        return http.post("/api/agent-wallet/" + URLEncoder.encode(walletId, StandardCharsets.UTF_8) + "/freeze",
                Map.of(), AgenticWallet.class);
    }

    /**
     * Unfreeze an agentic wallet, allowing spending again.
     *
     * @param walletId the wallet UUID
     * @return the unfrozen wallet
     * @throws DominusNodeException on API errors
     */
    public AgenticWallet unfreeze(String walletId) throws DominusNodeException {
        return http.post("/api/agent-wallet/" + URLEncoder.encode(walletId, StandardCharsets.UTF_8) + "/unfreeze",
                Map.of(), AgenticWallet.class);
    }

    /**
     * Delete an agentic wallet and refund remaining balance to main wallet.
     *
     * @param walletId the wallet UUID
     * @return delete response with refunded amount
     * @throws DominusNodeException on API errors
     */
    public AgenticWalletDeleteResponse delete(String walletId) throws DominusNodeException {
        return http.delete("/api/agent-wallet/" + URLEncoder.encode(walletId, StandardCharsets.UTF_8), AgenticWalletDeleteResponse.class);
    }
}
