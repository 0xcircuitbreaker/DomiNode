package io.dominode.sdk.resources;

import io.dominode.sdk.errors.DomiNodeException;
import io.dominode.sdk.internal.HttpClient;
import io.dominode.sdk.internal.JsonUtil;
import io.dominode.sdk.types.ActiveSession;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * Active proxy session management.
 */
public final class SessionsResource {

    private final HttpClient http;

    /**
     * @param http the HTTP client
     */
    public SessionsResource(HttpClient http) {
        this.http = http;
    }

    /**
     * Get all active proxy sessions for the authenticated user.
     *
     * @return list of active sessions
     * @throws DomiNodeException on API errors
     */
    public List<ActiveSession> getActive() throws DomiNodeException {
        // Server returns { sessions: [...] }
        Map<?, ?> raw = http.get("/api/sessions/active", Map.class);
        String json = JsonUtil.toJson(raw.get("sessions"));
        ActiveSession[] sessions = JsonUtil.fromJson(json, ActiveSession[].class);
        return Arrays.asList(sessions);
    }
}
