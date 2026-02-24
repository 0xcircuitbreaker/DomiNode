package io.dominusnode.sdk.resources;

import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.internal.HttpClient;
import io.dominusnode.sdk.types.X402Info;

/**
 * x402 (HTTP 402 Payment Required) protocol information.
 *
 * <p>Provides details about x402 micropayment support, facilitator addresses,
 * pricing, and supported chains/currencies for AI agent payments.</p>
 */
public final class X402Resource {

    private final HttpClient http;

    public X402Resource(HttpClient http) {
        this.http = http;
    }

    /**
     * Get x402 protocol information including facilitator details,
     * pricing, supported chains, and currencies.
     *
     * <p>This endpoint does not require authentication.</p>
     *
     * @return x402 protocol information
     * @throws DominusNodeException on API errors
     */
    public X402Info getInfo() throws DominusNodeException {
        return http.get("/api/x402/info", X402Info.class, false);
    }
}
