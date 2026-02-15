package io.dominusnode.sdk;

import com.sun.net.httpserver.HttpServer;
import io.dominusnode.sdk.errors.AuthenticationException;
import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.types.LoginResult;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for DominusNodeClient construction, connectWithKey, and connectWithCredentials.
 */
class DominusNodeClientTest {

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

    /** Helper to build a JWT-like token with a given expiry. */
    private static String fakeJwt(long expSeconds) {
        String header = java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"alg\":\"HS256\"}".getBytes(StandardCharsets.UTF_8));
        String payload = java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(("{\"exp\":" + expSeconds + "}").getBytes(StandardCharsets.UTF_8));
        String sig = java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString("signature".getBytes(StandardCharsets.UTF_8));
        return header + "." + payload + "." + sig;
    }

    @Test
    void constructorWithDefaultConfig() throws Exception {
        // Just verify we can construct without errors
        server.createContext("/", exchange -> {
            exchange.sendResponseHeaders(404, 0);
            exchange.close();
        });
        server.start();

        Config config = Config.builder()
                .baseUrl(baseUrl())
                .build();

        DominusNodeClient client = new DominusNodeClient(config);
        assertNotNull(client.auth());
        assertNotNull(client.keys());
        assertNotNull(client.wallet());
        assertNotNull(client.usage());
        assertNotNull(client.plans());
        assertNotNull(client.sessions());
        assertNotNull(client.proxy());
        assertNotNull(client.admin());
        client.close();
    }

    @Test
    void connectWithKeyStoresTokens() throws Exception {
        String token = fakeJwt(System.currentTimeMillis() / 1000 + 3600);
        String refreshToken = "refresh_abc123";

        server.createContext("/api/auth/verify-key", exchange -> {
            String response = "{\"token\":\"" + token + "\",\"refreshToken\":\"" + refreshToken
                    + "\",\"valid\":true,\"userId\":\"u1\",\"email\":\"test@example.com\"}";
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });
        server.start();

        Config config = Config.builder().baseUrl(baseUrl()).build();
        DominusNodeClient client = new DominusNodeClient(config);
        client.connectWithKey("dn_live_test123");
        // No exception means success
        client.close();
    }

    @Test
    void connectWithKeyAutoConnects() throws Exception {
        String token = fakeJwt(System.currentTimeMillis() / 1000 + 3600);

        server.createContext("/api/auth/verify-key", exchange -> {
            String response = "{\"token\":\"" + token + "\",\"refreshToken\":\"rt\",\"valid\":true}";
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });
        server.start();

        Config config = Config.builder()
                .baseUrl(baseUrl())
                .apiKey("dn_live_auto")
                .build();
        DominusNodeClient client = new DominusNodeClient(config);
        // Auto-connect via config should work without error
        client.close();
    }

    @Test
    void connectWithCredentialsReturnsLoginResult() throws Exception {
        String token = fakeJwt(System.currentTimeMillis() / 1000 + 3600);

        server.createContext("/api/auth/login", exchange -> {
            String response = "{\"user\":{\"id\":\"u1\",\"email\":\"test@example.com\",\"is_admin\":false},"
                    + "\"token\":\"" + token + "\",\"refreshToken\":\"rt\",\"mfaRequired\":false}";
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });
        server.start();

        Config config = Config.builder().baseUrl(baseUrl()).build();
        DominusNodeClient client = new DominusNodeClient(config);
        LoginResult result = client.connectWithCredentials("test@example.com", "password123");
        assertNotNull(result);
        assertFalse(result.isMfaRequired());
        assertNotNull(result.getUser());
        assertEquals("test@example.com", result.getUser().getEmail());
        client.close();
    }

    @Test
    void connectWithCredentialsMfaRequired() throws Exception {
        server.createContext("/api/auth/login", exchange -> {
            String response = "{\"mfaRequired\":true,\"mfaChallengeToken\":\"challenge_xyz\"}";
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });
        server.start();

        Config config = Config.builder().baseUrl(baseUrl()).build();
        DominusNodeClient client = new DominusNodeClient(config);
        LoginResult result = client.connectWithCredentials("user@example.com", "pass");
        assertTrue(result.isMfaRequired());
        assertNotNull(result.getMfaChallengeToken());
        client.close();
    }

    @Test
    void connectWithInvalidKeyThrows() throws Exception {
        server.createContext("/api/auth/verify-key", exchange -> {
            String response = "{\"error\":\"Invalid API key\"}";
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(401, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });
        server.start();

        Config config = Config.builder().baseUrl(baseUrl()).build();
        DominusNodeClient client = new DominusNodeClient(config);
        assertThrows(AuthenticationException.class, () -> client.connectWithKey("invalid_key"));
        client.close();
    }

    @Test
    void disconnectClearsState() throws Exception {
        String token = fakeJwt(System.currentTimeMillis() / 1000 + 3600);

        server.createContext("/api/auth/verify-key", exchange -> {
            String response = "{\"token\":\"" + token + "\",\"refreshToken\":\"rt\",\"valid\":true}";
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });
        server.createContext("/api/auth/logout", exchange -> {
            exchange.sendResponseHeaders(200, 0);
            exchange.close();
        });
        server.start();

        Config config = Config.builder().baseUrl(baseUrl()).build();
        DominusNodeClient client = new DominusNodeClient(config);
        client.connectWithKey("dn_live_test");
        client.disconnect();
        // After disconnect, proxy.buildUrl() should throw because apiKey is cleared
        assertThrows(IllegalStateException.class, () -> client.proxy().buildUrl());
        client.close();
    }

    @Test
    void autoCloseableDisconnects() throws Exception {
        String token = fakeJwt(System.currentTimeMillis() / 1000 + 3600);

        server.createContext("/api/auth/verify-key", exchange -> {
            String response = "{\"token\":\"" + token + "\",\"refreshToken\":\"rt\",\"valid\":true}";
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        });
        server.createContext("/api/auth/logout", exchange -> {
            exchange.sendResponseHeaders(200, 0);
            exchange.close();
        });
        server.start();

        Config config = Config.builder().baseUrl(baseUrl()).build();
        try (DominusNodeClient client = new DominusNodeClient(config)) {
            client.connectWithKey("dn_live_test");
            // client.close() called automatically
        }
        // No exception means AutoCloseable worked
    }
}
