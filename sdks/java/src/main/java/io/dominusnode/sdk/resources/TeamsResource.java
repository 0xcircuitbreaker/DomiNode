package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.Secret;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;
import io.dominusnode.sdk.internal.Validation;

import static io.dominusnode.sdk.internal.Validation.body;
import static io.dominusnode.sdk.internal.Validation.qs;
import static io.dominusnode.sdk.internal.Validation.seg;

/** Teams (/api/teams, jwt). 18 methods. */
public final class TeamsResource {
    private static final String BASE = "/api/teams";
    private final ApiClient http;

    public TeamsResource(ApiClient http) { this.http = http; }

    /** A new team key; {@code key} is returned once and prints as [REDACTED]. */
    public static final class CreatedTeamKey {
        public final String id;
        /** Server field {@code prefix} (legacy {@code keyPrefix} accepted). */
        public final String prefix;
        /** @deprecated use {@link #prefix}; kept as an alias. */
        @Deprecated
        public final String keyPrefix;
        public final String label;
        public final String createdAt;
        public final Secret key;

        CreatedTeamKey(JsonNode r) {
            id = r.path("id").asText(null);
            prefix = prefixOf(r);
            keyPrefix = prefix;
            label = r.path("label").asText(null);
            createdAt = r.path("createdAt").isTextual() ? r.get("createdAt").asText() : null;
            key = new Secret(r.path("key").asText(""));
        }

        @Override
        public String toString() { return "CreatedTeamKey(id=" + id + ", prefix=" + prefix + ", key=[REDACTED])"; }
    }

    static String prefixOf(JsonNode r) {
        if (r.path("prefix").isTextual()) return r.get("prefix").asText();
        if (r.path("keyPrefix").isTextual()) return r.get("keyPrefix").asText();
        return null;
    }

    private static String t(String teamId) { return BASE + "/" + seg(teamId); }

    public JsonNode create(String name) { return create(name, null); }

    public JsonNode create(String name, Integer maxMembers) {
        return http.post(BASE, body("name", name, "maxMembers", maxMembers), Auth.JWT);
    }

    public JsonNode list() { return http.get(BASE, Auth.JWT); }

    public JsonNode get(String teamId) { return http.get(t(teamId), Auth.JWT); }

    /** PATCH /{teamId}; null arguments are omitted. */
    public JsonNode update(String teamId, String name, Integer maxMembers) {
        return http.patch(t(teamId), body("name", name, "maxMembers", maxMembers), Auth.JWT);
    }

    public JsonNode delete(String teamId) { return http.delete(t(teamId), Auth.JWT); }

    public JsonNode fundWallet(String teamId, long amountCents) {
        Validation.cents(amountCents, "amountCents", false);
        return http.post(t(teamId) + "/wallet/fund", body("amountCents", amountCents), Auth.JWT);
    }

    public JsonNode getTransactions(String teamId) { return getTransactions(teamId, null, null); }

    public JsonNode getTransactions(String teamId, Integer limit, Integer offset) {
        return http.get(t(teamId) + "/wallet/transactions" + qs("limit", limit, "offset", offset), Auth.JWT);
    }

    public JsonNode listMembers(String teamId) { return http.get(t(teamId) + "/members", Auth.JWT); }

    public JsonNode addMember(String teamId, String email) { return addMember(teamId, email, null); }

    public JsonNode addMember(String teamId, String email, String role) {
        return http.post(t(teamId) + "/members", body("email", email, "role", role), Auth.JWT);
    }

    public JsonNode updateMemberRole(String teamId, String userId, String role) {
        return http.patch(t(teamId) + "/members/" + seg(userId), body("role", role), Auth.JWT);
    }

    public void removeMember(String teamId, String userId) {
        http.delete(t(teamId) + "/members/" + seg(userId), Auth.JWT);
    }

    public JsonNode createInvite(String teamId, String email) { return createInvite(teamId, email, null); }

    public JsonNode createInvite(String teamId, String email, String role) {
        return http.post(t(teamId) + "/invites", body("email", email, "role", role), Auth.JWT);
    }

    public JsonNode listInvites(String teamId) { return http.get(t(teamId) + "/invites", Auth.JWT); }

    public void cancelInvite(String teamId, String inviteId) {
        http.delete(t(teamId) + "/invites/" + seg(inviteId), Auth.JWT);
    }

    public JsonNode acceptInvite(String token) {
        return http.post(BASE + "/invites/" + seg(token) + "/accept", body(), Auth.JWT);
    }

    /** POST /{teamId}/keys {label} (1..100). */
    public CreatedTeamKey createKey(String teamId, String label) {
        Validation.nonEmpty(label, "label", 100);
        return new CreatedTeamKey(http.post(t(teamId) + "/keys", body("label", label), Auth.JWT));
    }

    /**
     * GET /{teamId}/keys -> {keys: [{id, prefix, label, userId, teamId, createdAt, revokedAt}]}. A legacy
     * {@code keyPrefix} is copied to {@code prefix}.
     */
    public JsonNode listKeys(String teamId) {
        JsonNode r = http.get(t(teamId) + "/keys", Auth.JWT);
        JsonNode keys = r == null ? null : r.get("keys");
        if (keys != null && keys.isArray()) {
            for (JsonNode k : keys) {
                if (k instanceof com.fasterxml.jackson.databind.node.ObjectNode && !k.path("prefix").isTextual()) {
                    String p = prefixOf(k);
                    if (p != null) ((com.fasterxml.jackson.databind.node.ObjectNode) k).put("prefix", p);
                }
            }
        }
        return r;
    }

    public void revokeKey(String teamId, String keyId) {
        http.delete(t(teamId) + "/keys/" + seg(keyId), Auth.JWT);
    }
}
