package io.dominusnode.sdk.resources;

import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.internal.HttpClient;
import io.dominusnode.sdk.types.Team;
import io.dominusnode.sdk.types.TeamDeleteResponse;
import io.dominusnode.sdk.types.TeamFundResponse;
import io.dominusnode.sdk.types.TeamInvite;
import io.dominusnode.sdk.types.TeamInvitesResponse;
import io.dominusnode.sdk.types.TeamKeyCreateResponse;
import io.dominusnode.sdk.types.TeamKeysResponse;
import io.dominusnode.sdk.types.TeamListResponse;
import io.dominusnode.sdk.types.TeamMember;
import io.dominusnode.sdk.types.TeamMembersResponse;
import io.dominusnode.sdk.types.TeamTransactionsResponse;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Team operations -- team management with shared wallet, members, invites, and API keys.
 */
public final class TeamsResource {

    private final HttpClient http;

    public TeamsResource(HttpClient http) {
        this.http = http;
    }

    /**
     * Create a new team.
     *
     * @param name       team name
     * @param maxMembers maximum number of members (0 or negative for default)
     * @return the created team
     * @throws DominusNodeException on API errors
     */
    public Team create(String name, int maxMembers) throws DominusNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("name", name);
        if (maxMembers > 0) {
            body.put("maxMembers", maxMembers);
        }
        return http.post("/api/teams", body, Team.class);
    }

    /**
     * Create a new team with default max members.
     *
     * @param name team name
     * @return the created team
     * @throws DominusNodeException on API errors
     */
    public Team create(String name) throws DominusNodeException {
        return http.post("/api/teams", Map.of("name", name), Team.class);
    }

    /**
     * List all teams the authenticated user belongs to.
     *
     * @return list of teams
     * @throws DominusNodeException on API errors
     */
    public List<Team> list() throws DominusNodeException {
        Team[] teams = http.get("/api/teams", Team[].class);
        return Arrays.asList(teams);
    }

    /**
     * Get a single team by ID.
     *
     * @param teamId the team UUID
     * @return the team
     * @throws DominusNodeException on API errors
     */
    public Team get(String teamId) throws DominusNodeException {
        return http.get("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8), Team.class);
    }

    /**
     * Update a team's settings.
     *
     * @param teamId  the team UUID
     * @param updates map of fields to update (name, maxMembers)
     * @return the updated team
     * @throws DominusNodeException on API errors
     */
    public Team update(String teamId, Map<String, Object> updates) throws DominusNodeException {
        return http.patch("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8),
                updates, Team.class);
    }

    /**
     * Delete a team and refund remaining wallet balance.
     *
     * @param teamId the team UUID
     * @return delete response with refunded amount
     * @throws DominusNodeException on API errors
     */
    public TeamDeleteResponse delete(String teamId) throws DominusNodeException {
        return http.delete("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8),
                TeamDeleteResponse.class);
    }

    /**
     * Fund the team wallet from the user's main wallet.
     *
     * @param teamId      the team UUID
     * @param amountCents amount in cents to transfer
     * @return the fund transaction
     * @throws DominusNodeException on API errors
     */
    public TeamFundResponse fundWallet(String teamId, int amountCents) throws DominusNodeException {
        return http.post("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8) + "/wallet/fund",
                Map.of("amountCents", amountCents), TeamFundResponse.class);
    }

    /**
     * Get wallet transaction history for a team.
     *
     * @param teamId the team UUID
     * @param limit  max number of transactions to return
     * @param offset pagination offset
     * @return transaction history
     * @throws DominusNodeException on API errors
     */
    public TeamTransactionsResponse getTransactions(String teamId, int limit, int offset)
            throws DominusNodeException {
        return http.get("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8)
                        + "/wallet/transactions?limit=" + limit + "&offset=" + offset,
                TeamTransactionsResponse.class);
    }

    /**
     * List all members of a team.
     *
     * @param teamId the team UUID
     * @return list of members
     * @throws DominusNodeException on API errors
     */
    public TeamMembersResponse listMembers(String teamId) throws DominusNodeException {
        return http.get("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8) + "/members",
                TeamMembersResponse.class);
    }

    /**
     * Add a member to a team.
     *
     * @param teamId the team UUID
     * @param email  the member's email address
     * @param role   the member's role (may be null for default)
     * @return the added member
     * @throws DominusNodeException on API errors
     */
    public TeamMember addMember(String teamId, String email, String role) throws DominusNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("email", email);
        if (role != null && !role.isEmpty()) {
            body.put("role", role);
        }
        return http.post("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8) + "/members",
                body, TeamMember.class);
    }

    /**
     * Add a member to a team with default role.
     *
     * @param teamId the team UUID
     * @param email  the member's email address
     * @return the added member
     * @throws DominusNodeException on API errors
     */
    public TeamMember addMember(String teamId, String email) throws DominusNodeException {
        return addMember(teamId, email, null);
    }

    /**
     * Update a member's role within a team.
     *
     * @param teamId the team UUID
     * @param userId the member's user UUID
     * @param role   the new role
     * @return the updated member
     * @throws DominusNodeException on API errors
     */
    public TeamMember updateMemberRole(String teamId, String userId, String role)
            throws DominusNodeException {
        return http.patch("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8)
                        + "/members/" + URLEncoder.encode(userId, StandardCharsets.UTF_8),
                Map.of("role", role), TeamMember.class);
    }

    /**
     * Remove a member from a team.
     *
     * @param teamId the team UUID
     * @param userId the member's user UUID
     * @throws DominusNodeException on API errors
     */
    public void removeMember(String teamId, String userId) throws DominusNodeException {
        http.delete("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8)
                + "/members/" + URLEncoder.encode(userId, StandardCharsets.UTF_8));
    }

    /**
     * Create an invite for a team.
     *
     * @param teamId the team UUID
     * @param email  the invitee's email address
     * @param role   the role to assign (may be null for default)
     * @return the created invite
     * @throws DominusNodeException on API errors
     */
    public TeamInvite createInvite(String teamId, String email, String role) throws DominusNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("email", email);
        if (role != null && !role.isEmpty()) {
            body.put("role", role);
        }
        return http.post("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8) + "/invites",
                body, TeamInvite.class);
    }

    /**
     * Create an invite for a team with default role.
     *
     * @param teamId the team UUID
     * @param email  the invitee's email address
     * @return the created invite
     * @throws DominusNodeException on API errors
     */
    public TeamInvite createInvite(String teamId, String email) throws DominusNodeException {
        return createInvite(teamId, email, null);
    }

    /**
     * List pending invites for a team.
     *
     * @param teamId the team UUID
     * @return list of pending invites
     * @throws DominusNodeException on API errors
     */
    public TeamInvitesResponse listInvites(String teamId) throws DominusNodeException {
        return http.get("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8) + "/invites",
                TeamInvitesResponse.class);
    }

    /**
     * Cancel a pending team invite.
     *
     * @param teamId   the team UUID
     * @param inviteId the invite UUID
     * @throws DominusNodeException on API errors
     */
    public void cancelInvite(String teamId, String inviteId) throws DominusNodeException {
        http.delete("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8)
                + "/invites/" + URLEncoder.encode(inviteId, StandardCharsets.UTF_8));
    }

    /**
     * Accept a team invite using the invite token.
     *
     * @param token the invite token
     * @return the new team member record
     * @throws DominusNodeException on API errors
     */
    public TeamMember acceptInvite(String token) throws DominusNodeException {
        return http.post("/api/teams/invites/" + URLEncoder.encode(token, StandardCharsets.UTF_8) + "/accept",
                Map.of(), TeamMember.class);
    }

    /**
     * Create a new API key for the team.
     *
     * @param teamId the team UUID
     * @param label  the key label
     * @return the created key (includes raw key, shown once)
     * @throws DominusNodeException on API errors
     */
    public TeamKeyCreateResponse createKey(String teamId, String label) throws DominusNodeException {
        return http.post("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8) + "/keys",
                Map.of("label", label), TeamKeyCreateResponse.class);
    }

    /**
     * List all API keys for a team.
     *
     * @param teamId the team UUID
     * @return list of team keys
     * @throws DominusNodeException on API errors
     */
    public TeamKeysResponse listKeys(String teamId) throws DominusNodeException {
        return http.get("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8) + "/keys",
                TeamKeysResponse.class);
    }

    /**
     * Revoke a team API key by its ID.
     *
     * @param teamId the team UUID
     * @param keyId  the API key UUID
     * @throws DominusNodeException on API errors
     */
    public void revokeKey(String teamId, String keyId) throws DominusNodeException {
        http.delete("/api/teams/" + URLEncoder.encode(teamId, StandardCharsets.UTF_8)
                + "/keys/" + URLEncoder.encode(keyId, StandardCharsets.UTF_8));
    }
}
