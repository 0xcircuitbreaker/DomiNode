package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A target host ranked by bandwidth consumption.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class TopHost {

    private final String targetHost;
    private final long totalBytes;
    private final double totalGB;
    private final int requestCount;

    @JsonCreator
    public TopHost(
            @JsonProperty("targetHost") String targetHost,
            @JsonProperty("totalBytes") long totalBytes,
            @JsonProperty("totalGB") double totalGB,
            @JsonProperty("requestCount") int requestCount) {
        this.targetHost = targetHost;
        this.totalBytes = totalBytes;
        this.totalGB = totalGB;
        this.requestCount = requestCount;
    }

    /** The target hostname. */
    public String getTargetHost() { return targetHost; }

    /** Total bytes transferred. */
    public long getTotalBytes() { return totalBytes; }

    /** Total gigabytes transferred. */
    public double getTotalGB() { return totalGB; }

    /** Number of requests. */
    public int getRequestCount() { return requestCount; }

    @Override
    public String toString() {
        return "TopHost{targetHost='" + targetHost + "', totalBytes=" + totalBytes + "}";
    }
}
