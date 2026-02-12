package io.dominode.sdk.errors;

/**
 * Thrown when a resource conflict occurs (HTTP 409), such as duplicate registration.
 */
public class ConflictException extends DomiNodeException {

    public ConflictException(String message) {
        super(message, 409);
    }
}
