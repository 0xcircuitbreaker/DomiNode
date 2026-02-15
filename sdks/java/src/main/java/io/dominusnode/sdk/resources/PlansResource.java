package io.dominusnode.sdk.resources;

import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.internal.HttpClient;
import io.dominusnode.sdk.internal.JsonUtil;
import io.dominusnode.sdk.types.ChangePlanResult;
import io.dominusnode.sdk.types.Plan;
import io.dominusnode.sdk.types.UserPlanInfo;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Plan management: list plans, view current plan, and change plans.
 */
public final class PlansResource {

    private final HttpClient http;

    /**
     * @param http the HTTP client
     */
    public PlansResource(HttpClient http) {
        this.http = http;
    }

    /**
     * List all available plans. Does not require authentication.
     *
     * @return list of plans
     * @throws DominusNodeException on API errors
     */
    public List<Plan> list() throws DominusNodeException {
        // Server returns { plans: [...] }
        Map<?, ?> raw = http.get("/api/plans", Map.class, false);
        String json = JsonUtil.toJson(raw.get("plans"));
        Plan[] plans = JsonUtil.fromJson(json, Plan[].class);
        return Arrays.asList(plans);
    }

    /**
     * Get the current user's plan and monthly usage.
     *
     * @return user plan info with usage data
     * @throws DominusNodeException on API errors
     */
    public UserPlanInfo getUserPlan() throws DominusNodeException {
        return http.get("/api/plans/user/plan", UserPlanInfo.class);
    }

    /**
     * Change the current user's plan.
     *
     * @param planId the target plan ID
     * @return result with confirmation and new plan details
     * @throws DominusNodeException on API errors
     */
    public ChangePlanResult changePlan(String planId) throws DominusNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("planId", planId);
        return http.put("/api/plans/user/plan", body, ChangePlanResult.class);
    }
}
