package io.dominode.sdk.errors;

/**
 * Thrown when a network-level error occurs (connection refused, timeout, DNS failure, etc.).
 */
public class NetworkException extends DomiNodeException {

    public NetworkException(String message) {
        super(message, 0);
    }

    public NetworkException(String message, Throwable cause) {
        super(message, 0, cause);
    }
}
