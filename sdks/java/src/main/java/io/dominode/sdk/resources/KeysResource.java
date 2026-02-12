package io.dominode.sdk.resources;

import io.dominode.sdk.errors.DomiNodeException;
import io.dominode.sdk.internal.HttpClient;
import io.dominode.sdk.internal.JsonUtil;
import io.dominode.sdk.types.ApiKey;
import io.dominode.sdk.types.CreatedApiKey;

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
     * @throws DomiNodeException on API errors
     */
    public CreatedApiKey create(String label) throws DomiNodeException {
        Map<String, Object> body = new HashMap<>();
        body.put("label", label != null ? label : "Default");
        return http.post("/api/keys", body, CreatedApiKey.class);
    }

    /**
     * List all API keys for the authenticated user.
     *
     * @return list of API keys
     * @throws DomiNodeException on API errors
     */
    public List<ApiKey> list() throws DomiNodeException {
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
     * @throws DomiNodeException on API errors
     */
    public void revoke(String id) throws DomiNodeException {
        String encodedId = URLEncoder.encode(id, StandardCharsets.UTF_8);
        http.delete("/api/keys/" + encodedId);
    }
}
