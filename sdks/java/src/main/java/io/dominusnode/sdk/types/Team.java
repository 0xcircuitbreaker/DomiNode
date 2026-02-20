package io.dominusnode.sdk.types;

import com.google.gson.annotations.SerializedName;

/**
 * Represents a team with shared wallet and members.
 */
public final class Team {

    private String id;
    private String name;

    @SerializedName("ownerId")
    private String ownerId;

    @SerializedName("maxMembers")
    private int maxMembers;

    private String status;

    @SerializedName("balanceCents")
    private int balanceCents;

    @SerializedName("createdAt")
    private String createdAt;

    public String getId() { return id; }
    public String getName() { return name; }
    public String getOwnerId() { return ownerId; }
    public int getMaxMembers() { return maxMembers; }
    public String getStatus() { return status; }
    public int getBalanceCents() { return balanceCents; }
    public String getCreatedAt() { return createdAt; }
}
