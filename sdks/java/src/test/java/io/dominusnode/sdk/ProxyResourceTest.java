package io.dominusnode.sdk;

import com.sun.net.httpserver.HttpServer;
import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.types.ProxyHealth;
import io.dominusnode.sdk.types.ProxyUrlOptions;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for ProxyResource: URL building, geo-targeting, encoding, and health.
 */
class ProxyResourceTest {

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

    private DominusNodeClient createConnectedClient() throws DominusNodeException, IOException {
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
                .proxyHost("proxy.test.io")
                .httpProxyPort(8080)
                .socks5ProxyPort(1080)
                .build();
        DominusNodeClient client = new DominusNodeClient(config);
        client.connectWithKey("dn_live_abc123");
        return client;
    }

    @Test
    void buildUrlDefaultHttp() throws Exception {
        DominusNodeClient client = createConnectedClient();
        String url = client.proxy().buildUrl();
        assertEquals("http://user:dn_live_abc123@proxy.test.io:8080", url);
        client.close();
    }

    @Test
    void buildUrlSocks5Protocol() throws Exception {
        DominusNodeClient client = createConnectedClient();
        ProxyUrlOptions opts = ProxyUrlOptions.builder().protocol("socks5").build();
        String url = client.proxy().buildUrl(opts);
        assertEquals("socks5://user:dn_live_abc123@proxy.test.io:1080", url);
        client.close();
    }

    @Test
    void buildUrlWithCountry() throws Exception {
        DominusNodeClient client = createConnectedClient();
        ProxyUrlOptions opts = ProxyUrlOptions.builder().country("US").build();
        String url = client.proxy().buildUrl(opts);
        assertEquals("http://user-country-US:dn_live_abc123@proxy.test.io:8080", url);
        client.close();
    }

    @Test
    void buildUrlWithFullGeoTargeting() throws Exception {
        DominusNodeClient client = createConnectedClient();
        ProxyUrlOptions opts = ProxyUrlOptions.builder()
                .country("US")
                .state("CA")
                .city("Los Angeles")
                .asn(13335)
                .sessionId("sess_001")
                .build();
        String url = client.proxy().buildUrl(opts);
        assertTrue(url.startsWith("http://user-country-US-state-CA-city-Los+Angeles-asn-13335-session-sess_001:"));
        assertTrue(url.endsWith("@proxy.test.io:8080"));
        client.close();
    }

    @Test
    void buildUrlEncodesSpecialChars() throws Exception {
        DominusNodeClient client = createConnectedClient();
        // Build with an explicit key containing special chars
        ProxyUrlOptions opts = ProxyUrlOptions.builder().country("US").build();
        String url = client.proxy().buildUrl("dn_live_key/with+special&chars", opts);
        // Key should be URL-encoded
        assertTrue(url.contains("dn_live_key%2Fwith%2Bspecial%26chars"));
        client.close();
    }

    @Test
    void buildUrlWithoutKeyThrows() throws Exception {
        server.createContext("/", exchange -> {
            exchange.sendResponseHeaders(404, 0);
            exchange.close();
        });
        server.start();

        Config config = Config.builder().baseUrl(baseUrl()).build();
        DominusNodeClient client = new DominusNodeClient(config);
        assertThrows(IllegalStateException.class, () -> client.proxy().buildUrl());
        client.close();
    }

    @Test
    void buildUrlExplicitApiKey() throws Exception {
        server.createContext("/", exchange -> {
            exchange.sendResponseHeaders(404, 0);
            exchange.close();
        });
        server.start();

        Config config = Config.builder()
                .baseUrl(baseUrl())
                .proxyHost("proxy.test.io")
                .httpProxyPort(8080)
                .socks5ProxyPort(1080)
                .build();
        DominusNodeClient client = new DominusNodeClient(config);
        // Using explicit key does not require connect
        String url = client.proxy().buildUrl("dn_live_explicit", null);
        assertEquals("http://user:dn_live_explicit@proxy.test.io:8080", url);
        client.close();
    }

    @Test
    void getHealthReturnsStatus() throws Exception {
        server.createContext("/api/proxy/health", exchange -> {
            String response = "{\"status\":\"ok\",\"activeSessions\":5,\"uptimeSeconds\":86400}";
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
        ProxyHealth health = client.proxy().getHealth();
        assertEquals("ok", health.getStatus());
        assertEquals(5, health.getActiveSessions());
        assertEquals(86400, health.getUptimeSeconds());
        client.close();
    }
}
