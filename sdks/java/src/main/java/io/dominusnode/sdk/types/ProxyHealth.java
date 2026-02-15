package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Public proxy health status.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class ProxyHealth {

    private final String status;
    private final int activeSessions;
    private final long uptimeSeconds;

    @JsonCreator
    public ProxyHealth(
            @JsonProperty("status") String status,
            @JsonProperty("activeSessions") int activeSessions,
            @JsonProperty("uptimeSeconds") long uptimeSeconds) {
        this.status = status;
        this.activeSessions = activeSessions;
        this.uptimeSeconds = uptimeSeconds;
    }

    /** Health status string (e.g., "ok", "degraded"). */
    public String getStatus() { return status; }

    /** Number of currently active proxy sessions. */
    public int getActiveSessions() { return activeSessions; }

    /** Server uptime in seconds. */
    public long getUptimeSeconds() { return uptimeSeconds; }

    @Override
    public String toString() {
        return "ProxyHealth{status='" + status + "', activeSessions=" + activeSessions + "}";
    }
}
