package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Statistics for a single upstream proxy provider.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class ProviderStat {

    private final String name;
    private final String state;
    private final int consecutiveFailures;
    private final int totalRequests;
    private final int totalErrors;
    private final double avgLatencyMs;
    private final boolean fallbackOnly;

    @JsonCreator
    public ProviderStat(
            @JsonProperty("name") String name,
            @JsonProperty("state") String state,
            @JsonProperty("consecutiveFailures") int consecutiveFailures,
            @JsonProperty("totalRequests") int totalRequests,
            @JsonProperty("totalErrors") int totalErrors,
            @JsonProperty("avgLatencyMs") double avgLatencyMs,
            @JsonProperty("fallbackOnly") boolean fallbackOnly) {
        this.name = name;
        this.state = state;
        this.consecutiveFailures = consecutiveFailures;
        this.totalRequests = totalRequests;
        this.totalErrors = totalErrors;
        this.avgLatencyMs = avgLatencyMs;
        this.fallbackOnly = fallbackOnly;
    }

    /** Provider name. */
    public String getName() { return name; }

    /** Circuit breaker state (e.g., "closed", "open", "half-open"). */
    public String getState() { return state; }

    /** Number of consecutive failures. */
    public int getConsecutiveFailures() { return consecutiveFailures; }

    /** Total requests routed through this provider. */
    public int getTotalRequests() { return totalRequests; }

    /** Total errors from this provider. */
    public int getTotalErrors() { return totalErrors; }

    /** Average latency in milliseconds. */
    public double getAvgLatencyMs() { return avgLatencyMs; }

    /** Whether this provider is a fallback-only provider. */
    public boolean isFallbackOnly() { return fallbackOnly; }

    @Override
    public String toString() {
        return "ProviderStat{name='" + name + "', state='" + state
                + "', totalRequests=" + totalRequests + "}";
    }
}
