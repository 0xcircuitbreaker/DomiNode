package io.dominusnode.sdk;

import com.sun.net.httpserver.HttpServer;
import io.dominusnode.sdk.errors.AuthenticationException;
import io.dominusnode.sdk.errors.ConflictException;
import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.types.LoginResult;
import io.dominusnode.sdk.types.MfaSetup;
import io.dominusnode.sdk.types.MfaStatus;
import io.dominusnode.sdk.types.TokenPair;
import io.dominusnode.sdk.types.User;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for AuthResource: login, register, MFA flow, refresh, and profile.
 */
class AuthResourceTest {

    private HttpServer server;
    private int port;

    @BeforeEach
    void setUp() throws IOException {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        port = server.getAddress().getPort();
    }

    @AfterEach
    void tearDown() {
        if (server != null) {
            server.stop(0);
        }
    }

    private String baseUrl() {
        return "http://localhost:" + port;
    }

    private static String fakeJwt(long expSeconds) {
        String header = java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"alg\":\"HS256\"}".getBytes(StandardCharsets.UTF_8));
        String payload = java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(("{\"exp\":" + expSeconds + "}").getBytes(StandardCharsets.UTF_8));
        return header + "." + payload + ".sig";
    }

    private void respondJson(com.sun.net.httpserver.HttpExchange exchange, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    @Test
    void registerCreatesAccount() throws Exception {
        String token = fakeJwt(System.currentTimeMillis() / 1000 + 3600);
        server.createContext("/api/auth/register", exchange -> {
            respondJson(exchange, 200,
                    "{\"user\":{\"id\":\"u1\",\"email\":\"new@example.com\",\"is_admin\":false},"
                            + "\"token\":\"" + token + "\",\"refreshToken\":\"rt1\"}");
        });
        server.start();

        DominusNodeClient client = new DominusNodeClient(Config.builder().baseUrl(baseUrl()).build());
        LoginResult result = client.auth().register("new@example.com", "Pass1234!");
        assertNotNull(result.getUser());
        assertEquals("new@example.com", result.getUser().getEmail());
        assertNotNull(result.getToken());
        client.close();
    }

    @Test
    void registerDuplicateEmailThrowsConflict() throws Exception {
        server.createContext("/api/auth/register", exchange -> {
            respondJson(exchange, 409, "{\"error\":\"Email already registered\"}");
        });
        server.start();

        DominusNodeClient client = new DominusNodeClient(Config.builder().baseUrl(baseUrl()).build());
        assertThrows(ConflictException.class,
                () -> client.auth().register("existing@example.com", "Pass1234!"));
        client.close();
    }

    @Test
    void loginSuccessStoresTokens() throws Exception {
        String token = fakeJwt(System.currentTimeMillis() / 1000 + 3600);
        server.createContext("/api/auth/login", exchange -> {
            respondJson(exchange, 200,
                    "{\"user\":{\"id\":\"u1\",\"email\":\"test@example.com\",\"is_admin\":false},"
                            + "\"token\":\"" + token + "\",\"refreshToken\":\"rt\",\"mfaRequired\":false}");
        });
        server.start();

        DominusNodeClient client = new DominusNodeClient(Config.builder().baseUrl(baseUrl()).build());
        LoginResult result = client.auth().login("test@example.com", "password123");
        assertFalse(result.isMfaRequired());
        assertEquals("u1", result.getUser().getId());
        client.close();
    }

    @Test
    void loginInvalidCredentialsThrows() throws Exception {
        server.createContext("/api/auth/login", exchange -> {
            respondJson(exchange, 401, "{\"error\":\"Invalid credentials\"}");
        });
        server.start();

        DominusNodeClient client = new DominusNodeClient(Config.builder().baseUrl(baseUrl()).build());
        assertThrows(AuthenticationException.class,
                () -> client.auth().login("wrong@example.com", "wrong"));
        client.close();
    }

    @Test
    void mfaFlowLoginThenVerify() throws Exception {
        String token = fakeJwt(System.currentTimeMillis() / 1000 + 3600);

        server.createContext("/api/auth/login", exchange -> {
            respondJson(exchange, 200,
                    "{\"mfaRequired\":true,\"mfaChallengeToken\":\"challenge_abc\"}");
        });
        server.createContext("/api/auth/mfa/verify", exchange -> {
            respondJson(exchange, 200,
                    "{\"user\":{\"id\":\"u1\",\"email\":\"mfa@example.com\",\"is_admin\":false},"
                            + "\"token\":\"" + token + "\",\"refreshToken\":\"rt\"}");
        });
        server.start();

        DominusNodeClient client = new DominusNodeClient(Config.builder().baseUrl(baseUrl()).build());
        LoginResult loginResult = client.auth().login("mfa@example.com", "pass");
        assertTrue(loginResult.isMfaRequired());

        LoginResult mfaResult = client.auth().verifyMfa("123456", "challenge_abc", false);
        assertNotNull(mfaResult.getUser());
        assertEquals("mfa@example.com", mfaResult.getUser().getEmail());
        client.close();
    }

    @Test
    void refreshReturnsNewTokens() throws Exception {
        String newToken = fakeJwt(System.currentTimeMillis() / 1000 + 3600);
        server.createContext("/api/auth/refresh", exchange -> {
            respondJson(exchange, 200,
                    "{\"token\":\"" + newToken + "\",\"refreshToken\":\"new_rt\"}");
        });
        server.start();

        DominusNodeClient client = new DominusNodeClient(Config.builder().baseUrl(baseUrl()).build());
        TokenPair pair = client.auth().refresh("old_refresh_token");
        assertNotNull(pair.getToken());
        assertNotNull(pair.getRefreshToken());
        client.close();
    }

    @Test
    void meReturnsUser() throws Exception {
        String token = fakeJwt(System.currentTimeMillis() / 1000 + 3600);

        server.createContext("/api/auth/verify-key", exchange -> {
            respondJson(exchange, 200,
                    "{\"token\":\"" + token + "\",\"refreshToken\":\"rt\",\"valid\":true}");
        });
        server.createContext("/api/auth/me", exchange -> {
            respondJson(exchange, 200,
                    "{\"user\":{\"id\":\"u1\",\"email\":\"me@example.com\",\"is_admin\":true,\"created_at\":\"2025-01-01T00:00:00Z\"}}");
        });
        server.start();

        DominusNodeClient client = new DominusNodeClient(Config.builder().baseUrl(baseUrl()).build());
        client.connectWithKey("dn_live_test");
        User user = client.auth().me();
        assertEquals("u1", user.getId());
        assertEquals("me@example.com", user.getEmail());
        assertTrue(user.isAdmin());
        client.close();
    }

    @Test
    void mfaStatusReturnsStatus() throws Exception {
        String token = fakeJwt(System.currentTimeMillis() / 1000 + 3600);

        server.createContext("/api/auth/verify-key", exchange -> {
            respondJson(exchange, 200,
                    "{\"token\":\"" + token + "\",\"refreshToken\":\"rt\",\"valid\":true}");
        });
        server.createContext("/api/auth/mfa/status", exchange -> {
            respondJson(exchange, 200, "{\"enabled\":true,\"backupCodesRemaining\":8}");
        });
        server.start();

        DominusNodeClient client = new DominusNodeClient(Config.builder().baseUrl(baseUrl()).build());
        client.connectWithKey("dn_live_test");
        MfaStatus status = client.auth().mfaStatus();
        assertTrue(status.isEnabled());
        assertEquals(8, status.getBackupCodesRemaining());
        client.close();
    }
}
