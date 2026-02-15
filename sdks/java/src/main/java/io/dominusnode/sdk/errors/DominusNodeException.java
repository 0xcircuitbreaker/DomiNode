package io.dominusnode.sdk.errors;

/**
 * Base exception for all Dominus Node SDK errors.
 *
 * <p>All SDK-specific exceptions extend this class. The {@code statusCode} field
 * carries the HTTP status code when the error originated from a server response.</p>
 */
public class DominusNodeException extends Exception {

    private final int statusCode;

    /**
     * Create a new Dominus Node exception.
     *
     * @param message    human-readable error message
     * @param statusCode HTTP status code, or 0 if not applicable
     */
    public DominusNodeException(String message, int statusCode) {
        super(message);
        this.statusCode = statusCode;
    }

    /**
     * Create a new Dominus Node exception with a cause.
     *
     * @param message    human-readable error message
     * @param statusCode HTTP status code, or 0 if not applicable
     * @param cause      the underlying cause
     */
    public DominusNodeException(String message, int statusCode, Throwable cause) {
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
