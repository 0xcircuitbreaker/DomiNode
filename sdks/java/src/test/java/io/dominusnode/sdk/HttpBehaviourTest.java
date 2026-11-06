package io.dominusnode.sdk;

import io.dominusnode.sdk.errors.*;
import io.dominusnode.sdk.internal.ApiClient;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

import static io.dominusnode.sdk.TestSupport.*;
import static org.junit.jupiter.api.Assertions.*;

class HttpBehaviourTest {

    @ParameterizedTest
    @CsvSource({
            "400,ValidationException", "401,AuthenticationException", "402,InsufficientBalanceException",
            "403,AuthorizationException", "404,NotFoundException", "409,ConflictException",
            "500,ServerException", "503,ServerException", "418,DominusNodeException"
    })
    void errorMapping(int status, String cls) {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        t.reply(status, "{\"error\":\"boom\",\"code\":\"CAP_ABOVE_DEFAULT\",\"max\":12,\"limitPerDay\":\"5\"}");
        DominusNodeException e = assertThrows(DominusNodeException.class, () -> c.network().stats());
        assertEquals(cls, e.getClass().getSimpleName());
        assertEquals("boom", e.getMessage());
        assertEquals(status, e.getStatusCode());
        assertEquals("CAP_ABOVE_DEFAULT", e.getCode());
        assertEquals(12, ((Number) e.getDetails().get("max")).intValue());
        assertEquals("5", e.getDetails().get("limitPerDay"));
    }

