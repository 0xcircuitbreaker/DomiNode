package io.dominusnode.sdk.errors;

/**
 * Thrown when a resource conflict occurs (HTTP 409), such as duplicate registration.
 */
public class ConflictException extends DominusNodeException {

    public ConflictException(String message) {
        super(message, 409);
    }
}
