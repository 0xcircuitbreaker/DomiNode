package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;
import io.dominusnode.sdk.internal.Validation;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static io.dominusnode.sdk.internal.Validation.body;
import static io.dominusnode.sdk.internal.Validation.seg;

/** Sessions. */
public final class SessionsResource {
    public static final List<String> REPORT_REASONS =
            List.of("blocked", "captcha", "rate_limited", "slow", "bad_content", "other");
    private final ApiClient http;

    public SessionsResource(ApiClient http) { this.http = http; }

    /** Active session. Deliberately has NO proxy/node IP field. */
    public static final class ActiveSession {
        public final String id;
        public final String startedAt;
        public final String status;

        public ActiveSession(String id, String startedAt, String status) {
            this.id = id;
            this.startedAt = startedAt;
            this.status = status;
        }

        @Override
        public String toString() { return "ActiveSession(id=" + id + ", startedAt=" + startedAt + ", status=" + status + ")"; }
    }

    /** GET /api/sessions/active [jwt]; fields are whitelisted (id, startedAt, status). */
    public List<ActiveSession> getActive() {
        JsonNode r = http.get("/api/sessions/active", Auth.JWT);
        List<ActiveSession> out = new ArrayList<>();
        for (JsonNode s : r.path("sessions")) {
            out.add(new ActiveSession(s.path("id").asText(null), s.path("startedAt").asText(null), s.path("status").asText(null)));
        }
        return Collections.unmodifiableList(out);
    }

    /** POST /v1/sessions/{id}/report [agent] -> {reportId, reportsToday, limitPerDay}. */
    public JsonNode report(String sessionId, String reason) {
        Validation.uuid(sessionId, "sessionId");
        if (!REPORT_REASONS.contains(reason)) throw Validation.invalid("reason must be one of " + String.join(", ", REPORT_REASONS));
        return http.post("/v1/sessions/" + seg(sessionId) + "/report", body("reason", reason), Auth.AGENT);
    }
}
