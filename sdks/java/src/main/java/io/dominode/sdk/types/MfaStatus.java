package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Current MFA status for the authenticated user.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class MfaStatus {

    private final boolean enabled;
    private final int backupCodesRemaining;

    @JsonCreator
    public MfaStatus(
            @JsonProperty("enabled") boolean enabled,
            @JsonProperty("backupCodesRemaining") int backupCodesRemaining) {
        this.enabled = enabled;
        this.backupCodesRemaining = backupCodesRemaining;
    }

    /** Whether MFA is currently enabled. */
    public boolean isEnabled() { return enabled; }

    /** Number of unused backup codes remaining. */
    public int getBackupCodesRemaining() { return backupCodesRemaining; }

    @Override
    public String toString() {
        return "MfaStatus{enabled=" + enabled + ", backupCodesRemaining=" + backupCodesRemaining + "}";
    }
}
