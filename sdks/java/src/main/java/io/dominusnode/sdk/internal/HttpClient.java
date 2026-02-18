package io.dominusnode.sdk.internal;

import io.dominusnode.sdk.errors.*;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Optional;

/**
 * Internal HTTP client for communicating with the Dominus Node API.
 *
 * <p>Handles authentication headers, automatic token refresh on 401,
 * rate-limit retry on 429, and maps HTTP status codes to typed exceptions.</p>
 *
 * <p>This class is not part of the public API and may change without notice.</p>
 */
public final class HttpClient {

    /** SDK version string. */
    public static final String SDK_VERSION = "1.0.0";

    /** User-Agent header value. */
    public static final String USER_AGENT = "dominusnode-sdk-java/" + SDK_VERSION;

    /** Maximum wait time for rate-limit retry (10 seconds). */
    private static final int MAX_RETRY_WAIT_MS = 10_000;

    /** Maximum response body size in bytes (10 MB — prevents OOM from malicious server). */
    private static final int MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;

    private final String baseUrl;
    private final TokenManager tokenManager;
    private final java.net.http.HttpClient httpClient;
    private final Duration timeout;

    /**
     * Create a new HTTP client.
     *
     * @param baseUrl      the API base URL
     * @param tokenManager the token manager for authentication
     * @param timeout      request timeout duration
     */
    public HttpClient(String baseUrl, TokenManager tokenManager, Duration timeout) {
        // Strip trailing slash from base URL
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        this.tokenManager = tokenManager;
        this.timeout = timeout;
        // R16 G-1/J-3: Disable auto-redirects to prevent credential leakage via protocol downgrade
        this.httpClient = java.net.http.HttpClient.newBuilder()
                .connectTimeout(timeout)
                .followRedirects(java.net.http.HttpClient.Redirect.NEVER)
                .build();
    }

    /**
     * Perform an authenticated GET request.
     *
     * @param path  API path (e.g., "/api/wallet")
     * @param clazz response type
     * @param <T>   response type
     * @return deserialized response
     * @throws DominusNodeException on API or network errors
     */
    public <T> T get(String path, Class<T> clazz) throws DominusNodeException {
        return get(path, clazz, true);
    }

    /**
     * Perform a GET request, optionally authenticated.
     *
     * @param path         API path
     * @param clazz        response type
     * @param requiresAuth whether to send auth headers
     * @param <T>          response type
     * @return deserialized response
     * @throws DominusNodeException on API or network errors
     */
    public <T> T get(String path, Class<T> clazz, boolean requiresAuth) throws DominusNodeException {
        return request("GET", path, null, clazz, requiresAuth);
    }

    /**
     * Perform a GET request that returns a raw string (e.g., CSV export).
     *
     * @param path         API path
     * @param requiresAuth whether to send auth headers
     * @return raw response body string
     * @throws DominusNodeException on API or network errors
     */
    public String getRaw(String path, boolean requiresAuth) throws DominusNodeException {
        return requestRaw("GET", path, null, requiresAuth);
    }

    /**
     * Perform an authenticated POST request.
     *
     * @param path  API path
     * @param body  request body (will be serialized to JSON)
     * @param clazz response type
     * @param <T>   response type
     * @return deserialized response
     * @throws DominusNodeException on API or network errors
     */
    public <T> T post(String path, Object body, Class<T> clazz) throws DominusNodeException {
        return post(path, body, clazz, true);
    }

    /**
     * Perform a POST request, optionally authenticated.
     *
     * @param path         API path
     * @param body         request body
     * @param clazz        response type
     * @param requiresAuth whether to send auth headers
     * @param <T>          response type
     * @return deserialized response
     * @throws DominusNodeException on API or network errors
     */
    public <T> T post(String path, Object body, Class<T> clazz, boolean requiresAuth) throws DominusNodeException {
        return request("POST", path, body, clazz, requiresAuth);
    }

    /**
     * Perform an authenticated POST request that returns void.
     *
     * @param path         API path
     * @param body         request body
     * @param requiresAuth whether to send auth headers
     * @throws DominusNodeException on API or network errors
     */
    public void postVoid(String path, Object body, boolean requiresAuth) throws DominusNodeException {
        requestRaw("POST", path, body, requiresAuth);
    }

    /**
     * Perform an authenticated PUT request.
     *
     * @param path  API path
     * @param body  request body (may be {@code null})
     * @param clazz response type
     * @param <T>   response type
     * @return deserialized response
     * @throws DominusNodeException on API or network errors
     */
    public <T> T put(String path, Object body, Class<T> clazz) throws DominusNodeException {
        return request("PUT", path, body, clazz, true);
    }

    /**
     * Perform an authenticated DELETE request.
     *
     * @param path API path
     * @throws DominusNodeException on API or network errors
     */
    public void delete(String path) throws DominusNodeException {
        requestRaw("DELETE", path, null, true);
    }

    /**
     * Core request method returning a deserialized response.
     */
    private <T> T request(String method, String path, Object body, Class<T> clazz,
                          boolean requiresAuth) throws DominusNodeException {
        String responseBody = requestRaw(method, path, body, requiresAuth);
        if (responseBody == null || responseBody.isEmpty()) {
            return null;
        }
        return JsonUtil.fromJson(responseBody, clazz);
    }

