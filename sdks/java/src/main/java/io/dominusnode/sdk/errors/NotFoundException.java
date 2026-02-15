package io.dominusnode.sdk.errors;

/**
 * Thrown when the requested resource is not found (HTTP 404).
 */
public class NotFoundException extends DominusNodeException {

    public NotFoundException(String message) {
        super(message, 404);
    }
}
