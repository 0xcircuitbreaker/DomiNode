package io.dominusnode.sdk.types;

/**
 * Response from funding an agentic wallet.
 */
public final class AgenticWalletFundResponse {

    private AgenticWalletTransaction transaction;

    public AgenticWalletTransaction getTransaction() { return transaction; }
}
