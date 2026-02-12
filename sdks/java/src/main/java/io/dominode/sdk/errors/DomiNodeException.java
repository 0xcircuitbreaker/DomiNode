package io.dominode.sdk.errors;

/**
 * Base exception for all DomiNode SDK errors.
 *
 * <p>All SDK-specific exceptions extend this class. The {@code statusCode} field
 * carries the HTTP status code when the error originated from a server response.</p>
 */
public class DomiNodeException extends Exception {

    private final int statusCode;

    /**
     * Create a new DomiNode exception.
     *
     * @param message    human-readable error message
     * @param statusCode HTTP status code, or 0 if not applicable
     */
    public DomiNodeException(String message, int statusCode) {
        super(message);
        this.statusCode = statusCode;
    }

    /**
     * Create a new DomiNode exception with a cause.
     *
     * @param message    human-readable error message
     * @param statusCode HTTP status code, or 0 if not applicable
     * @param cause      the underlying cause
     */
    public DomiNodeException(String message, int statusCode, Throwable cause) {
        super(message, cause);
        this.statusCode = statusCode;
    }

    /**
     * The HTTP status code associated with this error.
     *
     * @return the status code, or 0 if not applicable
     */
    public int getStatusCode() {
        return statusCode;
    }
}
