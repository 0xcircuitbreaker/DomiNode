package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Result of joining the waitlist.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class WaitlistJoinResult {

    private final String message;

    @JsonCreator
    public WaitlistJoinResult(
            @JsonProperty("message") String message) {
        this.message = message;
    }

    /** Success message from the server. */
    public String getMessage() { return message; }

    @Override
    public String toString() {
        return "WaitlistJoinResult{message='" + message + "'}";
    }
}
