package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;

import static io.dominusnode.sdk.internal.Validation.qs;

/** Usage (jwt). {@code from} maps to query {@code since}, {@code to} to {@code until} (ISO 8601). */
public final class UsageResource {
    private final ApiClient http;

    public UsageResource(ApiClient http) { this.http = http; }

    public JsonNode get() { return get(null, null, null, null); }

    public JsonNode get(String from, String to, Integer limit, Integer offset) {
        return http.get("/api/usage" + qs("since", from, "until", to, "limit", limit, "offset", offset), Auth.JWT);
    }

    public JsonNode getDaily() { return getDaily(null, null); }

    public JsonNode getDaily(String from, String to) {
        return http.get("/api/usage/daily" + qs("since", from, "until", to), Auth.JWT);
    }

    public JsonNode getTopHosts() { return getTopHosts(null, null, null); }

    public JsonNode getTopHosts(String from, String to, Integer limit) {
        return http.get("/api/usage/top-hosts" + qs("since", from, "until", to, "limit", limit), Auth.JWT);
    }

    public String exportCsv() { return exportCsv(null, null); }

    /** GET /api/usage/export -> raw CSV. */
    public String exportCsv(String from, String to) {
        return http.request("GET", "/api/usage/export" + qs("since", from, "until", to), null, Auth.JWT, null, true).asText();
    }
}
