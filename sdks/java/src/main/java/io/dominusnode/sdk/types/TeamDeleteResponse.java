package io.dominusnode.sdk.types;

import com.google.gson.annotations.SerializedName;

/**
 * Response from deleting a team.
 */
public final class TeamDeleteResponse {

    @SerializedName("refundedCents")
    private int refundedCents;

    public int getRefundedCents() { return refundedCents; }
}
