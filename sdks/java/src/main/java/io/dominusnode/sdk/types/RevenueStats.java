package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Revenue statistics for a time period.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class RevenueStats {

    private final int totalRevenueCents;
    private final double totalRevenueUsd;
    private final int avgTransactionCents;
    private final double avgTransactionUsd;
    private final int transactionCount;
    private final int topupCount;
    private final UsagePeriod period;

    @JsonCreator
    public RevenueStats(
            @JsonProperty("totalRevenueCents") int totalRevenueCents,
            @JsonProperty("totalRevenueUsd") double totalRevenueUsd,
            @JsonProperty("avgTransactionCents") int avgTransactionCents,
            @JsonProperty("avgTransactionUsd") double avgTransactionUsd,
            @JsonProperty("transactionCount") int transactionCount,
            @JsonProperty("topupCount") int topupCount,
            @JsonProperty("period") UsagePeriod period) {
        this.totalRevenueCents = totalRevenueCents;
        this.totalRevenueUsd = totalRevenueUsd;
        this.avgTransactionCents = avgTransactionCents;
        this.avgTransactionUsd = avgTransactionUsd;
        this.transactionCount = transactionCount;
        this.topupCount = topupCount;
        this.period = period;
    }

    /** Total revenue in cents. */
    public int getTotalRevenueCents() { return totalRevenueCents; }

    /** Total revenue in USD. */
    public double getTotalRevenueUsd() { return totalRevenueUsd; }

    /** Average transaction amount in cents. */
    public int getAvgTransactionCents() { return avgTransactionCents; }

    /** Average transaction amount in USD. */
    public double getAvgTransactionUsd() { return avgTransactionUsd; }

    /** Total number of transactions. */
    public int getTransactionCount() { return transactionCount; }

    /** Number of top-up transactions. */
    public int getTopupCount() { return topupCount; }

    /** Query time period. */
    public UsagePeriod getPeriod() { return period; }

    @Override
    public String toString() {
        return "RevenueStats{totalRevenueCents=" + totalRevenueCents
                + ", transactionCount=" + transactionCount + "}";
    }
}
