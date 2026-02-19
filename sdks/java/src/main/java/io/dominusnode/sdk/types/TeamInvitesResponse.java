package io.dominusnode.sdk.types;

import java.util.List;

/**
 * Response from listing team invites.
 */
public final class TeamInvitesResponse {

    private List<TeamInvite> invites;

    public List<TeamInvite> getInvites() { return invites; }
}
