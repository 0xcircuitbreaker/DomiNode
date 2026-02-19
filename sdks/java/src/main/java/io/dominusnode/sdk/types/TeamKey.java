package io.dominusnode.sdk.types;

import com.google.gson.annotations.SerializedName;

/**
 * Represents an API key belonging to a team.
 */
public final class TeamKey {

    private String id;

    @SerializedName("keyPrefix")
    private String keyPrefix;

    private String label;

    @SerializedName("createdAt")
    private String createdAt;

    public String getId() { return id; }
    public String getKeyPrefix() { return keyPrefix; }
    public String getLabel() { return label; }
    public String getCreatedAt() { return createdAt; }
}
