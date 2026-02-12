package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A single wallet transaction (top-up, debit, or refund).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class WalletTransaction {

    private final String id;
    private final String type;
    private final int amountCents;
    private final double amountUsd;
    private final String description;
    private final String paymentProvider;
    private final String createdAt;

    @JsonCreator
    public WalletTransaction(
            @JsonProperty("id") String id,
            @JsonProperty("type") String type,
            @JsonProperty("amountCents") int amountCents,
            @JsonProperty("amountUsd") double amountUsd,
            @JsonProperty("description") String description,
            @JsonProperty("paymentProvider") String paymentProvider,
            @JsonProperty("createdAt") String createdAt) {
        this.id = id;
        this.type = type;
        this.amountCents = amountCents;
        this.amountUsd = amountUsd;
        this.description = description;
        this.paymentProvider = paymentProvider;
        this.createdAt = createdAt;
    }

    /** Transaction identifier. */
    public String getId() { return id; }

    /** Transaction type: "topup", "debit", or "refund". */
    public String getType() { return type; }

    /** Amount in cents (integer). */
    public int getAmountCents() { return amountCents; }

    /** Amount in USD (decimal). */
    public double getAmountUsd() { return amountUsd; }

    /** Human-readable description. */
    public String getDescription() { return description; }

    /** Payment provider used (e.g., "stripe", "nowpayments"), or {@code null}. */
    public String getPaymentProvider() { return paymentProvider; }

    /** ISO 8601 creation timestamp. */
    public String getCreatedAt() { return createdAt; }

    @Override
    public String toString() {
        return "WalletTransaction{id='" + id + "', type='" + type
                + "', amountCents=" + amountCents + "}";
    }
}
