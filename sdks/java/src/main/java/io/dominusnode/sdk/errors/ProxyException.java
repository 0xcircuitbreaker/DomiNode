package io.dominusnode.sdk.errors;

/** proxy.fetch failure: blocked target, refused tunnel (statusCode), timeout. */
public class ProxyException extends DominusNodeException {
    private static final long serialVersionUID = 2L;

    public ProxyException(String message) { super(message); }

    public ProxyException(String message, Integer statusCode) { super(message, statusCode, null, null); }
}
