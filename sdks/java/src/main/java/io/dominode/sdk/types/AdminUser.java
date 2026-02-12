package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * User information as seen by administrators.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class AdminUser {

    private final String id;
    private final String email;
    private final String status;
    private final boolean isAdmin;
    private final String createdAt;
    private final int balanceCents;

    @JsonCreator
    public AdminUser(
            @JsonProperty("id") String id,
            @JsonProperty("email") String email,
            @JsonProperty("status") String status,
            @JsonProperty("is_admin") boolean isAdmin,
            @JsonProperty("created_at") String createdAt,
            @JsonProperty("balance_cents") int balanceCents) {
        this.id = id;
        this.email = email;
        this.status = status;
        this.isAdmin = isAdmin;
        this.createdAt = createdAt;
        this.balanceCents = balanceCents;
    }

    /** User identifier. */
    public String getId() { return id; }

    /** User email. */
    public String getEmail() { return email; }

    /** Account status (e.g., "active", "suspended"). */
    public String getStatus() { return status; }

    /** Whether the user is an admin. */
    public boolean isAdmin() { return isAdmin; }

    /** Account creation timestamp. */
    public String getCreatedAt() { return createdAt; }

    /** Wallet balance in cents. */
    public int getBalanceCents() { return balanceCents; }

    @Override
    public String toString() {
        return "AdminUser{id='" + id + "', email='" + email + "', status='" + status + "'}";
    }
}
