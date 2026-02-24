package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Challenge returned by the wallet/challenge endpoint.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class WalletChallenge {

    private final String challenge;
    private final String expiresAt;

    @JsonCreator
    public WalletChallenge(
            @JsonProperty("challenge") String challenge,
            @JsonProperty("expiresAt") String expiresAt) {
        this.challenge = challenge;
        this.expiresAt = expiresAt;
    }

    public String getChallenge() { return challenge; }
    public String getExpiresAt() { return expiresAt; }

    @Override
    public String toString() {
        return "WalletChallenge{challenge='" + challenge + "', expiresAt='" + expiresAt + "'}";
    }
}
