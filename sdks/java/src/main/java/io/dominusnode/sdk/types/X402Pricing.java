package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Pricing information for x402 payments.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class X402Pricing {

    private final int perRequestCents;
    private final int perGbCents;
    private final String currency;

    @JsonCreator
    public X402Pricing(
            @JsonProperty("perRequestCents") int perRequestCents,
            @JsonProperty("perGbCents") int perGbCents,
            @JsonProperty("currency") String currency) {
        this.perRequestCents = perRequestCents;
        this.perGbCents = perGbCents;
        this.currency = currency;
    }

    public int getPerRequestCents() { return perRequestCents; }
    public int getPerGbCents() { return perGbCents; }
    public String getCurrency() { return currency; }

    @Override
    public String toString() {
        return "X402Pricing{perRequestCents=" + perRequestCents + ", perGbCents=" + perGbCents + ", currency='" + currency + "'}";
    }
}
