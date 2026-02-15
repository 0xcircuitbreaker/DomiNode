package io.dominusnode.sdk.errors;

/**
 * Thrown when request validation fails (HTTP 400).
 */
public class ValidationException extends DominusNodeException {

    public ValidationException(String message) {
        super(message, 400);
    }
}
