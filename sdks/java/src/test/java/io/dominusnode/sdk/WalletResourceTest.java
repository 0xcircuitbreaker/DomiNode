package io.dominusnode.sdk;

import com.sun.net.httpserver.HttpServer;
import io.dominusnode.sdk.errors.DominusNodeException;
import io.dominusnode.sdk.errors.InsufficientBalanceException;
import io.dominusnode.sdk.types.*;
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
 * Tests for WalletResource: balance, transactions, topup, and forecast.
 */
class WalletResourceTest {

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
    void getBalanceReturnsWallet() throws Exception {
        server.createContext("/api/wallet", exchange -> {
            respondJson(exchange, 200,
                    "{\"balanceCents\":5000,\"balanceUsd\":50.00,\"currency\":\"USD\",\"lastToppedUp\":\"2025-01-01\"}");
        });

        DominusNodeClient client = createAuthedClient();
        Wallet wallet = client.wallet().getBalance();
        assertEquals(5000, wallet.getBalanceCents());
        assertEquals(50.00, wallet.getBalanceUsd(), 0.001);
        assertEquals("USD", wallet.getCurrency());
        client.close();
    }

    @Test
    void getTransactionsReturnsList() throws Exception {
        server.createContext("/api/wallet/transactions", exchange -> {
            respondJson(exchange, 200,
                    "{\"transactions\":[{\"id\":\"t1\",\"type\":\"topup\",\"amountCents\":1000,"
                            + "\"amountUsd\":10.00,\"description\":\"Stripe top-up\","
                            + "\"paymentProvider\":\"stripe\",\"createdAt\":\"2025-01-01\"}]}");
        });

        DominusNodeClient client = createAuthedClient();
        List<WalletTransaction> txns = client.wallet().getTransactions();
        assertEquals(1, txns.size());
        assertEquals("topup", txns.get(0).getType());
        assertEquals(1000, txns.get(0).getAmountCents());
        client.close();
    }

    @Test
    void getTransactionsWithPagination() throws Exception {
        final String[] requestedPath = {null};
        server.createContext("/api/wallet/transactions", exchange -> {
            requestedPath[0] = exchange.getRequestURI().toString();
            respondJson(exchange, 200, "{\"transactions\":[]}");
        });

        DominusNodeClient client = createAuthedClient();
        client.wallet().getTransactions(10, 20);
        assertNotNull(requestedPath[0]);
        assertTrue(requestedPath[0].contains("limit=10"));
        assertTrue(requestedPath[0].contains("offset=20"));
        client.close();
    }

    @Test
    void topupStripeReturnsCheckout() throws Exception {
        server.createContext("/api/wallet/topup/stripe", exchange -> {
            respondJson(exchange, 200,
                    "{\"sessionId\":\"cs_test_123\",\"url\":\"https://checkout.stripe.com/pay/cs_test_123\"}");
        });

        DominusNodeClient client = createAuthedClient();
        StripeCheckout checkout = client.wallet().topupStripe(5000);
        assertEquals("cs_test_123", checkout.getSessionId());
        assertTrue(checkout.getUrl().startsWith("https://checkout.stripe.com"));
        client.close();
    }

    @Test
    void topupCryptoReturnsInvoice() throws Exception {
        server.createContext("/api/wallet/topup/crypto", exchange -> {
            respondJson(exchange, 200,
                    "{\"invoiceId\":\"inv_123\",\"invoiceUrl\":\"https://nowpayments.io/pay/inv_123\","
                            + "\"payCurrency\":\"btc\",\"priceAmount\":50.00}");
        });

        DominusNodeClient client = createAuthedClient();
        CryptoInvoice invoice = client.wallet().topupCrypto(50.0, "btc");
        assertEquals("inv_123", invoice.getInvoiceId());
        assertEquals("btc", invoice.getPayCurrency());
        assertEquals(50.0, invoice.getPriceAmount(), 0.001);
        client.close();
    }

    @Test
    void getForecastReturnsEstimate() throws Exception {
        server.createContext("/api/wallet/forecast", exchange -> {
            respondJson(exchange, 200,
                    "{\"dailyAvgCents\":150,\"daysRemaining\":33,\"trend\":\"stable\",\"trendPct\":2.5}");
        });

        DominusNodeClient client = createAuthedClient();
        WalletForecast forecast = client.wallet().getForecast();
        assertEquals(150, forecast.getDailyAvgCents());
        assertEquals(33, forecast.getDaysRemaining());
        assertEquals("stable", forecast.getTrend());
        client.close();
    }

    @Test
    void topupWithZeroBalanceThrows402() throws Exception {
        server.createContext("/api/wallet/topup/stripe", exchange -> {
            respondJson(exchange, 402, "{\"error\":\"Insufficient balance\"}");
        });

        DominusNodeClient client = createAuthedClient();
        assertThrows(InsufficientBalanceException.class,
                () -> client.wallet().topupStripe(999999999));
        client.close();
    }
}
