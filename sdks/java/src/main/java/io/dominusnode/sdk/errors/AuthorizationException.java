package io.dominusnode.sdk.errors;

/**
 * Thrown when the user lacks permission for the requested action (HTTP 403).
 */
public class AuthorizationException extends DominusNodeException {

    public AuthorizationException(String message) {
        super(message, 403);
    }
}
