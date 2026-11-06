package io.dominusnode.sdk.errors;

/** Server data the SDK refuses to act on (message mismatch, bad challenge, bad node key) or a signer failure. */
public class ProtocolException extends DominusNodeException {
    private static final long serialVersionUID = 2L;

    public ProtocolException(String message) { super(message); }
}
