package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Result of a plan change operation.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class ChangePlanResult {

    private final String message;
    private final Plan plan;

    @JsonCreator
    public ChangePlanResult(
            @JsonProperty("message") String message,
            @JsonProperty("plan") Plan plan) {
        this.message = message;
        this.plan = plan;
    }

    /** Confirmation message. */
    public String getMessage() { return message; }

    /** The new plan now active on the account. */
    public Plan getPlan() { return plan; }

    @Override
    public String toString() {
        return "ChangePlanResult{message='" + message + "', plan=" + plan + "}";
    }
}
