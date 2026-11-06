package io.dominusnode.sdk;

import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Pluggable HTTP transport (tests, instrumentation). Implementations MUST NOT follow redirects.
 * The default is {@link JdkTransport} (java.net.http, Redirect.NEVER, 30 s timeout).
 */
@FunctionalInterface
public interface Transport {

    Response send(Request request) throws IOException, InterruptedException;

    /** Outgoing request. {@code body} is null when none is sent. */
    final class Request {
        public final String method;
        public final String url;
        public final Map<String, String> headers;
        public final String body;

        public Request(String method, String url, Map<String, String> headers, String body) {
            this.method = method;
            this.url = url;
            this.headers = headers;
            this.body = body;
        }

        @Override
        public String toString() { return method + " " + url; }
    }

    /** Incoming response. The SDK closes {@code body}. Header names are matched case-insensitively. */
    final class Response {
        public final int status;
        public final Map<String, List<String>> headers;
        public final InputStream body;

        public Response(int status, Map<String, List<String>> headers, InputStream body) {
            this.status = status;
            this.headers = headers;
            this.body = body;
        }

        public Optional<String> header(String name) {
            if (headers == null) return Optional.empty();
            for (Map.Entry<String, List<String>> e : headers.entrySet()) {
                if (e.getKey() != null && e.getKey().equalsIgnoreCase(name) && e.getValue() != null && !e.getValue().isEmpty()) {
                    return Optional.of(e.getValue().get(0));
                }
            }
            return Optional.empty();
        }
    }
}
