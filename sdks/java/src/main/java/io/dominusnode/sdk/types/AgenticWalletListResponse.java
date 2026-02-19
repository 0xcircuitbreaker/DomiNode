package io.dominusnode.sdk.types;

import java.util.List;

/**
 * Response from listing agentic wallets.
 */
public final class AgenticWalletListResponse {

    private List<AgenticWallet> wallets;

    public List<AgenticWallet> getWallets() { return wallets; }
}
