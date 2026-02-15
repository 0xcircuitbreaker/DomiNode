package io.dominusnode.sdk.resources;

import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.internal.HttpClient;
import io.dominusnode.sdk.internal.JsonUtil;
import io.dominusnode.sdk.types.ApiKey;
import io.dominusnode.sdk.types.CreatedApiKey;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * API key management: create, list, and revoke API keys.
 */
public final class KeysResource {

    private final HttpClient http;

    /**
     * @param http the HTTP client
     */
    public KeysResource(HttpClient http) {
        this.http = http;
    }

    /**
     * Create a new API key. The raw key value is only returned once.
     *
     * @param label a user-friendly label for the key
     * @return the created key with its raw value
     * @throws DominusNodeException on API errors
     */
    public CreatedApiKey create(String label) throws DominusNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("label", label != null ? label : "Default");
        return http.post("/api/keys", body, CreatedApiKey.class);
    }

    /**
     * List all API keys for the authenticated user.
     *
     * @return list of API keys
     * @throws DominusNodeException on API errors
     */
    public List<ApiKey> list() throws DominusNodeException {
        // Server returns { keys: [...] }
        Map<?, ?> raw = http.get("/api/keys", Map.class);
        String json = JsonUtil.toJson(raw.get("keys"));
        ApiKey[] keys = JsonUtil.fromJson(json, ApiKey[].class);
        return Arrays.asList(keys);
    }

    /**
     * Revoke an API key by its ID.
     *
     * @param id the key ID to revoke
     * @throws DominusNodeException on API errors
     */
    public void revoke(String id) throws DominusNodeException {
        String encodedId = URLEncoder.encode(id, StandardCharsets.UTF_8);
        http.delete("/api/keys/" + encodedId);
    }
}
