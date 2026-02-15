package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A pair of JWT access token and refresh token returned from token refresh.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class TokenPair {

    private final String token;
    private final String refreshToken;

    @JsonCreator
    public TokenPair(
            @JsonProperty("token") String token,
            @JsonProperty("refreshToken") String refreshToken) {
        this.token = token;
        this.refreshToken = refreshToken;
    }

    /** JWT access token. */
    public String getToken() { return token; }

    /** Refresh token for obtaining new access tokens. */
    public String getRefreshToken() { return refreshToken; }

    @Override
    public String toString() {
        return "TokenPair{token=[REDACTED], refreshToken=[REDACTED]}";
    }
}
