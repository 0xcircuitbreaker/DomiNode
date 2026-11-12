package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;
import io.dominusnode.sdk.internal.Validation;

import static io.dominusnode.sdk.internal.Validation.qs;

/** Payout history (/v1/payouts, agent). */
public final class PayoutsResource {
    private final ApiClient http;

    public PayoutsResource(ApiClient http) { this.http = http; }

    public JsonNode list() { return list(null, null); }

    /** limit 1..200, offset 0..1,000,000. */
    public JsonNode list(Integer limit, Integer offset) {
        if (limit != null) Validation.intRange(limit, "limit", 1, 200);
        if (offset != null) Validation.intRange(offset, "offset", 0, 1_000_000);
        return http.get("/v1/payouts" + qs("limit", limit, "offset", offset), Auth.AGENT);
    }

    /** Every payout (offset pagination; page size default 50, max 200). */
    public java.util.Iterator<JsonNode> iterate(Integer limit) {
        int l = Paging.pageSize(limit, 50, 200);
        return Paging.offset(l, "payouts", false, this::list);
    }

    public java.util.stream.Stream<JsonNode> stream(Integer limit) { return Paging.stream(iterate(limit)); }
}
