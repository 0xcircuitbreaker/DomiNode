package io.dominusnode.sdk.errors;

/**
 * Thrown when authentication fails (HTTP 401).
 */
public class AuthenticationException extends DominusNodeException {

    public AuthenticationException(String message) {
        super(message, 401);
    }

    public AuthenticationException(String message, Throwable cause) {
        super(message, 401, cause);
    }
}
