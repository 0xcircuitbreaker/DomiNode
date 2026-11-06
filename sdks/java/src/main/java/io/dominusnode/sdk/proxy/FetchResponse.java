package io.dominusnode.sdk.proxy;

import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Map;

/** Result of proxy.fetch. 3xx responses are returned as-is (never followed). */
public final class FetchResponse {
    public final int status;
    public final String statusText;
    /** Lowercased header names; repeated headers joined with ", ". */
    public final Map<String, String> headers;
    /** Raw body (at most maxBytes). */
    public final byte[] body;
    /** True when the body was cut at maxBytes. */
    public final boolean truncated;

    public FetchResponse(int status, String statusText, Map<String, String> headers, byte[] body, boolean truncated) {
        this.status = status;
        this.statusText = statusText;
        this.headers = Collections.unmodifiableMap(headers);
        this.body = body;
        this.truncated = truncated;
    }

    /** Body decoded as UTF-8. */
    public String text() { return new String(body, StandardCharsets.UTF_8); }

    @Override
    public String toString() { return "FetchResponse(" + status + ", " + body.length + " bytes" + (truncated ? ", truncated" : "") + ")"; }
}
