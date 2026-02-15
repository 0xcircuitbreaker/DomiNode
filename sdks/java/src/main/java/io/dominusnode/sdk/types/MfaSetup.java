package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Collections;
import java.util.List;

/**
 * MFA setup information returned when initiating TOTP enrollment.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class MfaSetup {

    private final String secret;
    private final String otpauthUri;
    private final List<String> backupCodes;

    @JsonCreator
    public MfaSetup(
            @JsonProperty("secret") String secret,
            @JsonProperty("otpauthUri") String otpauthUri,
            @JsonProperty("backupCodes") List<String> backupCodes) {
        this.secret = secret;
        this.otpauthUri = otpauthUri;
        this.backupCodes = backupCodes != null ? Collections.unmodifiableList(backupCodes) : Collections.emptyList();
    }

    /** TOTP secret key (base32 encoded). */
    public String getSecret() { return secret; }

    /** OTP auth URI for QR code generation. */
    public String getOtpauthUri() { return otpauthUri; }

    /** One-time backup codes for account recovery. */
    public List<String> getBackupCodes() { return backupCodes; }

    @Override
    public String toString() {
        return "MfaSetup{secret=[REDACTED], otpauthUri=[REDACTED], backupCodes=["
                + backupCodes.size() + " codes]}";
    }
}
