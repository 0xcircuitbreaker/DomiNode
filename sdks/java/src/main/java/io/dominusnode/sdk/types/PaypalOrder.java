package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * PayPal order for wallet top-up.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class PaypalOrder {

    private final String orderId;
    private final String approvalUrl;
    private final int amountCents;

    @JsonCreator
    public PaypalOrder(
            @JsonProperty("orderId") String orderId,
            @JsonProperty("approvalUrl") String approvalUrl,
            @JsonProperty("amountCents") int amountCents) {
        this.orderId = orderId;
        this.approvalUrl = approvalUrl;
        this.amountCents = amountCents;
    }

    /** PayPal order ID. */
    public String getOrderId() { return orderId; }

    /** PayPal approval URL to redirect the user to. */
    public String getApprovalUrl() { return approvalUrl; }

    /** The top-up amount in cents. */
    public int getAmountCents() { return amountCents; }

    @Override
    public String toString() {
        return "PaypalOrder{orderId='" + orderId + "', approvalUrl='" + approvalUrl
                + "', amountCents=" + amountCents + "}";
    }
}
