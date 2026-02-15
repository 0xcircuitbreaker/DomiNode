package io.dominusnode.sdk.internal;

import io.dominusnode.sdk.errors.AuthenticationException;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Function;

/**
 * Thread-safe JWT token manager with automatic refresh support.
 *
 * <p>Stores the current access and refresh tokens, checks JWT expiry by
 * decoding the payload (no JWT library needed), and coordinates singleton
 * refresh to avoid concurrent refresh storms.</p>
 *
 * <p>This class is not part of the public API and may change without notice.</p>
 */
public final class TokenManager {

    /** Refresh tokens 60 seconds before they actually expire. */
    private static final long REFRESH_BUFFER_MS = 60_000L;

    private volatile String accessToken;
    private volatile String refreshTokenValue;
    private volatile CompletableFuture<String> refreshFuture;

    private Function<String, String[]> refreshFn;

    /**
     * Set the function used to refresh tokens.
     *
     * <p>The function takes a refresh token string and returns a two-element
     * array: {@code [newAccessToken, newRefreshToken]}. The new refresh token
     * may be {@code null} if the server does not rotate it.</p>
     *
     * @param fn the refresh function
     */
    public synchronized void setRefreshFunction(Function<String, String[]> fn) {
        this.refreshFn = fn;
    }

    /**
     * Store a pair of tokens.
     *
     * @param access  JWT access token
     * @param refresh refresh token (may be {@code null})
     */
    public synchronized void setTokens(String access, String refresh) {
        this.accessToken = access;
        if (refresh != null) {
            this.refreshTokenValue = refresh;
        }
    }

    /**
     * Get the current access token, or {@code null}.
     *
     * @return the access token
     */
    public synchronized String getAccessToken() {
        return accessToken;
    }

    /**
     * Get the current refresh token, or {@code null}.
     *
     * @return the refresh token
     */
    public synchronized String getRefreshToken() {
        return refreshTokenValue;
    }

    /**
     * Whether the manager currently holds tokens.
     *
     * @return {@code true} if at least an access token is stored
     */
    public synchronized boolean hasTokens() {
        return accessToken != null;
    }

    /**
     * Check whether a JWT token is expired or about to expire.
     *
     * @param token the JWT string
     * @return {@code true} if the token is expired or will expire within the buffer window
     */
    public boolean isExpired(String token) {
        if (token == null) return true;
        try {
            String[] parts = token.split("\\.");
            if (parts.length != 3) return true;

            // Handle URL-safe base64 variants
            String payload = parts[1]
                    .replace('-', '+')
                    .replace('_', '/');
            // Add padding if necessary
            int padding = (4 - payload.length() % 4) % 4;
            for (int i = 0; i < padding; i++) {
                payload += "=";
            }

            byte[] decoded = Base64.getDecoder().decode(payload);
            String json = new String(decoded, StandardCharsets.UTF_8);

            // Simple extraction of "exp" field without full JSON parsing
            int expIdx = json.indexOf("\"exp\"");
            if (expIdx < 0) return true;

            int colonIdx = json.indexOf(':', expIdx);
            if (colonIdx < 0) return true;

            // Find the numeric value after the colon
            int start = colonIdx + 1;
            while (start < json.length() && !Character.isDigit(json.charAt(start))) {
                start++;
            }
            int end = start;
            while (end < json.length() && Character.isDigit(json.charAt(end))) {
                end++;
            }
            if (start >= end) return true;

            long expSeconds = Long.parseLong(json.substring(start, end));
            long expMs = expSeconds * 1000L;
            return expMs < System.currentTimeMillis() + REFRESH_BUFFER_MS;
        } catch (Exception e) {
            return true;
        }
    }

    /**
     * Get a valid access token, refreshing if necessary.
     *
     * <p>If the current token is expired or about to expire, this method
     * will trigger a refresh using the stored refresh function. Concurrent
     * callers will share the same refresh operation (singleton pattern).</p>
     *
     * @return a valid access token
     * @throws AuthenticationException if no token is available and refresh is impossible
     */
    public String getValidToken() throws AuthenticationException {
        String current;
        synchronized (this) {
            current = accessToken;
        }

        if (current != null && !isExpired(current)) {
            return current;
        }

        return doRefresh();
    }

    /**
     * Force a token refresh regardless of current expiry state.
     *
     * <p>Used after a 401 response to avoid re-using a rejected token.</p>
     *
     * @return the new access token
     * @throws AuthenticationException if refresh fails
     */
    public String forceRefresh() throws AuthenticationException {
        return doRefresh();
    }

    /**
     * Clear all stored tokens.
     */
    public synchronized void clear() {
        accessToken = null;
        refreshTokenValue = null;
        refreshFuture = null;
    }

    private String doRefresh() throws AuthenticationException {
        CompletableFuture<String> future;
        String rt;
        Function<String, String[]> fn;
        CompletableFuture<String> newFuture = null;

        synchronized (this) {
            if (refreshTokenValue == null || refreshFn == null) {
                throw new AuthenticationException("No valid token and cannot refresh");
            }

            // Singleton refresh: if a refresh is already in-flight, join it
            if (refreshFuture != null) {
                future = refreshFuture;
                rt = null;
                fn = null;
            } else {
                rt = refreshTokenValue;
                fn = refreshFn;
                newFuture = new CompletableFuture<>();
                refreshFuture = newFuture;
                future = null;
            }
        }

        // If joining an in-flight refresh from another thread
        if (future != null) {
            try {
                // R17: 30s timeout prevents indefinite thread blocking if refresh hangs
                return future.get(30, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AuthenticationException("Token refresh interrupted");
            } catch (TimeoutException e) {
                throw new AuthenticationException("Token refresh timed out after 30 seconds");
            } catch (ExecutionException e) {
                Throwable cause = e.getCause();
                if (cause instanceof AuthenticationException) {
                    throw (AuthenticationException) cause;
                }
                throw new AuthenticationException("Token refresh failed: " + cause.getMessage());
            }
        }

        // Perform network call OUTSIDE the synchronized block to avoid thread starvation
        try {
            String[] result = fn.apply(rt);
            synchronized (this) {
                accessToken = result[0];
                if (result.length > 1 && result[1] != null) {
                    refreshTokenValue = result[1];
                }
                refreshFuture = null;
            }
            newFuture.complete(result[0]);
            return result[0];
        } catch (Exception e) {
            synchronized (this) {
                accessToken = null;
                refreshTokenValue = null;
                refreshFuture = null;
            }
            newFuture.completeExceptionally(e);
            if (e instanceof AuthenticationException) {
                throw (AuthenticationException) e;
            }
            throw new AuthenticationException("Token refresh failed: " + e.getMessage());
        }
    }
}
