package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Represents a DomiNode user account.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class User {

    private final String id;
    private final String email;
    private final boolean isAdmin;
    private final String createdAt;

    @JsonCreator
    public User(
            @JsonProperty("id") String id,
            @JsonProperty("email") String email,
            @JsonProperty("is_admin") boolean isAdmin,
            @JsonProperty("created_at") String createdAt) {
        this.id = id;
        this.email = email;
        this.isAdmin = isAdmin;
        this.createdAt = createdAt;
    }

    /** Unique user identifier. */
    public String getId() { return id; }

    /** User email address. */
    public String getEmail() { return email; }

    /** Whether the user has admin privileges. */
    public boolean isAdmin() { return isAdmin; }

    /** ISO 8601 timestamp of account creation. */
    public String getCreatedAt() { return createdAt; }

    @Override
    public String toString() {
        return "User{id='" + id + "', email='" + email + "', isAdmin=" + isAdmin + "}";
    }
}
