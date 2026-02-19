package io.dominusnode.sdk.types;

import com.google.gson.annotations.SerializedName;

/**
 * Represents a server-side custodial agentic wallet.
 */
public final class AgenticWallet {

    private String id;
    private String label;

    @SerializedName("balanceCents")
    private int balanceCents;

    @SerializedName("spendingLimitCents")
    private int spendingLimitCents;

    private String status;

    @SerializedName("createdAt")
    private String createdAt;

    public String getId() { return id; }
    public String getLabel() { return label; }
    public int getBalanceCents() { return balanceCents; }
    public int getSpendingLimitCents() { return spendingLimitCents; }
    public String getStatus() { return status; }
    public String getCreatedAt() { return createdAt; }
}
