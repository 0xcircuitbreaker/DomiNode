package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The current user's plan and monthly usage information.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class UserPlanInfo {

    private final Plan plan;
    private final UserPlanUsage usage;

    @JsonCreator
    public UserPlanInfo(
            @JsonProperty("plan") Plan plan,
            @JsonProperty("usage") UserPlanUsage usage) {
        this.plan = plan;
        this.usage = usage;
    }

    /** The user's current plan. */
    public Plan getPlan() { return plan; }

    /** Monthly usage against the plan limits. */
    public UserPlanUsage getUsage() { return usage; }

    @Override
    public String toString() {
        return "UserPlanInfo{plan=" + plan + ", usage=" + usage + "}";
    }
}
