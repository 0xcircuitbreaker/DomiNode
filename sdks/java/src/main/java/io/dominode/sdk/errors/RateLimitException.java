package io.dominode.sdk.errors;

/**
 * Thrown when the API rate limit is exceeded (HTTP 429).
 */
public class RateLimitException extends DomiNodeException {

    private final int retryAfterSeconds;

    /**
     * @param message           error message
     * @param retryAfterSeconds number of seconds the client should wait before retrying
     */
    public RateLimitException(String message, int retryAfterSeconds) {
        super(message, 429);
        this.retryAfterSeconds = retryAfterSeconds;
    }

    /**
     * Suggested wait time before the next request.
     *
     * @return seconds to wait
     */
    public int getRetryAfterSeconds() {
        return retryAfterSeconds;
    }
}
