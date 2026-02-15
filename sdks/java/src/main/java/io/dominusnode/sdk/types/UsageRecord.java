package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A single usage record representing one proxy session's data transfer.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class UsageRecord {

    private final String id;
    private final String sessionId;
    private final long bytesIn;
    private final long bytesOut;
    private final long totalBytes;
    private final int costCents;
    private final String proxyType;
    private final String targetHost;
    private final String createdAt;

    @JsonCreator
    public UsageRecord(
            @JsonProperty("id") String id,
            @JsonProperty("sessionId") String sessionId,
            @JsonProperty("bytesIn") long bytesIn,
            @JsonProperty("bytesOut") long bytesOut,
            @JsonProperty("totalBytes") long totalBytes,
            @JsonProperty("costCents") int costCents,
            @JsonProperty("proxyType") String proxyType,
            @JsonProperty("targetHost") String targetHost,
            @JsonProperty("createdAt") String createdAt) {
        this.id = id;
        this.sessionId = sessionId;
        this.bytesIn = bytesIn;
        this.bytesOut = bytesOut;
        this.totalBytes = totalBytes;
        this.costCents = costCents;
        this.proxyType = proxyType;
        this.targetHost = targetHost;
        this.createdAt = createdAt;
    }

    /** Record identifier. */
    public String getId() { return id; }

    /** Associated proxy session ID. */
    public String getSessionId() { return sessionId; }

    /** Bytes received from target. */
    public long getBytesIn() { return bytesIn; }

    /** Bytes sent to target. */
    public long getBytesOut() { return bytesOut; }

    /** Total bytes transferred. */
    public long getTotalBytes() { return totalBytes; }

    /** Cost in cents. */
    public int getCostCents() { return costCents; }

    /** Proxy type used (e.g., "http", "socks5"). */
    public String getProxyType() { return proxyType; }

    /** Target hostname. */
    public String getTargetHost() { return targetHost; }

    /** ISO 8601 creation timestamp. */
    public String getCreatedAt() { return createdAt; }

    @Override
    public String toString() {
        return "UsageRecord{id='" + id + "', totalBytes=" + totalBytes
                + ", costCents=" + costCents + "}";
    }
}
