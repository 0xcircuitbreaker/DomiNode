package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Usage data aggregated for a single day.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class DailyUsage {

    private final String date;
    private final long totalBytes;
    private final double totalGB;
    private final int totalCostCents;
    private final double totalCostUsd;
    private final int requestCount;

    @JsonCreator
    public DailyUsage(
            @JsonProperty("date") String date,
            @JsonProperty("totalBytes") long totalBytes,
            @JsonProperty("totalGB") double totalGB,
            @JsonProperty("totalCostCents") int totalCostCents,
            @JsonProperty("totalCostUsd") double totalCostUsd,
            @JsonProperty("requestCount") int requestCount) {
        this.date = date;
        this.totalBytes = totalBytes;
        this.totalGB = totalGB;
        this.totalCostCents = totalCostCents;
        this.totalCostUsd = totalCostUsd;
        this.requestCount = requestCount;
    }

    /** Date in YYYY-MM-DD format. */
    public String getDate() { return date; }

    /** Total bytes transferred on this day. */
    public long getTotalBytes() { return totalBytes; }

    /** Total gigabytes transferred. */
    public double getTotalGB() { return totalGB; }

    /** Total cost in cents. */
    public int getTotalCostCents() { return totalCostCents; }

    /** Total cost in USD. */
    public double getTotalCostUsd() { return totalCostUsd; }

    /** Number of requests. */
    public int getRequestCount() { return requestCount; }

    @Override
    public String toString() {
        return "DailyUsage{date='" + date + "', totalBytes=" + totalBytes
                + ", requestCount=" + requestCount + "}";
    }
}
