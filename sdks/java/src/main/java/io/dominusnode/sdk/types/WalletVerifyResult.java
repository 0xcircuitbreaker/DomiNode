package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Result from wallet verify -- includes JWT tokens and user.
 *
 * <p>When {@link #isMfaRequired()} returns {@code true}, the caller must complete
 * MFA verification using {@code auth.verifyMfa(code, mfaChallengeToken)} before
 * the client is fully authenticated. In this case, token and refreshToken may be null.</p>
 *
 * <p>Token values are redacted in toString() to prevent accidental leakage.</p>
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class WalletVerifyResult {

    private final String token;
    private final String refreshToken;
    private final User user;
    private final boolean mfaRequired;
    private final String mfaChallengeToken;

    @JsonCreator
    public WalletVerifyResult(
            @JsonProperty("token") String token,
            @JsonProperty("refreshToken") String refreshToken,
            @JsonProperty("user") User user,
            @JsonProperty("mfaRequired") boolean mfaRequired,
            @JsonProperty("mfaChallengeToken") String mfaChallengeToken) {
        this.token = token;
        this.refreshToken = refreshToken;
        this.user = user;
        this.mfaRequired = mfaRequired;
        this.mfaChallengeToken = mfaChallengeToken;
    }

    public String getToken() { return token; }
    public String getRefreshToken() { return refreshToken; }
    public User getUser() { return user; }
    /** R46 C-1: True when MFA is required before authentication is complete. */
    public boolean isMfaRequired() { return mfaRequired; }
    public String getMfaChallengeToken() { return mfaChallengeToken; }

    @Override
    public String toString() {
        return "WalletVerifyResult{token=[REDACTED], refreshToken=[REDACTED], user=" + user
                + ", mfaRequired=" + mfaRequired + "}";
    }
}
