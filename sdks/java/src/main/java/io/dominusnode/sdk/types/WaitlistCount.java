package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Number of people on the waitlist.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class WaitlistCount {

    private final int pending;

    @JsonCreator
    public WaitlistCount(
            @JsonProperty("pending") int pending) {
        this.pending = pending;
    }

    /** Number of people waiting on the waitlist. */
    public int getPending() { return pending; }

    @Override
    public String toString() {
        return "WaitlistCount{pending=" + pending + "}";
    }
}
