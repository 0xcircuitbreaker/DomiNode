package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Wrapper for a single admin user detail response.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class AdminUserDetail {

    private final AdminUser user;

    @JsonCreator
    public AdminUserDetail(
            @JsonProperty("user") AdminUser user) {
        this.user = user;
    }

    /** The user details. */
    public AdminUser getUser() { return user; }

    @Override
    public String toString() {
        return "AdminUserDetail{user=" + user + "}";
    }
}