    @Test
    void messageFieldFallbackAndTruncation() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        t.reply(400, "{\"message\":\"" + "x".repeat(600) + "\"}");
        ValidationException e = assertThrows(ValidationException.class, () -> c.network().stats());
        assertEquals("x".repeat(500) + "... [truncated]", e.getMessage());
        assertNull(e.getCode());
    }

    @Test
    void mfaRequiredCode() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        t.reply(403, "{\"error\":\"MFA\",\"mfaRequired\":true}");
        AuthorizationException e = assertThrows(AuthorizationException.class, () -> c.network().stats());
        assertEquals("MFA_REQUIRED", e.getCode());
    }

    @Test
    void credentialScrubbing() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        String nodeKey = "dn_node_" + "a".repeat(64);
        t.reply(500, "{\"error\":\"bad " + API_KEY + " " + nodeKey + " dn_test_zzzzzzzz dn_proxy_x " + JWT + " end\"}");
        ServerException e = assertThrows(ServerException.class, () -> c.network().stats());
        assertEquals("bad [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] end", e.getMessage());
        // transport errors too
        DominusNodeClient c2 = new DominusNodeClient(Config.builder().baseUrl("https://api.test")
                .transport(r -> { throw new java.io.IOException("connect failed for " + API_KEY); }).build());
        NetworkException ne = assertThrows(NetworkException.class, () -> c2.network().stats());
        assertFalse(ne.getMessage().contains(API_KEY));
        assertTrue(ne.getMessage().contains("[REDACTED]"));
    }

    @Test
    void rateLimitRetriesOnceThenSucceeds() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        List<Long> waits = new ArrayList<>();
        c.setSleeper(waits::add);
        t.reply(429, "{\"error\":\"slow\"}", "Retry-After", "2").reply(200, "{\"onlineNodes\":3}");
        assertEquals(3, c.network().stats().get("onlineNodes").asInt());
        assertEquals(2, t.requests.size());
        assertEquals(1, waits.size());
        assertTrue(waits.get(0) >= 1800 && waits.get(0) <= 2200, "wait " + waits.get(0));
        assertTrue(t.streams.get(0).closed);
        assertEquals(0, t.streams.get(0).reads, "429 body must not be read");
    }

    @Test
    void rateLimitTwiceRaises() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        t.reply(429, "{}").reply(429, "{\"error\":\"still\"}", "Retry-After", "42");
        RateLimitException e = assertThrows(RateLimitException.class, () -> c.network().stats());
        assertEquals(42, e.getRetryAfterSeconds());
        assertEquals(2, t.requests.size());
        t.reply(429, "{}").reply(429, "{}");
        assertEquals(60, assertThrows(RateLimitException.class, () -> c.network().stats()).getRetryAfterSeconds());
    }

    @Test
    void retryDelayBounds() {
        assertEquals(9000, ApiClient.retryDelayMs(3600, 0.0));
        assertEquals(11000, ApiClient.retryDelayMs(3600, 1.0));
        assertEquals(10000, ApiClient.retryDelayMs(10, 0.5));
        assertEquals(5000, ApiClient.retryDelayMs(5, 0.5));
        assertEquals(100, ApiClient.retryDelayMs(0, 0.0));
        for (int i = 0; i < 1000; i++) {
            long d = ApiClient.retryDelayMs(1000, Math.random());
            assertTrue(d >= 9000 && d <= 11000);
        }
    }

    @Test
    void jwt401RefreshesAndRetries() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        String newJwt = jwt(System.currentTimeMillis() / 1000 + 7200, "new");
        t.reply(401, "{\"error\":\"expired\"}")
                .reply(200, "{\"token\":\"" + newJwt + "\",\"refreshToken\":\"" + REFRESH + "\"}")
                .reply(200, "{\"user\":{\"id\":\"u\"}}");
        assertEquals("u", c.auth().me().path("user").path("id").asText());
        assertEquals(3, t.requests.size());
        assertEquals("/api/auth/refresh", MockTransport.path(t.requests.get(1)));
        assertNull(MockTransport.auth(t.requests.get(1)));
        assertEquals("Bearer " + newJwt, MockTransport.auth(t.requests.get(2)));
    }

    @Test
    void noRefreshForApiKeyAuth() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        t.reply(401, "{\"error\":\"bad key\"}");
        assertThrows(AuthenticationException.class, () -> c.credits().balance());
        assertEquals(1, t.requests.size());
    }

    @Test
    void refreshFailureClearsTokens() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        t.reply(401, "{}").reply(401, "{\"error\":\"refresh revoked\"}");
        AuthenticationException e = assertThrows(AuthenticationException.class, () -> c.auth().me());
        assertEquals("Session expired and token refresh failed", e.getMessage());
        assertNull(c.tokenManager().getAccessToken());
        assertNull(c.tokenManager().getRefreshToken());
        assertTrue(c.tokenManager().hasRefreshFunction());
    }

    @Test
    void expiredAccessTokenRefreshedBeforeRequest() {
        MockTransport t = new MockTransport();
        String old = jwt(System.currentTimeMillis() / 1000 + 30, "old"); // inside 60 s buffer
        DominusNodeClient c = new DominusNodeClient(Config.builder().baseUrl("https://api.test").transport(t).tokens(old, REFRESH).build());
        t.reply(200, "{\"token\":\"" + JWT + "\"}");
        c.auth().me();
        assertEquals("/api/auth/refresh", MockTransport.path(t.requests.get(0)));
        assertEquals("Bearer " + JWT, MockTransport.auth(t.requests.get(1)));
    }

    @Test
    void noCredentialSendsNothing() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        assertThrows(AuthenticationException.class, () -> c.auth().me());
        assertThrows(AuthenticationException.class, () -> c.credits().balance());
        assertTrue(t.requests.isEmpty());
    }

    @Test
    void contentLengthCap() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        t.reply(200, "{}", "Content-Length", String.valueOf(10 * 1024 * 1024 + 1));
        ServerException e = assertThrows(ServerException.class, () -> c.network().stats());
        assertEquals("Response body too large", e.getMessage());
        assertTrue(t.streams.get(0).closed);
    }

    @Test
    void actualSizeCap() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        InputStream endless = new InputStream() {
            long n;
            @Override public int read() { return n++ < 20L * 1024 * 1024 ? ' ' : -1; }
            @Override public int read(byte[] b, int off, int len) {
                if (n >= 20L * 1024 * 1024) return -1;
                java.util.Arrays.fill(b, off, off + len, (byte) ' ');
                n += len;
                return len;
            }
        };
        t.replyStream(200, endless);
        ServerException e = assertThrows(ServerException.class, () -> c.network().stats());
        assertEquals("Response body exceeds size limit", e.getMessage());
    }

    @Test
    void redirectsAreNotFollowed() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        t.reply(302, "", "Location", "https://evil.example/");
        assertThrows(NetworkException.class, () -> c.network().stats());
        assertEquals(1, t.requests.size());
    }

    @Test
    void jdkTransportDisablesRedirects() throws Exception {
        java.lang.reflect.Field f = JdkTransport.class.getDeclaredField("client");
        f.setAccessible(true);
        assertEquals(java.net.http.HttpClient.Redirect.NEVER, ((java.net.http.HttpClient) f.get(new JdkTransport())).followRedirects());
    }

    @Test
    void invalidJsonAndEmptyBody() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        t.reply(200, "not json");
        assertThrows(ServerException.class, () -> c.network().stats());
        t.reply(200, "");
        assertTrue(c.network().stats().isEmpty());
    }

    @Test
    void prototypePollutionKeysStripped() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        t.reply(200, "{\"a\":{\"__proto__\":{\"x\":1},\"constructor\":2,\"b\":[{\"prototype\":3,\"ok\":4}]}}");
        assertEquals("{\"a\":{\"b\":[{\"ok\":4}]}}", c.network().stats().toString());
    }

    @Test
    void baseUrlValidation() {
        assertThrows(ValidationException.class, () -> new DominusNodeClient(Config.builder().baseUrl("ftp://x").build()));
        assertThrows(ValidationException.class, () -> new DominusNodeClient(Config.builder().baseUrl("https://u:p@x").build()));
        MockTransport t = new MockTransport();
        new DominusNodeClient(Config.builder().baseUrl("https://api.test///").transport(t).build()).network().stats();
        assertEquals("https://api.test/v1/network/stats", t.last().url);
    }

    @Test
    void connectWithKeyMfaKeepsKeyOnly() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        t.reply(403, "{\"error\":\"mfa\",\"mfaRequired\":true}");
        DominusNodeClient.ConnectResult r = c.connectWithKey(API_KEY);
        assertTrue(r.mfaRequired);
        assertTrue(c.isConnected());
        assertFalse(c.tokenManager().hasTokens());
        c.credits().balance();
        assertEquals("Bearer " + API_KEY, MockTransport.auth(t.last()));
        assertThrows(AuthenticationException.class, () -> c.auth().me());
    }

    @Test
    void connectWithKeyErrorStoresNothing() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        t.reply(401, "{\"error\":\"nope\"}");
        assertThrows(AuthenticationException.class, () -> c.connectWithKey(API_KEY));
        assertFalse(c.isConnected());
        assertThrows(ValidationException.class, () -> c.connectWithKey("sk_live_nope"));
        assertEquals(1, t.requests.size());
    }

    @Test
    void connectWithKeySuccess() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        t.reply(200, "{\"token\":\"" + JWT + "\",\"refreshToken\":\"" + REFRESH + "\",\"userId\":\"" + UUID + "\"}");
        DominusNodeClient.ConnectResult r = c.connectWithKey(API_KEY);
        assertFalse(r.mfaRequired);
        assertEquals(UUID, r.userId);
        assertNull(MockTransport.auth(t.last()));
    }

    @Test
    void walletVerifyMfaStoresNothing() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = client(t);
        t.reply(200, "{\"mfaRequired\":true,\"mfaChallengeToken\":\"ch\",\"token\":\"" + JWT + "\"}");
        com.fasterxml.jackson.databind.JsonNode r = c.walletAuth().verify(WALLET, SIG);
        assertTrue(r.get("mfaRequired").asBoolean());
        assertEquals("ch", r.get("mfaChallengeToken").asText());
        assertFalse(r.has("token"));
        assertFalse(c.isConnected());
        t.reply(200, "{\"token\":\"" + JWT + "\",\"refreshToken\":\"" + REFRESH + "\"}");
        c.walletAuth().verify(WALLET, SIG);
        assertEquals(JWT, c.tokenManager().getAccessToken());
    }
}
