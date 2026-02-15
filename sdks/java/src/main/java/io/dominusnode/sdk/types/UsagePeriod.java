package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Time period for usage queries.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class UsagePeriod {

    private final String since;
    private final String until;

    @JsonCreator
    public UsagePeriod(
            @JsonProperty("since") String since,
            @JsonProperty("until") String until) {
        this.since = since;
        this.until = until;
    }

    /** Start of the period (ISO 8601). */
    public String getSince() { return since; }

    /** End of the period (ISO 8601). */
    public String getUntil() { return until; }

    @Override
    public String toString() {
        return "UsagePeriod{since='" + since + "', until='" + until + "'}";
    }
}
