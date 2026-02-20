package io.dominusnode.sdk.types;

import com.google.gson.annotations.SerializedName;

/**
 * Represents a member of a team.
 */
public final class TeamMember {

    private String id;

    @SerializedName("teamId")
    private String teamId;

    @SerializedName("userId")
    private String userId;

    private String email;
    private String role;

    @SerializedName("joinedAt")
    private String joinedAt;

    public String getId() { return id; }
    public String getTeamId() { return teamId; }
    public String getUserId() { return userId; }
    public String getEmail() { return email; }
    public String getRole() { return role; }
    public String getJoinedAt() { return joinedAt; }
}
