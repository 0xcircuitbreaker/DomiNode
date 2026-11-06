package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;
import io.dominusnode.sdk.internal.Validation;

import static io.dominusnode.sdk.internal.Validation.body;

/** Token plumbing. Human email/password, registration and MFA flows are not in the SDK. */
public final class AuthResource {
    private final ApiClient http;

    public AuthResource(ApiClient http) { this.http = http; }

    /** POST /api/auth/verify-key [none] -> {valid, token, refreshToken, userId, email}. */
    public JsonNode verifyKey(String apiKey) {
        return http.post("/api/auth/verify-key", body("apiKey", Validation.apiKey(apiKey)), Auth.NONE);
    }

    /** POST /api/auth/refresh [none] -> {token, refreshToken?}. */
    public JsonNode refresh(String refreshToken) {
        if (refreshToken == null || refreshToken.isEmpty()) throw Validation.invalid("refreshToken is required");
        return http.post("/api/auth/refresh", body("refreshToken", refreshToken), Auth.NONE);
    }

    /** POST /api/auth/logout [jwt]. */
    public void logout() {
        http.post("/api/auth/logout", body(), Auth.JWT);
    }

    /** GET /api/auth/me [jwt] -> {user}. */
    public JsonNode me() {
        return http.get("/api/auth/me", Auth.JWT);
    }
}
