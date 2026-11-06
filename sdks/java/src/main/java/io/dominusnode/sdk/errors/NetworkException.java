package io.dominusnode.sdk.errors;

/** Transport failure (connection, timeout, refused redirect). */
public class NetworkException extends DominusNodeException {
    private static final long serialVersionUID = 2L;

    public NetworkException(String message) { super(message); }
}
