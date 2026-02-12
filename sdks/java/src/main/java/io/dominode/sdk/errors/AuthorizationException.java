package io.dominode.sdk.errors;

/**
 * Thrown when the user lacks permission for the requested action (HTTP 403).
 */
public class AuthorizationException extends DomiNodeException {

    public AuthorizationException(String message) {
        super(message, 403);
    }
}
