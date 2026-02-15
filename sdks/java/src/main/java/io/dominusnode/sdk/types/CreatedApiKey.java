package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A newly created API key. The raw key value is only returned once at creation time.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class CreatedApiKey {

    private final String key;
    private final String id;
    private final String prefix;
    private final String label;
    private final String createdAt;

    @JsonCreator
    public CreatedApiKey(
            @JsonProperty("key") String key,
            @JsonProperty("id") String id,
            @JsonProperty("prefix") String prefix,
            @JsonProperty("label") String label,
            @JsonProperty("created_at") String createdAt) {
        this.key = key;
        this.id = id;
        this.prefix = prefix;
        this.label = label;
        this.createdAt = createdAt;
    }

    /** The raw API key value. Only shown once -- store it securely. */
    public String getKey() { return key; }

    /** Unique key identifier. */
    public String getId() { return id; }

    /** Key prefix for identification. */
    public String getPrefix() { return prefix; }

    /** User-assigned label. */
    public String getLabel() { return label; }

    /** ISO 8601 creation timestamp. */
    public String getCreatedAt() { return createdAt; }

    @Override
    public String toString() {
        return "CreatedApiKey{id='" + id + "', prefix='" + prefix
                + "', label='" + label + "', key=[REDACTED]}";
    }
}
