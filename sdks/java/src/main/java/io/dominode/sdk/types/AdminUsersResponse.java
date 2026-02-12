package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Collections;
import java.util.List;

/**
 * Paginated list of users for admin view.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class AdminUsersResponse {

    private final List<AdminUser> users;
    private final Pagination pagination;

    @JsonCreator
    public AdminUsersResponse(
            @JsonProperty("users") List<AdminUser> users,
            @JsonProperty("pagination") Pagination pagination) {
        this.users = users != null ? Collections.unmodifiableList(users) : Collections.emptyList();
        this.pagination = pagination;
    }

    /** List of users on this page. */
    public List<AdminUser> getUsers() { return users; }

    /** Pagination metadata. */
    public Pagination getPagination() { return pagination; }

    @Override
    public String toString() {
        return "AdminUsersResponse{users=" + users.size() + " items, pagination=" + pagination + "}";
    }
}
