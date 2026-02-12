package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Collections;
import java.util.List;

/**
 * Detailed proxy status including provider information.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class ProxyStatus {

    private final String status;
    private final int activeSessions;
    private final int userActiveSessions;
    private final double avgLatencyMs;
    private final List<ProviderStat> providers;
    private final ProxyEndpoints endpoints;
    private final List<String> supportedCountries;
    private final long uptimeSeconds;

    @JsonCreator
    public ProxyStatus(
            @JsonProperty("status") String status,
            @JsonProperty("activeSessions") int activeSessions,
            @JsonProperty("userActiveSessions") int userActiveSessions,
            @JsonProperty("avgLatencyMs") double avgLatencyMs,
            @JsonProperty("providers") List<ProviderStat> providers,
            @JsonProperty("endpoints") ProxyEndpoints endpoints,
            @JsonProperty("supportedCountries") List<String> supportedCountries,
            @JsonProperty("uptimeSeconds") long uptimeSeconds) {
        this.status = status;
        this.activeSessions = activeSessions;
        this.userActiveSessions = userActiveSessions;
        this.avgLatencyMs = avgLatencyMs;
        this.providers = providers != null ? Collections.unmodifiableList(providers) : Collections.emptyList();
        this.endpoints = endpoints;
        this.supportedCountries = supportedCountries != null
                ? Collections.unmodifiableList(supportedCountries) : Collections.emptyList();
        this.uptimeSeconds = uptimeSeconds;
    }

    /** Overall proxy status. */
    public String getStatus() { return status; }

    /** Total active sessions across all users. */
    public int getActiveSessions() { return activeSessions; }

    /** Active sessions for the current user. */
    public int getUserActiveSessions() { return userActiveSessions; }

    /** Average request latency in milliseconds. */
    public double getAvgLatencyMs() { return avgLatencyMs; }

    /** Statistics for each upstream provider. */
    public List<ProviderStat> getProviders() { return providers; }

    /** Proxy endpoint addresses. */
    public ProxyEndpoints getEndpoints() { return endpoints; }

    /** List of supported country codes for geo-targeting. */
    public List<String> getSupportedCountries() { return supportedCountries; }

    /** Server uptime in seconds. */
    public long getUptimeSeconds() { return uptimeSeconds; }

    @Override
    public String toString() {
        return "ProxyStatus{status='" + status + "', activeSessions=" + activeSessions
                + ", providers=" + providers.size() + "}";
    }
}
