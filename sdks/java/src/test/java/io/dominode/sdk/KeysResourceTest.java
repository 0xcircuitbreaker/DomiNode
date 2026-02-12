package io.dominode.sdk;

import com.sun.net.httpserver.HttpServer;
import io.dominode.sdk.errors.DomiNodeException;
import io.dominode.sdk.errors.NotFoundException;
import io.dominode.sdk.types.ApiKey;
import io.dominode.sdk.types.CreatedApiKey;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for KeysResource: create, list, and revoke.
 */
class KeysResourceTest {

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

    private DomiNodeClient createAuthedClient() throws DomiNodeException, IOException {
        String token = fakeJwt(System.currentTimeMillis() / 1000 + 3600);
        server.createContext("/api/auth/verify-key", exchange -> {
            respondJson(exchange, 200,
                    "{\"token\":\"" + token + "\",\"refreshToken\":\"rt\",\"valid\":true}");
        });
        server.start();

        Config config = Config.builder().baseUrl(baseUrl()).build();
        DomiNodeClient client = new DomiNodeClient(config);
        client.connectWithKey("dn_live_test");
        return client;
    }

    @Test
    void createKeyReturnsRawKey() throws Exception {
        server.createContext("/api/keys", exchange -> {
            if ("POST".equals(exchange.getRequestMethod())) {
                respondJson(exchange, 200,
                        "{\"key\":\"dn_live_rawkey123\",\"id\":\"k1\",\"prefix\":\"dn_live_raw\","
                                + "\"label\":\"Test Key\",\"created_at\":\"2025-01-01T00:00:00Z\"}");
            }
        });

        DomiNodeClient client = createAuthedClient();
        CreatedApiKey key = client.keys().create("Test Key");
        assertEquals("dn_live_rawkey123", key.getKey());
        assertEquals("k1", key.getId());
        assertEquals("Test Key", key.getLabel());
        // toString should redact key
        assertTrue(key.toString().contains("[REDACTED]"));
        assertFalse(key.toString().contains("dn_live_rawkey123"));
        client.close();
    }

    @Test
    void listKeysReturnsArray() throws Exception {
        server.createContext("/api/keys", exchange -> {
            if ("GET".equals(exchange.getRequestMethod())) {
                respondJson(exchange, 200,
                        "{\"keys\":[{\"id\":\"k1\",\"prefix\":\"dn_live_abc\",\"label\":\"Key 1\","
                                + "\"created_at\":\"2025-01-01\",\"revoked_at\":null},"
                                + "{\"id\":\"k2\",\"prefix\":\"dn_live_def\",\"label\":\"Key 2\","
                                + "\"created_at\":\"2025-01-02\",\"revoked_at\":\"2025-06-01\"}]}");
            }
        });

        DomiNodeClient client = createAuthedClient();
        List<ApiKey> keys = client.keys().list();
        assertEquals(2, keys.size());
        assertEquals("k1", keys.get(0).getId());
        assertEquals("Key 1", keys.get(0).getLabel());
        assertNull(keys.get(0).getRevokedAt());
        assertEquals("2025-06-01", keys.get(1).getRevokedAt());
        client.close();
    }

    @Test
    void revokeKeyCallsDelete() throws Exception {
        final boolean[] deleteCalled = {false};
        server.createContext("/api/keys/k1", exchange -> {
            if ("DELETE".equals(exchange.getRequestMethod())) {
                deleteCalled[0] = true;
                exchange.sendResponseHeaders(200, 0);
                exchange.close();
            }
        });

        DomiNodeClient client = createAuthedClient();
        client.keys().revoke("k1");
        assertTrue(deleteCalled[0]);
        client.close();
    }

    @Test
    void revokeNonexistentKeyThrowsNotFound() throws Exception {
        server.createContext("/api/keys/nonexistent", exchange -> {
            respondJson(exchange, 404, "{\"error\":\"Key not found\"}");
        });

        DomiNodeClient client = createAuthedClient();
        assertThrows(NotFoundException.class, () -> client.keys().revoke("nonexistent"));
        client.close();
    }

    @Test
    void createKeyWithDefaultLabel() throws Exception {
        final String[] receivedBody = {null};
        server.createContext("/api/keys", exchange -> {
            if ("POST".equals(exchange.getRequestMethod())) {
                receivedBody[0] = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                respondJson(exchange, 200,
                        "{\"key\":\"dn_live_key\",\"id\":\"k1\",\"prefix\":\"dn_live_\","
                                + "\"label\":\"Default\",\"created_at\":\"2025-01-01\"}");
            }
        });

        DomiNodeClient client = createAuthedClient();
        CreatedApiKey key = client.keys().create(null);
        assertNotNull(key);
        assertTrue(receivedBody[0].contains("\"Default\""));
        client.close();
    }
}