    /**
     * Core request method returning the raw response body.
     *
     * <p>Handles 401 token refresh retry and 429 rate-limit retry.</p>
     */
    private String requestRaw(String method, String path, Object body,
                              boolean requiresAuth) throws DominusNodeException {
        HttpResponse<String> response = executeRequest(method, path, body, requiresAuth);

        // Handle 429 Rate Limit -- wait and retry once
        if (response.statusCode() == 429) {
            int retryAfter = parseRetryAfter(response);
            int waitMs = Math.min(retryAfter * 1000, MAX_RETRY_WAIT_MS);
            waitMs = Math.max(waitMs, 100); // R25 C-2: Enforce 100ms minimum before jitter
            // R15 H-5: Add ±10% jitter to prevent thundering-herd
            waitMs += (int) (waitMs * 0.2 * (Math.random() - 0.5));
            waitMs = Math.max(waitMs, 100); // R25 C-2: Enforce 100ms minimum after jitter
            try {
                Thread.sleep(waitMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new NetworkException("Request interrupted during rate-limit wait");
            }
            response = executeRequest(method, path, body, requiresAuth);
        }

        // Handle 401 Unauthorized -- force refresh and retry once
        if (response.statusCode() == 401 && requiresAuth) {
            try {
                tokenManager.forceRefresh();
                HttpResponse<String> retry = executeRequest(method, path, body, true);
                if (retry.statusCode() >= 200 && retry.statusCode() < 300) {
                    return retry.body();
                }
                throwForStatus(retry.statusCode(), retry.body(), retry);
            } catch (AuthenticationException e) {
                throw e;
            } catch (DominusNodeException e) {
                throw e;
            }
        }

        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throwForStatus(response.statusCode(), response.body(), response);
        }

        return response.body();
    }

    /**
     * Execute a single HTTP request.
     */
    private HttpResponse<String> executeRequest(String method, String path, Object body,
                                                 boolean requiresAuth) throws DominusNodeException {
        String url = baseUrl + path;
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(timeout)
                .header("User-Agent", USER_AGENT)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json");

        if (requiresAuth) {
            String token = tokenManager.getValidToken();
            // R29 H-7: Guard against null/empty token to prevent "Bearer null" header
            if (token == null || token.isEmpty()) {
                throw new AuthenticationException("No valid token available. Call connectWithKey() or login() first.");
            }
            builder.header("Authorization", "Bearer " + token);
        }

        HttpRequest.BodyPublisher bodyPublisher;
        if (body != null) {
            String jsonBody = JsonUtil.toJson(body);
            bodyPublisher = HttpRequest.BodyPublishers.ofString(jsonBody);
        } else {
            bodyPublisher = HttpRequest.BodyPublishers.noBody();
        }

        builder.method(method, bodyPublisher);

        try {
            // R16 G-1: Use BodyHandlers.ofInputStream to enforce size limit BEFORE buffering entire response
            HttpResponse<java.io.InputStream> streamResp = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
            String respBody;
            try (java.io.InputStream is = streamResp.body()) {
                byte[] limited = is.readNBytes(MAX_RESPONSE_BODY_BYTES + 1);
                if (limited.length > MAX_RESPONSE_BODY_BYTES) {
                    throw new ServerException("Response body exceeds " + MAX_RESPONSE_BODY_BYTES + " bytes", 502);
                }
                respBody = new String(limited, java.nio.charset.StandardCharsets.UTF_8);
            }
            HttpResponse<String> resp = new HttpStringResponse(streamResp, respBody);
            return resp;
        } catch (IOException e) {
            throw new NetworkException("Network request failed: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new NetworkException("Request interrupted", e);
        }
    }

    /**
     * Parse the Retry-After header value (in seconds).
     */
    private static int parseRetryAfter(HttpResponse<?> response) {
        Optional<String> header = response.headers().firstValue("retry-after");
        if (header.isPresent()) {
            try {
                return Integer.parseInt(header.get().trim());
            } catch (NumberFormatException e) {
                return 5;
            }
        }
        return 5;
    }

    /**
     * R16 G-1: Adapter wrapping a streaming HttpResponse with a pre-read String body.
     * Implements only the methods used internally (statusCode, body, headers).
     */
    private static final class HttpStringResponse implements HttpResponse<String> {
        private final HttpResponse<?> delegate;
        private final String body;

        HttpStringResponse(HttpResponse<?> delegate, String body) {
            this.delegate = delegate;
            this.body = body;
        }

        @Override public int statusCode() { return delegate.statusCode(); }
        @Override public String body() { return body; }
        @Override public java.net.http.HttpHeaders headers() { return delegate.headers(); }
        @Override public HttpRequest request() { return delegate.request(); }
        @Override public Optional<HttpResponse<String>> previousResponse() { return Optional.empty(); }
        @Override public java.net.URI uri() { return delegate.uri(); }
        @Override public Optional<javax.net.ssl.SSLSession> sslSession() { return delegate.sslSession(); }
        @Override public java.net.http.HttpClient.Version version() { return delegate.version(); }
    }

    /**
     * Map an HTTP status code to the appropriate exception type.
     */
    private static void throwForStatus(int status, String body,
                                        HttpResponse<String> response) throws DominusNodeException {
        String message = JsonUtil.extractErrorMessage(body);
        switch (status) {
            case 400:
                throw new ValidationException(message);
            case 401:
                throw new AuthenticationException(message);
            case 402:
                throw new InsufficientBalanceException(message);
            case 403:
                throw new AuthorizationException(message);
            case 404:
                throw new NotFoundException(message);
            case 409:
                throw new ConflictException(message);
            case 429: {
                int retryAfter = parseRetryAfter(response);
                throw new RateLimitException(message, retryAfter);
            }
            default:
                if (status >= 500) {
                    throw new ServerException(message, status);
                }
                throw new DominusNodeException(message, status);
        }
    }
}
