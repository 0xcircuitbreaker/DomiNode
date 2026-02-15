package io.dominusnode.sdk;

import com.sun.net.httpserver.HttpServer;
import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.types.DailyUsageResponse;
import io.dominusnode.sdk.types.TopHostsResponse;
import io.dominusnode.sdk.types.UsageResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for UsageResource: get, daily, top-hosts, and CSV export.
 */
class UsageResourceTest {

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

    private void respondText(com.sun.net.httpserver.HttpExchange exchange, int status, String text) throws IOException {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/csv");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private DominusNodeClient createAuthedClient() throws DominusNodeException, IOException {
        String token = fakeJwt(System.currentTimeMillis() / 1000 + 3600);
        server.createContext("/api/auth/verify-key", exchange -> {
            respondJson(exchange, 200,
                    "{\"token\":\"" + token + "\",\"refreshToken\":\"rt\",\"valid\":true}");
        });
        server.start();

        Config config = Config.builder().baseUrl(baseUrl()).build();
        DominusNodeClient client = new DominusNodeClient(config);
        client.connectWithKey("dn_live_test");
        return client;
    }

    @Test
    void getUsageReturnsSummaryAndRecords() throws Exception {
        server.createContext("/api/usage", exchange -> {
            respondJson(exchange, 200,
                    "{\"summary\":{\"totalBytes\":1073741824,\"totalCostCents\":700,"
                            + "\"requestCount\":100,\"totalGB\":1.0,\"totalCostUsd\":7.0},"
                            + "\"records\":[{\"id\":\"r1\",\"sessionId\":\"s1\",\"bytesIn\":500,"
                            + "\"bytesOut\":500,\"totalBytes\":1000,\"costCents\":1,"
                            + "\"proxyType\":\"http\",\"targetHost\":\"example.com\","
                            + "\"createdAt\":\"2025-01-01\"}],"
                            + "\"pagination\":{\"limit\":50,\"offset\":0,\"total\":1},"
                            + "\"period\":{\"since\":\"2025-01-01\",\"until\":\"2025-01-31\"}}");
        });

        DominusNodeClient client = createAuthedClient();
        UsageResponse resp = client.usage().get();
        assertNotNull(resp.getSummary());
        assertEquals(1073741824L, resp.getSummary().getTotalBytes());
        assertEquals(700, resp.getSummary().getTotalCostCents());
        assertEquals(1, resp.getRecords().size());
        assertEquals("example.com", resp.getRecords().get(0).getTargetHost());
        client.close();
    }

    @Test
    void getUsageWithDateRange() throws Exception {
        final String[] requestedPath = {null};
        server.createContext("/api/usage", exchange -> {
            requestedPath[0] = exchange.getRequestURI().toString();
            respondJson(exchange, 200,
                    "{\"summary\":{\"totalBytes\":0,\"totalCostCents\":0,\"requestCount\":0,"
                            + "\"totalGB\":0,\"totalCostUsd\":0},\"records\":[],"
                            + "\"pagination\":{\"limit\":50,\"offset\":0,\"total\":0},"
                            + "\"period\":{\"since\":\"2025-06-01\",\"until\":\"2025-06-30\"}}");
        });

        DominusNodeClient client = createAuthedClient();
        client.usage().get("2025-06-01", "2025-06-30");
        assertNotNull(requestedPath[0]);
        assertTrue(requestedPath[0].contains("since=2025-06-01"));
        assertTrue(requestedPath[0].contains("until=2025-06-30"));
        client.close();
    }

    @Test
    void getDailyUsageReturnsDays() throws Exception {
        server.createContext("/api/usage/daily", exchange -> {
            respondJson(exchange, 200,
                    "{\"days\":[{\"date\":\"2025-01-01\",\"totalBytes\":5000000,"
                            + "\"totalGB\":0.005,\"totalCostCents\":4,\"totalCostUsd\":0.04,"
                            + "\"requestCount\":10}],"
                            + "\"period\":{\"since\":\"2025-01-01\",\"until\":\"2025-01-31\"}}");
        });

        DominusNodeClient client = createAuthedClient();
        DailyUsageResponse resp = client.usage().getDaily();
        assertEquals(1, resp.getDays().size());
        assertEquals("2025-01-01", resp.getDays().get(0).getDate());
        assertEquals(10, resp.getDays().get(0).getRequestCount());
        client.close();
    }

    @Test
    void getTopHostsReturnsList() throws Exception {
        server.createContext("/api/usage/top-hosts", exchange -> {
            respondJson(exchange, 200,
                    "{\"hosts\":[{\"targetHost\":\"api.example.com\",\"totalBytes\":100000,"
                            + "\"totalGB\":0.0001,\"requestCount\":50}],"
                            + "\"period\":{\"since\":\"2025-01-01\",\"until\":\"2025-01-31\"}}");
        });

        DominusNodeClient client = createAuthedClient();
        TopHostsResponse resp = client.usage().getTopHosts();
        assertEquals(1, resp.getHosts().size());
        assertEquals("api.example.com", resp.getHosts().get(0).getTargetHost());
        assertEquals(50, resp.getHosts().get(0).getRequestCount());
        client.close();
    }

    @Test
    void getTopHostsWithLimit() throws Exception {
        final String[] requestedPath = {null};
        server.createContext("/api/usage/top-hosts", exchange -> {
            requestedPath[0] = exchange.getRequestURI().toString();
            respondJson(exchange, 200,
                    "{\"hosts\":[],\"period\":{\"since\":\"2025-01-01\",\"until\":\"2025-01-31\"}}");
        });

        DominusNodeClient client = createAuthedClient();
        client.usage().getTopHosts(null, null, 5);
        assertNotNull(requestedPath[0]);
        assertTrue(requestedPath[0].contains("limit=5"));
        client.close();
    }

    @Test
    void exportCsvReturnsString() throws Exception {
        server.createContext("/api/usage/export", exchange -> {
            respondText(exchange, 200,
                    "date,bytes_in,bytes_out,total_bytes,cost_cents\n2025-01-01,500,500,1000,1");
        });

        DominusNodeClient client = createAuthedClient();
        String csv = client.usage().exportCsv();
        assertTrue(csv.contains("date,bytes_in"));
        assertTrue(csv.contains("2025-01-01"));
        client.close();
    }

    @Test
    void exportCsvWithDateRange() throws Exception {
        final String[] requestedPath = {null};
        server.createContext("/api/usage/export", exchange -> {
            requestedPath[0] = exchange.getRequestURI().toString();
            respondText(exchange, 200, "date,bytes\n");
        });

        DominusNodeClient client = createAuthedClient();
        client.usage().exportCsv("2025-06-01", "2025-06-30");
        assertTrue(requestedPath[0].contains("since=2025-06-01"));
        assertTrue(requestedPath[0].contains("until=2025-06-30"));
        client.close();
    }
}
