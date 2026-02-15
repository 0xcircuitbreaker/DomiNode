package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Aggregated usage statistics summary.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class UsageSummary {

    private final long totalBytes;
    private final int totalCostCents;
    private final int requestCount;
    private final double totalGB;
    private final double totalCostUsd;

    @JsonCreator
    public UsageSummary(
            @JsonProperty("totalBytes") long totalBytes,
            @JsonProperty("totalCostCents") int totalCostCents,
            @JsonProperty("requestCount") int requestCount,
            @JsonProperty("totalGB") double totalGB,
            @JsonProperty("totalCostUsd") double totalCostUsd) {
        this.totalBytes = totalBytes;
        this.totalCostCents = totalCostCents;
        this.requestCount = requestCount;
        this.totalGB = totalGB;
        this.totalCostUsd = totalCostUsd;
    }

    /** Total bytes transferred. */
    public long getTotalBytes() { return totalBytes; }

    /** Total cost in cents. */
    public int getTotalCostCents() { return totalCostCents; }

    /** Total number of requests. */
    public int getRequestCount() { return requestCount; }

    /** Total data transferred in gigabytes. */
    public double getTotalGB() { return totalGB; }

    /** Total cost in USD. */
    public double getTotalCostUsd() { return totalCostUsd; }

    @Override
    public String toString() {
        return "UsageSummary{totalBytes=" + totalBytes + ", totalCostCents=" + totalCostCents
                + ", requestCount=" + requestCount + "}";
    }
}
