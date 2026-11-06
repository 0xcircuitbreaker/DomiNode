package io.dominusnode.sdk.proxy;

import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.errors.ProxyException;
import io.dominusnode.sdk.internal.Validation;

import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * GET/HEAD through the relay gateway over raw sockets. https uses a CONNECT tunnel with TLS (>= 1.2,
 * certificate + hostname verification, SNI); http uses an absolute-URI request line. Redirects are
 * never followed. Internal: use {@code client.proxy().fetch(...)}.
 */
public final class ProxyFetcher {
    private ProxyFetcher() {}

    private static final Set<String> FORBIDDEN = Set.of("host", "connection", "content-length", "transfer-encoding",
            "proxy-authorization", "proxy-connection", "authorization", "upgrade", "te", "trailer", "keep-alive");
    private static final String TOKEN_RE = "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$";
    private static final int MAX_HEADER_BYTES = 64 * 1024;

    static Map<String, String> cleanHeaders(Map<String, String> h) {
        Map<String, String> out = new LinkedHashMap<>();
        for (Map.Entry<String, String> e : h.entrySet()) {
            String k = e.getKey();
            String v = e.getValue();
            if (k == null || v == null || k.matches("(?s).*[\r\n\0].*") || v.matches("(?s).*[\r\n\0].*") || !k.matches(TOKEN_RE)) {
                String shown = String.valueOf(k);
                throw Validation.invalid("header \"" + shown.substring(0, Math.min(40, shown.length())) + "\" contains invalid characters");
            }
            if (!FORBIDDEN.contains(k.toLowerCase(Locale.ROOT))) out.put(k, v);
        }
        return out;
    }

