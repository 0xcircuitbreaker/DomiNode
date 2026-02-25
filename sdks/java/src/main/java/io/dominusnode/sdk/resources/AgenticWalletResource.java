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
import java.util.HashMap;
import java.util.List;
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
        return create(label, spendingLimitCents, null, null);
    }

    /**
     * Create a new agentic wallet with optional policy fields.
     *
     * @param label              label for the wallet (1-100 chars)
     * @param spendingLimitCents maximum spend per transaction in cents (0 = no limit)
     * @param dailyLimitCents    optional daily spending limit in cents ({@code null} for no limit)
     * @param allowedDomains     optional list of allowed target domains ({@code null} for unrestricted)
     * @return the created wallet
     * @throws DominusNodeException on API errors
     */
    public AgenticWallet create(String label, int spendingLimitCents,
                                Integer dailyLimitCents, List<String> allowedDomains)
            throws DominusNodeException {
        WalletResource.validateAmountCents(spendingLimitCents);
        Map<String, Object> body = new HashMap<>();
        body.put("label", label);
        body.put("spendingLimitCents", spendingLimitCents);
        if (dailyLimitCents != null) {
            if (dailyLimitCents < 1 || dailyLimitCents > 1_000_000) {
                throw new DominusNodeException("dailyLimitCents must be between 1 and 1,000,000");
            }
            body.put("dailyLimitCents", dailyLimitCents);
        }
        if (allowedDomains != null) {
            body.put("allowedDomains", allowedDomains);
        }
        return http.post("/api/agent-wallet", body, AgenticWallet.class);
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
     * Update the policy on an agentic wallet.
     *
     * @param walletId        the wallet UUID
     * @param dailyLimitCents new daily spending limit in cents ({@code null} to leave unchanged)
     * @param allowedDomains  new list of allowed target domains ({@code null} to leave unchanged)
     * @return the updated wallet
     * @throws DominusNodeException on API errors
     */
    public AgenticWallet updateWalletPolicy(String walletId, Integer dailyLimitCents,
                                            List<String> allowedDomains) throws DominusNodeException {
        Map<String, Object> body = new HashMap<>();
        if (dailyLimitCents != null) {
            if (dailyLimitCents < 1 || dailyLimitCents > 1_000_000) {
                throw new DominusNodeException("dailyLimitCents must be between 1 and 1,000,000");
            }
            body.put("dailyLimitCents", dailyLimitCents);
        }
        if (allowedDomains != null) {
            body.put("allowedDomains", allowedDomains);
        }
        return http.patch("/api/agent-wallet/" + URLEncoder.encode(walletId, StandardCharsets.UTF_8) + "/policy",
                body, AgenticWallet.class);
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
