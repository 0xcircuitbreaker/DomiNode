package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * System-wide statistics for administrators.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class SystemStats {

    private final int activeSessions;
    private final int totalUsers;
    private final long totalBandwidthBytes;

    @JsonCreator
    public SystemStats(
            @JsonProperty("active_sessions") int activeSessions,
            @JsonProperty("total_users") int totalUsers,
            @JsonProperty("total_bandwidth_bytes") long totalBandwidthBytes) {
        this.activeSessions = activeSessions;
        this.totalUsers = totalUsers;
        this.totalBandwidthBytes = totalBandwidthBytes;
    }

    /** Number of currently active proxy sessions system-wide. */
    public int getActiveSessions() { return activeSessions; }

    /** Total number of registered users. */
    public int getTotalUsers() { return totalUsers; }

    /** Total bandwidth in bytes across all users. */
    public long getTotalBandwidthBytes() { return totalBandwidthBytes; }

    @Override
    public String toString() {
        return "SystemStats{activeSessions=" + activeSessions + ", totalUsers=" + totalUsers
                + ", totalBandwidthBytes=" + totalBandwidthBytes + "}";
    }
}
