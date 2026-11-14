package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;

/** Public relay-network info (no auth). */
public final class NetworkResource {
    private final ApiClient http;

    public NetworkResource(ApiClient http) { this.http = http; }

    /** GET /v1/policy. */
    public JsonNode policy() { return http.get("/v1/policy", Auth.NONE); }

    /** GET /v1/pricing: live per-GB price by IP class (µUSD strings). */
    public JsonNode pricing() { return http.get("/v1/pricing", Auth.NONE); }

    /** GET /v1/network/stats. */
    public JsonNode stats() { return http.get("/v1/network/stats", Auth.NONE); }

    /**
     * GET /v1/status: public health summary. Fields: {@code status} (operational|degraded|down|unknown),
     * {@code coordinator {status, policyVersion}}, {@code gateway {status, instancesOnline, lastHeartbeatAt}},
     * {@code availability {last24h, last7d}} (percent or null), {@code nodes} (aggregates or null),
     * {@code incidents [{title, body, severity, status, startedAt, resolvedAt, updatedAt}]}, {@code generatedAt}.
     * Aggregates only: no node ids, instance ids or IPs.
     */
    public JsonNode status() { return http.get("/v1/status", Auth.NONE); }
}
