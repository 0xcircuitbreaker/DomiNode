package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * An active proxy session.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class ActiveSession {

    private final String id;
    private final String startedAt;
    private final String status;

    @JsonCreator
    public ActiveSession(
            @JsonProperty("id") String id,
            @JsonProperty("startedAt") String startedAt,
            @JsonProperty("status") String status) {
        this.id = id;
        this.startedAt = startedAt;
        this.status = status;
    }

    /** Session identifier. */
    public String getId() { return id; }

    /** ISO 8601 start timestamp. */
    public String getStartedAt() { return startedAt; }

    /** Session status (e.g., "active"). */
    public String getStatus() { return status; }

    @Override
    public String toString() {
        return "ActiveSession{id='" + id + "', status='" + status + "'}";
    }
}
