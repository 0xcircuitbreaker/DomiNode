package io.dominusnode.sdk.types;

import com.google.gson.annotations.SerializedName;

/**
 * Response from creating a team API key. Includes the raw key (shown once).
 */
public final class TeamKeyCreateResponse {

    private String id;
    private String key;

    @SerializedName("keyPrefix")
    private String keyPrefix;

    private String label;

    public String getId() { return id; }
    public String getKey() { return key; }
    public String getKeyPrefix() { return keyPrefix; }
    public String getLabel() { return label; }
}
