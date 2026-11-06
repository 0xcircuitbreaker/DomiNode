package io.dominusnode.sdk.internal;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.errors.AuthenticationException;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;

/**
 * Holds the JWT access/refresh pair as char[] (wiped on clear). clear() keeps the refresh
 * callback so reconnecting works. Concurrent callers share one refresh. Internal.
 */
public final class TokenManager {
    /** Exchanges a refresh token for {accessToken, refreshToken?}. */
    @FunctionalInterface
    public interface RefreshFn {
        String[] refresh(String refreshToken);
    }

    static final long REFRESH_BUFFER_MS = 60_000;

    private char[] access;
    private char[] refresh;
    private RefreshFn refreshFn;
    private final Object lock = new Object();

    public synchronized void setTokens(String accessToken, String refreshToken) {
        wipe(access);
        access = accessToken == null ? null : accessToken.toCharArray();
        if (refreshToken != null && !refreshToken.isEmpty()) {
            wipe(refresh);
            refresh = refreshToken.toCharArray();
        }
    }

    public void setRefreshFunction(RefreshFn fn) { this.refreshFn = fn; }

    public boolean hasRefreshFunction() { return refreshFn != null; }

    public synchronized String getAccessToken() { return access == null ? null : new String(access); }

    public synchronized String getRefreshToken() { return refresh == null ? null : new String(refresh); }

    public synchronized boolean hasTokens() { return access != null || refresh != null; }

    public static boolean isExpired(String token) {
        try {
            String[] parts = token.split("\\.");
            if (parts.length != 3) return true;
            JsonNode p = Json.parse(new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8));
            JsonNode exp = p.get("exp");
            if (exp == null || !exp.isNumber()) return true;
            return exp.asDouble() * 1000 < System.currentTimeMillis() + REFRESH_BUFFER_MS;
        } catch (Exception e) {
            return true;
        }
    }

    public String getValidToken() {
        String a = getAccessToken();
        if (a != null && !isExpired(a)) return a;
        return forceRefresh(a);
    }

    /** Refresh regardless of expiry (after a 401). */
    public String forceRefresh() { return forceRefresh(getAccessToken()); }

    private String forceRefresh(String seen) {
        synchronized (lock) {
            String current = getAccessToken();
            // Another thread refreshed while we waited: reuse its token.
            if (current != null && !current.equals(seen) && !isExpired(current)) return current;
            String rt = getRefreshToken();
            if (rt == null || refreshFn == null) throw new AuthenticationException("No valid token and cannot refresh");
            try {
                String[] r = refreshFn.refresh(rt);
                setTokens(r[0], r.length > 1 ? r[1] : null);
                return r[0];
            } catch (RuntimeException e) {
                clear();
                throw e;
            }
        }
    }

    /** Wipe tokens. Does NOT drop the refresh callback. */
    public synchronized void clear() {
        wipe(access);
        wipe(refresh);
        access = null;
        refresh = null;
    }

    private static void wipe(char[] c) { if (c != null) Arrays.fill(c, '\0'); }

    @Override
    public String toString() { return "TokenManager([REDACTED])"; }
}
