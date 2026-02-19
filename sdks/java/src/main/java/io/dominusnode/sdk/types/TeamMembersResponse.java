package io.dominusnode.sdk.types;

import java.util.List;

/**
 * Response from listing team members.
 */
public final class TeamMembersResponse {

    private List<TeamMember> members;

    public List<TeamMember> getMembers() { return members; }
}
