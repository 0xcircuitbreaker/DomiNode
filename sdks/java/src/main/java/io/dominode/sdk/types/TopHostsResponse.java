package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Collections;
import java.util.List;

/**
 * Response containing top target hosts by bandwidth usage.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class TopHostsResponse {

    private final List<TopHost> hosts;
    private final UsagePeriod period;

    @JsonCreator
    public TopHostsResponse(
            @JsonProperty("hosts") List<TopHost> hosts,
            @JsonProperty("period") UsagePeriod period) {
        this.hosts = hosts != null ? Collections.unmodifiableList(hosts) : Collections.emptyList();
        this.period = period;
    }

    /** List of top hosts sorted by bandwidth. */
    public List<TopHost> getHosts() { return hosts; }

    /** Query time period. */
    public UsagePeriod getPeriod() { return period; }

    @Override
    public String toString() {
        return "TopHostsResponse{hosts=" + hosts.size() + " entries}";
    }
}
