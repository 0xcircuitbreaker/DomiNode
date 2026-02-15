package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * An API key entry as returned in key listings.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class ApiKey {

    private final String id;
    private final String prefix;
    private final String label;
    private final String createdAt;
    private final String revokedAt;

    @JsonCreator
    public ApiKey(
            @JsonProperty("id") String id,
            @JsonProperty("prefix") String prefix,
            @JsonProperty("label") String label,
            @JsonProperty("created_at") String createdAt,
            @JsonProperty("revoked_at") String revokedAt) {
        this.id = id;
        this.prefix = prefix;
        this.label = label;
        this.createdAt = createdAt;
        this.revokedAt = revokedAt;
    }

    /** Unique key identifier. */
    public String getId() { return id; }

    /** Key prefix (e.g., "dn_live_abc..."). */
    public String getPrefix() { return prefix; }

    /** User-assigned label. */
    public String getLabel() { return label; }

    /** ISO 8601 creation timestamp. */
    public String getCreatedAt() { return createdAt; }

    /** ISO 8601 revocation timestamp, or {@code null} if active. */
    public String getRevokedAt() { return revokedAt; }

    @Override
    public String toString() {
        return "ApiKey{id='" + id + "', prefix='" + prefix + "', label='" + label + "'}";
    }
}
