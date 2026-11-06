package io.dominusnode.sdk.errors;

import java.util.Collections;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Base SDK exception (unchecked). Every message passes through {@link #scrub(String)} so API keys
 * (dn_live_/dn_test_/dn_node_/dn_proxy_) and JWTs never reach logs or callers via error strings.
 */
public class DominusNodeException extends RuntimeException {
    private static final long serialVersionUID = 2L;
    private static final Pattern KEY_RE = Pattern.compile("dn_(?:live|test|node|proxy)_[A-Za-z0-9_-]+");
    private static final Pattern JWT_RE = Pattern.compile("eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*");

    private final Integer statusCode;
    private final String code;
    private final Map<String, Object> details;

    public DominusNodeException(String message) {
        this(message, null, null, null);
    }

    public DominusNodeException(String message, Integer statusCode, String code, Map<String, Object> details) {
        super(scrub(message));
        this.statusCode = statusCode;
        this.code = code;
        this.details = details == null ? null : Collections.unmodifiableMap(details);
    }

    /** Replace credential patterns with [REDACTED]. */
    public static String scrub(String message) {
        if (message == null) return "";
        String out = KEY_RE.matcher(message).replaceAll("[REDACTED]");
        return JWT_RE.matcher(out).replaceAll("[REDACTED]");
    }

    /** HTTP status, or null for client-side/transport errors. */
    public Integer getStatusCode() { return statusCode; }

    /** Server error code (e.g. INVALID_CHALLENGE), or INVALID_ARGUMENT for client-side checks. */
    public String getCode() { return code; }

    /** Extra fields the server sent ({@code max}, {@code cap}, {@code limitPerDay}), or null. */
    public Map<String, Object> getDetails() { return details; }
}
