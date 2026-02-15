package io.dominusnode.sdk.errors;

/**
 * Thrown when the server returns a 5xx error.
 */
public class ServerException extends DominusNodeException {

    public ServerException(String message) {
        super(message, 500);
    }

    public ServerException(String message, int statusCode) {
        super(message, statusCode);
    }
}
