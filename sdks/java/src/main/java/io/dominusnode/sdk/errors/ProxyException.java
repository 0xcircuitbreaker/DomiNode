package io.dominusnode.sdk.errors;

/** proxy.fetch failure: blocked target, refused tunnel (statusCode), timeout. */
public class ProxyException extends DominusNodeException {
    private static final long serialVersionUID = 2L;

    public ProxyException(String message) { super(message); this.retryAfter = null; }

    public ProxyException(String message, Integer statusCode) { super(message, statusCode, null, null); this.retryAfter = null; }

    private final Integer retryAfter;

    /** Refused CONNECT: {@code code} from X-DominusNode-Error, {@code retryAfter} seconds from Retry-After (2.2). */
    public ProxyException(String message, Integer statusCode, String code, Integer retryAfter) {
        super(message, statusCode, code, null);
        this.retryAfter = retryAfter;
    }

    /** Seconds from the gateway's Retry-After header on a refused CONNECT, or null. */
    public Integer getRetryAfter() { return retryAfter; }
}