    public static FetchResponse fetch(String proxyHost, int proxyPort, HostResolver resolver, String apiKey, String url, ProxyOptions o) {
        String method = (o.method == null ? "GET" : o.method).toUpperCase(Locale.ROOT);
        if (!method.equals("GET") && !method.equals("HEAD")) throw Validation.invalid("proxy.fetch only allows GET and HEAD");
        URI target = Ssrf.validateTargetUrl(url);
        boolean https = target.getScheme().equalsIgnoreCase("https");
        if (!https && !o.allowHttp) {
            throw Validation.invalid("plaintext http:// requires allowHttp(true) (the exit node can read and modify it); prefer https://");
        }
        String username = o.buildUsername();
        Map<String, String> headers = cleanHeaders(o.headers);
        int timeoutMs = Math.min(Math.max(o.timeoutMs, 1), ProxyOptions.MAX_TIMEOUT_MS);
        int maxBytes = Math.min(Math.max(o.maxBytes, 1), ProxyOptions.MAX_BYTES);
        String host = Ssrf.hostOf(target);
        Ssrf.assertPublicResolution(host, resolver);

        String proxyAuth = "Basic " + Base64.getEncoder().encodeToString((username + ":" + apiKey).getBytes(StandardCharsets.UTF_8));
        int port = target.getPort() != -1 ? target.getPort() : (https ? 443 : 80);
        String hostHeader = target.getPort() != -1 ? host + ":" + port : host;
        long deadline = System.currentTimeMillis() + timeoutMs;

        try (Socket raw = new Socket(Proxy.NO_PROXY)) {
            raw.connect(new InetSocketAddress(proxyHost, proxyPort), timeoutMs);
            raw.setSoTimeout(timeoutMs);
            Socket sock = raw;
            String requestTarget;
            if (https) {
                String authority = host + ":" + port;
                OutputStream out = raw.getOutputStream();
                out.write(("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\nProxy-Authorization: " + proxyAuth + "\r\n\r\n")
                        .getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
                InputStream in = new BufferedInputStream(raw.getInputStream());
                Head head = readHead(in, deadline);
                if (head.status != 200) throw new ProxyException("Proxy refused CONNECT (HTTP " + head.status + ")", head.status);
                String sni = host.startsWith("[") ? host.substring(1, host.length() - 1) : host;
                SSLSocket tls = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, sni, port, true);
                SSLParameters params = tls.getSSLParameters();
                params.setEndpointIdentificationAlgorithm("HTTPS");
                if (!sni.contains(":") && Ssrf.normalizeIpv4(sni) == null) params.setServerNames(List.of(new SNIHostName(sni)));
                List<String> protos = new ArrayList<>();
                for (String p : tls.getSupportedProtocols()) if (p.equals("TLSv1.2") || p.equals("TLSv1.3")) protos.add(p);
                params.setProtocols(protos.toArray(new String[0]));
                tls.setSSLParameters(params);
                tls.setSoTimeout(timeoutMs);
                tls.startHandshake();
                sock = tls;
                String path = target.getRawPath() == null || target.getRawPath().isEmpty() ? "/" : target.getRawPath();
                requestTarget = path + (target.getRawQuery() != null ? "?" + target.getRawQuery() : "");
            } else {
                String path = target.getRawPath() == null || target.getRawPath().isEmpty() ? "/" : target.getRawPath();
                requestTarget = "http://" + hostHeader + path + (target.getRawQuery() != null ? "?" + target.getRawQuery() : "");
            }
            StringBuilder req = new StringBuilder();
            req.append(method).append(' ').append(requestTarget).append(" HTTP/1.1\r\n");
            for (Map.Entry<String, String> e : headers.entrySet()) req.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            req.append("Host: ").append(hostHeader).append("\r\n");
            if (!https) req.append("Proxy-Authorization: ").append(proxyAuth).append("\r\n");
            req.append("Connection: close\r\n\r\n");
            OutputStream out = sock.getOutputStream();
            out.write(req.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();
            InputStream in = new BufferedInputStream(sock.getInputStream());
            Head head = readHead(in, deadline);
            return readBody(in, head, method, maxBytes, deadline);
        } catch (DominusNodeException e) {
            throw e;
        } catch (SocketTimeoutException e) {
            throw new ProxyException("Proxy request timed out after " + timeoutMs + "ms");
        } catch (IOException | RuntimeException e) {
            if (System.currentTimeMillis() > deadline) throw new ProxyException("Proxy request timed out after " + timeoutMs + "ms");
            throw new ProxyException("Proxy request failed: " + e.getMessage());
        }
    }

    private static final class Head {
        int status;
        String statusText = "";
        final Map<String, String> headers = new LinkedHashMap<>();
    }

    private static String readLine(InputStream in, int[] budget) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (--budget[0] < 0) throw new ProxyException("Response headers too large");
            if (c == '\n') break;
            if (c != '\r') b.write(c);
        }
        if (c == -1 && b.size() == 0) return null;
        return b.toString(StandardCharsets.ISO_8859_1);
    }

    private static void checkDeadline(long deadline) throws SocketTimeoutException {
        if (System.currentTimeMillis() > deadline) throw new SocketTimeoutException("deadline");
    }

    private static Head readHead(InputStream in, long deadline) throws IOException {
        int[] budget = {MAX_HEADER_BYTES};
        Head h = new Head();
        String line;
        do {
            line = readLine(in, budget);
            if (line == null) throw new ProxyException("Proxy closed the connection without a response");
            String[] p = line.split(" ", 3);
            if (p.length < 2 || !p[0].startsWith("HTTP/")) throw new ProxyException("Malformed HTTP response");
            try {
                h.status = Integer.parseInt(p[1]);
            } catch (NumberFormatException e) {
                throw new ProxyException("Malformed HTTP status");
            }
            h.statusText = p.length > 2 ? p[2] : "";
            h.headers.clear();
            while ((line = readLine(in, budget)) != null && !line.isEmpty()) {
                int i = line.indexOf(':');
                if (i <= 0) continue;
                String k = line.substring(0, i).trim().toLowerCase(Locale.ROOT);
                String v = line.substring(i + 1).trim();
                h.headers.merge(k, v, (a, b) -> a + ", " + b);
            }
            checkDeadline(deadline);
        } while (h.status >= 100 && h.status < 200 && h.status != 101);
        return h;
    }

    private static FetchResponse readBody(InputStream in, Head h, String method, int maxBytes, long deadline) throws IOException {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        boolean truncated = false;
        boolean noBody = method.equals("HEAD") || h.status == 204 || h.status == 304;
        if (!noBody) {
            String te = h.headers.getOrDefault("transfer-encoding", "").toLowerCase(Locale.ROOT);
            if (te.contains("chunked")) {
                int[] budget = {MAX_HEADER_BYTES};
                while (!truncated) {
                    String sizeLine = readLine(in, budget);
                    if (sizeLine == null) break;
                    int semi = sizeLine.indexOf(';');
                    long size;
                    try {
                        size = Long.parseLong((semi >= 0 ? sizeLine.substring(0, semi) : sizeLine).trim(), 16);
                    } catch (NumberFormatException e) {
                        throw new ProxyException("Malformed chunked encoding");
                    }
                    if (size == 0) break;
                    truncated = copy(in, body, size, maxBytes, deadline);
                    if (!truncated) readLine(in, budget);
                    budget[0] = MAX_HEADER_BYTES;
                }
            } else if (h.headers.containsKey("content-length")) {
                long cl;
                try {
                    cl = Long.parseLong(h.headers.get("content-length").split(",")[0].trim());
                } catch (NumberFormatException e) {
                    throw new ProxyException("Malformed Content-Length");
                }
                truncated = copy(in, body, cl, maxBytes, deadline);
            } else {
                truncated = copy(in, body, Long.MAX_VALUE, maxBytes, deadline);
            }
        }
        return new FetchResponse(h.status, h.statusText, Collections.unmodifiableMap(new LinkedHashMap<>(h.headers)), body.toByteArray(), truncated);
    }

    /** Copy up to {@code n} bytes; returns true when the maxBytes cap cut the body. */
    private static boolean copy(InputStream in, ByteArrayOutputStream out, long n, int maxBytes, long deadline) throws IOException {
        byte[] buf = new byte[8192];
        long left = n;
        while (left > 0) {
            int r = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (r == -1) return false;
            left -= r;
            int room = maxBytes - out.size();
            if (r > room) {
                out.write(buf, 0, room);
                return true;
            }
            out.write(buf, 0, r);
            checkDeadline(deadline);
        }
        return false;
    }
}
