package io.dominusnode.sdk.internal;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.Transport;
import io.dominusnode.sdk.errors.AuthenticationException;
import io.dominusnode.sdk.errors.AuthorizationException;
import io.dominusnode.sdk.errors.ConflictException;
import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.errors.InsufficientBalanceException;
import io.dominusnode.sdk.errors.NetworkException;
import io.dominusnode.sdk.errors.NotFoundException;
import io.dominusnode.sdk.errors.RateLimitException;
import io.dominusnode.sdk.errors.ServerException;
import io.dominusnode.sdk.errors.ValidationException;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Supplier;

/** HTTP layer shared by all resources. Internal. */
public final class ApiClient {
    public static final String SDK_VERSION = "2.0.1";
    public static final String USER_AGENT = "dominusnode-sdk-java/" + SDK_VERSION;
    public static final int MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
    static final long MAX_RETRY_WAIT_MS = 10_000;
    static final long MIN_RETRY_WAIT_MS = 100;

    /** Auth mode: none, jwt (Bearer access JWT) or agent (Bearer API key, else wallet JWT). */
    public enum Auth { NONE, JWT, AGENT }

    /** Sleep hook (tests). */
    @FunctionalInterface
    public interface Sleeper {
        void sleep(long ms) throws InterruptedException;
    }

    private final String baseUrl;
    private final Transport transport;
    private final TokenManager tokens;
    private final Supplier<String> apiKey;
    private volatile Sleeper sleeper = Thread::sleep;

    public ApiClient(String baseUrl, Transport transport, TokenManager tokens, Supplier<String> apiKey) {
        URI u;
        try {
            u = new URI(baseUrl);
        } catch (Exception e) {
            throw ValidationException.invalidArg("baseUrl is not a valid URL");
        }
        if (!"https".equalsIgnoreCase(u.getScheme()) && !"http".equalsIgnoreCase(u.getScheme())) {
            throw ValidationException.invalidArg("baseUrl must be http(s)");
        }
        if (u.getRawUserInfo() != null) throw ValidationException.invalidArg("baseUrl must not contain credentials");
        if (u.getHost() == null) throw ValidationException.invalidArg("baseUrl has no host");
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.transport = transport;
        this.tokens = tokens;
        this.apiKey = apiKey;
    }

    public void setSleeper(Sleeper s) { this.sleeper = s; }

    /** min(retryAfter, 10 s), +/-10 % jitter, floor 100 ms. */
    public static long retryDelayMs(long retryAfterSeconds, double random01) {
        double base = Math.min(Math.max(retryAfterSeconds, 0) * 1000.0, MAX_RETRY_WAIT_MS);
        double jitter = base * 0.2 * (random01 - 0.5);
        return Math.max(MIN_RETRY_WAIT_MS, Math.round(base + jitter));
    }

    private static long parseRetryAfter(Transport.Response r, long fallback) {
        try {
            long n = Long.parseLong(r.header("retry-after").orElse("").trim());
            return n >= 0 ? n : fallback;
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private String bearer(Auth mode, boolean force) {
        if (mode == Auth.NONE) return null;
        if (mode == Auth.AGENT) {
            String k = apiKey.get();
            if (k != null) return k;
        }
        if (!tokens.hasTokens()) {
            throw new AuthenticationException("Not authenticated. Call connectWithKey() or walletAuth.verify() first.");
        }
        return force ? tokens.forceRefresh() : tokens.getValidToken();
    }

    private Transport.Response send(String method, String path, String body, Map<String, String> extra, String bearer) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("User-Agent", USER_AGENT);
        h.put("Accept", "application/json");
        if (extra != null) h.putAll(extra);
        if (body != null) h.put("Content-Type", "application/json");
        if (bearer != null) h.put("Authorization", "Bearer " + bearer);
        try {
            return transport.send(new Transport.Request(method, baseUrl + path, h, body));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new NetworkException("Request interrupted");
        } catch (IOException | RuntimeException e) {
            throw new NetworkException(e.getMessage() == null ? "Network request failed" : e.getMessage());
        }
    }

    private static void close(Transport.Response r) {
        try {
            if (r.body != null) r.body.close();
        } catch (IOException ignored) {
            // best effort
        }
    }

    static String readBody(Transport.Response r) {
        try (InputStream in = r.body) {
            long cl = r.header("content-length").map(v -> {
                try { return Long.parseLong(v.trim()); } catch (NumberFormatException e) { return 0L; }
            }).orElse(0L);
            if (cl > MAX_RESPONSE_BYTES) throw new ServerException("Response body too large", r.status);
            if (in == null) return "";
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            long total = 0;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > MAX_RESPONSE_BYTES) throw new ServerException("Response body exceeds size limit", r.status);
                out.write(buf, 0, n);
            }
            return out.toString(StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new NetworkException(e.getMessage() == null ? "Failed to read response" : e.getMessage());
        }
    }

