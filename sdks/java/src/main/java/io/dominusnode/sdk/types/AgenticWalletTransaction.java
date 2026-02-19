package io.dominusnode.sdk.types;

import com.google.gson.annotations.SerializedName;

/**
 * Represents a transaction on an agentic wallet.
 */
public final class AgenticWalletTransaction {

    private String id;

    @SerializedName("walletId")
    private String walletId;

    private String type;

    @SerializedName("amountCents")
    private int amountCents;

    private String description;

    @SerializedName("sessionId")
    private String sessionId;

    @SerializedName("createdAt")
    private String createdAt;

    public String getId() { return id; }
    public String getWalletId() { return walletId; }
    public String getType() { return type; }
    public int getAmountCents() { return amountCents; }
    public String getDescription() { return description; }
    public String getSessionId() { return sessionId; }
    public String getCreatedAt() { return createdAt; }
}
