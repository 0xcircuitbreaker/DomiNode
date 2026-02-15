package io.dominusnode.sdk.resources;

import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.internal.HttpClient;
import io.dominusnode.sdk.internal.JsonUtil;
import io.dominusnode.sdk.types.ActiveSession;

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
     * @throws DominusNodeException on API errors
     */
    public List<ActiveSession> getActive() throws DominusNodeException {
        // Server returns { sessions: [...] }
        Map<?, ?> raw = http.get("/api/sessions/active", Map.class);
        String json = JsonUtil.toJson(raw.get("sessions"));
        ActiveSession[] sessions = JsonUtil.fromJson(json, ActiveSession[].class);
        return Arrays.asList(sessions);
    }
}
