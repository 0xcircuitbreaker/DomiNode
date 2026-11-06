package io.dominusnode.sdk.errors;

import java.util.Map;

/** HTTP 429 after the single retry. */
public class RateLimitException extends DominusNodeException {
    private static final long serialVersionUID = 2L;
    private final long retryAfterSeconds;

    public RateLimitException(String message, long retryAfterSeconds, String code, Map<String, Object> details) {
        super(message, 429, code, details);
        this.retryAfterSeconds = retryAfterSeconds;
    }

    public long getRetryAfterSeconds() { return retryAfterSeconds; }
}
