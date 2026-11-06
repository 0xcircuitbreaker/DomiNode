package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;

/** x402 info. Prices are server-reported; the SDK hardcodes none. */
public final class X402Resource {
    private final ApiClient http;

    public X402Resource(ApiClient http) { this.http = http; }

    /** GET /api/x402/info [none]. */
    public JsonNode getInfo() { return http.get("/api/x402/info", Auth.NONE); }
}
