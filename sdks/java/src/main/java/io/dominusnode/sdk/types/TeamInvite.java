package io.dominusnode.sdk.types;

import com.google.gson.annotations.SerializedName;

/**
 * Represents a pending team invite.
 */
public final class TeamInvite {

    private String id;

    @SerializedName("teamId")
    private String teamId;

    private String email;
    private String role;
    private String token;

    @SerializedName("expiresAt")
    private String expiresAt;

    @SerializedName("createdAt")
    private String createdAt;

    public String getId() { return id; }
    public String getTeamId() { return teamId; }
    public String getEmail() { return email; }
    public String getRole() { return role; }
    public String getToken() { return token; }
    public String getExpiresAt() { return expiresAt; }
    public String getCreatedAt() { return createdAt; }
}
