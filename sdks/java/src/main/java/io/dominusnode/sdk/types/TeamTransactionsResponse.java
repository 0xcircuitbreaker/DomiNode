package io.dominusnode.sdk.types;

import java.util.List;

/**
 * Response from listing team wallet transactions.
 */
public final class TeamTransactionsResponse {

    private List<TeamTransaction> transactions;

    public List<TeamTransaction> getTransactions() { return transactions; }
}
