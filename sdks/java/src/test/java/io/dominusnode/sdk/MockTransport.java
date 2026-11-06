package io.dominusnode.sdk;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Scripted transport: returns queued responses (default 200 "{}") and records requests. */
final class MockTransport implements Transport {
    static final ObjectMapper M = new ObjectMapper();
    final Deque<Response> queue = new ArrayDeque<>();
    final List<Request> requests = new ArrayList<>();
    final List<TrackedStream> streams = new ArrayList<>();

    static final class TrackedStream extends ByteArrayInputStream {
        boolean closed;
        int reads;

        TrackedStream(byte[] b) { super(b); }

        @Override
        public synchronized int read(byte[] b, int off, int len) { reads++; return super.read(b, off, len); }

        @Override
        public void close() throws IOException { closed = true; super.close(); }
    }

    MockTransport reply(int status, String body, String... headers) {
        Map<String, List<String>> h = new HashMap<>();
        for (int i = 0; i + 1 < headers.length; i += 2) h.put(headers[i], List.of(headers[i + 1]));
        TrackedStream s = new TrackedStream(body.getBytes(StandardCharsets.UTF_8));
        streams.add(s);
        queue.add(new Response(status, h, s));
        return this;
    }

    MockTransport replyStream(int status, InputStream body, String... headers) {
        Map<String, List<String>> h = new HashMap<>();
        for (int i = 0; i + 1 < headers.length; i += 2) h.put(headers[i], List.of(headers[i + 1]));
        queue.add(new Response(status, h, body));
        return this;
    }

    @Override
    public Response send(Request r) {
        requests.add(r);
        Response next = queue.poll();
        if (next != null) return next;
        return new Response(200, Map.of(), new ByteArrayInputStream("{}".getBytes(StandardCharsets.UTF_8)));
    }

    Request last() { return requests.get(requests.size() - 1); }

    static JsonNode json(Request r) {
        try {
            return r.body == null ? null : M.readTree(r.body);
        } catch (IOException e) {
            throw new AssertionError(e);
        }
    }

    static String path(Request r) { return r.url.substring("https://api.test".length()); }

    static String auth(Request r) { return r.headers.get("Authorization"); }
}
