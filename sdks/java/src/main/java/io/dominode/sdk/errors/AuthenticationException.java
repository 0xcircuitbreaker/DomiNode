package io.dominode.sdk.errors;

/**
 * Thrown when authentication fails (HTTP 401).
 */
public class AuthenticationException extends DomiNodeException {

    public AuthenticationException(String message) {
        super(message, 401);
    }

    public AuthenticationException(String message, Throwable cause) {
        super(message, 401, cause);
    }
}
