package io.dominode.sdk.errors;

/**
 * Thrown when request validation fails (HTTP 400).
 */
public class ValidationException extends DomiNodeException {

    public ValidationException(String message) {
        super(message, 400);
    }
}
