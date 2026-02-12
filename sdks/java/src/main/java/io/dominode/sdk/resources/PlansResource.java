package io.dominode.sdk.resources;

import io.dominode.sdk.errors.DomiNodeException;
import io.dominode.sdk.internal.HttpClient;
import io.dominode.sdk.internal.JsonUtil;
import io.dominode.sdk.types.ChangePlanResult;
import io.dominode.sdk.types.Plan;
import io.dominode.sdk.types.UserPlanInfo;

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
     * @throws DomiNodeException on API errors
     */
    public List<Plan> list() throws DomiNodeException {
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
     * @throws DomiNodeException on API errors
     */
    public UserPlanInfo getUserPlan() throws DomiNodeException {
        return http.get("/api/plans/user/plan", UserPlanInfo.class);
    }

    /**
     * Change the current user's plan.
     *
     * @param planId the target plan ID
     * @return result with confirmation and new plan details
     * @throws DomiNodeException on API errors
     */
    public ChangePlanResult changePlan(String planId) throws DomiNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("planId", planId);
        return http.put("/api/plans/user/plan", body, ChangePlanResult.class);
    }
}