    static DominusNodeException errorFor(int status, String body, Transport.Response r) {
        String message = body;
        String code = null;
        Map<String, Object> details = null;
        try {
            JsonNode p = Json.parse(body);
            if (p != null && p.isObject()) {
                JsonNode m = p.has("error") && !p.get("error").isNull() ? p.get("error") : p.get("message");
                if (m != null && m.isTextual()) message = m.asText();
                if (p.path("code").isTextual()) code = p.get("code").asText();
                else if (p.path("mfaRequired").isBoolean() && p.get("mfaRequired").asBoolean()) code = "MFA_REQUIRED";
                for (String k : new String[]{"max", "cap", "limitPerDay"}) {
                    JsonNode v = p.get(k);
                    if (v != null && (v.isNumber() || v.isTextual())) {
                        if (details == null) details = new LinkedHashMap<>();
                        details.put(k, v.isNumber() ? v.numberValue() : v.asText());
                    }
                }
            }
        } catch (Exception ignored) {
            // not JSON
        }
        if (message == null || message.isEmpty()) message = "HTTP " + status;
        if (message.length() > 500) message = message.substring(0, 500) + "... [truncated]";
        switch (status) {
            case 400: return new ValidationException(message, 400, code, details);
            case 401: return new AuthenticationException(message, code, details);
            case 402: return new InsufficientBalanceException(message, code, details);
            case 403: return new AuthorizationException(message, code, details);
            case 404: return new NotFoundException(message, code, details);
            case 409: return new ConflictException(message, code, details);
            case 429: return new RateLimitException(message, parseRetryAfter(r, 60), code, details);
            default:
                if (status >= 500) return new ServerException(message, status, code, details);
                return new DominusNodeException(message, status, code, details);
        }
    }

    /** Send a request; returns parsed JSON (or a TextNode for raw). */
    public JsonNode request(String method, String path, Object body, Auth mode, Map<String, String> headers, boolean raw) {
        String json = body == null ? null : Json.write(body);
        String bearer = bearer(mode, false);
        Transport.Response res = send(method, path, json, headers, bearer);

        if (res.status == 429) {
            long wait = retryDelayMs(parseRetryAfter(res, 5), ThreadLocalRandom.current().nextDouble());
            close(res); // do not buffer the 429 body
            try {
                sleeper.sleep(wait);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new NetworkException("Request interrupted");
            }
            bearer = bearer(mode, false);
            res = send(method, path, json, headers, bearer);
        }

        boolean usedJwt = bearer != null && !bearer.startsWith("dn_");
        if (res.status == 401 && usedJwt && tokens.getRefreshToken() != null) {
            close(res);
            String refreshed;
            try {
                refreshed = bearer(mode, true);
            } catch (RuntimeException e) {
                refreshed = null;
            }
            if (refreshed == null) throw new AuthenticationException("Session expired and token refresh failed");
            res = send(method, path, json, headers, refreshed);
        }

        if (res.status >= 300 && res.status < 400) {
            close(res);
            throw new NetworkException("Redirect refused (HTTP " + res.status + "): the SDK never follows redirects");
        }
        String text = readBody(res);
        if (res.status < 200 || res.status >= 300) throw errorFor(res.status, text, res);
        if (raw) return Json.MAPPER.getNodeFactory().textNode(text);
        if (text.isEmpty()) return Json.object();
        try {
            return Json.parse(text);
        } catch (Exception e) {
            throw new ServerException("Invalid JSON in response", res.status);
        }
    }

    public JsonNode get(String path, Auth mode) { return request("GET", path, null, mode, null, false); }

    public JsonNode post(String path, Object body, Auth mode) { return request("POST", path, body, mode, null, false); }

    public JsonNode put(String path, Object body, Auth mode) { return request("PUT", path, body, mode, null, false); }

    public JsonNode patch(String path, Object body, Auth mode) { return request("PATCH", path, body, mode, null, false); }

    public JsonNode delete(String path, Auth mode) { return request("DELETE", path, null, mode, null, false); }

    @Override
    public String toString() { return "ApiClient(" + baseUrl + ")"; }
}
