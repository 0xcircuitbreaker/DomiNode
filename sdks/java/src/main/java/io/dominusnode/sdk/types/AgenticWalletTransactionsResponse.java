package io.dominusnode.sdk.types;

import java.util.List;

/**
 * Response from listing agentic wallet transactions.
 */
public final class AgenticWalletTransactionsResponse {

    private List<AgenticWalletTransaction> transactions;

    public List<AgenticWalletTransaction> getTransactions() { return transactions; }
}
