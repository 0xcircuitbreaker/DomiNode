package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Result of a login or registration operation.
 *
 * <p>If {@link #isMfaRequired()} returns {@code true}, the caller must complete
 * MFA verification before the session is fully authenticated. The
 * {@code mfaChallengeToken} is needed for the MFA verify call.</p>
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class LoginResult {

    private final User user;
    private final boolean mfaRequired;
    private final String token;
    private final String refreshToken;
    private final String mfaChallengeToken;

    @JsonCreator
    public LoginResult(
            @JsonProperty("user") User user,
            @JsonProperty("mfaRequired") boolean mfaRequired,
            @JsonProperty("token") String token,
            @JsonProperty("refreshToken") String refreshToken,
            @JsonProperty("mfaChallengeToken") String mfaChallengeToken) {
        this.user = user;
        this.mfaRequired = mfaRequired;
        this.token = token;
        this.refreshToken = refreshToken;
        this.mfaChallengeToken = mfaChallengeToken;
    }

    /** The authenticated user, or {@code null} if MFA is required. */
    public User getUser() { return user; }

    /** Whether MFA verification is required to complete login. */
    public boolean isMfaRequired() { return mfaRequired; }

    /** JWT access token, or {@code null} if MFA is required. */
    public String getToken() { return token; }

    /** Refresh token, or {@code null} if MFA is required. */
    public String getRefreshToken() { return refreshToken; }

    /** MFA challenge token needed for MFA verification, or {@code null}. */
    public String getMfaChallengeToken() { return mfaChallengeToken; }

    @Override
    public String toString() {
        return "LoginResult{user=" + user
                + ", mfaRequired=" + mfaRequired
                + ", token=[REDACTED]"
                + ", refreshToken=[REDACTED]"
                + "}";
    }
}
