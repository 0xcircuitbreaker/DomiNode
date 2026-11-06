package io.dominusnode.sdk;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;

/** Default transport: java.net.http with redirects disabled and a 30 s timeout. */
public final class JdkTransport implements Transport {
    private static final Duration TIMEOUT = Duration.ofSeconds(30);
    private final HttpClient client;

    public JdkTransport() {
        this.client = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(TIMEOUT)
                .build();
    }

    @Override
    public Response send(Request r) throws IOException, InterruptedException {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(r.url)).timeout(TIMEOUT);
        for (Map.Entry<String, String> h : r.headers.entrySet()) b.header(h.getKey(), h.getValue());
        b.method(r.method, r.body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(r.body));
        HttpResponse<java.io.InputStream> res = client.send(b.build(), HttpResponse.BodyHandlers.ofInputStream());
        return new Response(res.statusCode(), res.headers().map(), res.body());
    }

    @Override
    public String toString() { return "JdkTransport"; }
}
