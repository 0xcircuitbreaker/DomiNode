package io.dominusnode.sdk.types;

import com.google.gson.annotations.SerializedName;

/**
 * Represents a wallet transaction on a team.
 */
public final class TeamTransaction {

    private String id;

    @SerializedName("teamId")
    private String teamId;

    private String type;

    @SerializedName("amountCents")
    private int amountCents;

    private String description;

    @SerializedName("createdAt")
    private String createdAt;

    public String getId() { return id; }
    public String getTeamId() { return teamId; }
    public String getType() { return type; }
    public int getAmountCents() { return amountCents; }
    public String getDescription() { return description; }
    public String getCreatedAt() { return createdAt; }
}
