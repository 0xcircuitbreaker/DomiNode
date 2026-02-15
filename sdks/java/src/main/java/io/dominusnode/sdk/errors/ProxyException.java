package io.dominusnode.sdk.errors;

/**
 * Thrown when a proxy-specific error occurs (e.g., upstream provider failure).
 */
public class ProxyException extends DominusNodeException {

    private final String proxyErrorCode;

    /**
     * @param message        error message
     * @param proxyErrorCode optional proxy-specific error code
     */
    public ProxyException(String message, String proxyErrorCode) {
        super(message, 0);
        this.proxyErrorCode = proxyErrorCode;
    }

    /**
     * Proxy-specific error code, or {@code null}.
     *
     * @return the error code
     */
    public String getProxyErrorCode() {
        return proxyErrorCode;
    }
}
