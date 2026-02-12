package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Stripe checkout session for wallet top-up.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class StripeCheckout {

    private final String sessionId;
    private final String url;

    @JsonCreator
    public StripeCheckout(
            @JsonProperty("sessionId") String sessionId,
            @JsonProperty("url") String url) {
        this.sessionId = sessionId;
        this.url = url;
    }

    /** Stripe checkout session ID. */
    public String getSessionId() { return sessionId; }

    /** Stripe checkout URL to redirect the user to. */
    public String getUrl() { return url; }

    @Override
    public String toString() {
        return "StripeCheckout{sessionId='" + sessionId + "', url='" + url + "'}";
    }
}
