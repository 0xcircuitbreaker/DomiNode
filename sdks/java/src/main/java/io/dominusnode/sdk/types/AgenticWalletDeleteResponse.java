package io.dominusnode.sdk.types;

import com.google.gson.annotations.SerializedName;

/**
 * Response from deleting an agentic wallet.
 */
public final class AgenticWalletDeleteResponse {

    private boolean deleted;

    @SerializedName("refundedCents")
    private int refundedCents;

    public boolean isDeleted() { return deleted; }
    public int getRefundedCents() { return refundedCents; }
}
