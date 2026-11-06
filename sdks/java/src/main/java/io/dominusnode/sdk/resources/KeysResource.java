package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.Secret;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;
import io.dominusnode.sdk.internal.Validation;

import static io.dominusnode.sdk.internal.Validation.body;
import static io.dominusnode.sdk.internal.Validation.seg;

/** API keys (/api/keys, jwt). */
public final class KeysResource {
    private final ApiClient http;

    public KeysResource(ApiClient http) { this.http = http; }

    /** A newly created key. {@code key} is returned once and prints as [REDACTED]. */
    public static final class CreatedKey {
        public final String id;
        public final String prefix;
        public final String label;
        public final String createdAt;
        public final Secret key;

        CreatedKey(JsonNode r) {
            id = r.path("id").asText(null);
            prefix = r.path("prefix").asText(null);
            label = r.path("label").asText(null);
            createdAt = r.path("created_at").asText(null);
            key = new Secret(r.path("key").asText(""));
        }

        @Override
        public String toString() { return "CreatedKey(id=" + id + ", prefix=" + prefix + ", label=" + label + ", key=[REDACTED])"; }
    }

    public CreatedKey create() { return create("Default"); }

    /** POST /api/keys {label} (1..100 chars). */
    public CreatedKey create(String label) {
        Validation.nonEmpty(label, "label", 100);
        return new CreatedKey(http.post("/api/keys", body("label", label), Auth.JWT));
    }

    /** GET /api/keys -> {keys}. */
    public JsonNode list() { return http.get("/api/keys", Auth.JWT); }

    /** DELETE /api/keys/{id}. */
    public void revoke(String id) {
        http.delete("/api/keys/" + seg(Validation.nonEmpty(id, "id", 256)), Auth.JWT);
    }
}
