package io.dominusnode.sdk;

import io.dominusnode.sdk.errors.AuthenticationException;
import io.dominusnode.sdk.errors.ProxyException;
import io.dominusnode.sdk.errors.ValidationException;
import io.dominusnode.sdk.proxy.FetchResponse;
import io.dominusnode.sdk.proxy.HostResolver;
import io.dominusnode.sdk.proxy.ProxyOptions;
import io.dominusnode.sdk.proxy.Ssrf;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static io.dominusnode.sdk.TestSupport.*;
import static org.junit.jupiter.api.Assertions.*;

class ProxyTest {
    static final HostResolver PUBLIC = h -> List.of(InetAddress.getByAddress(h, new byte[]{93, (byte) 184, (byte) 216, 34}));

    // ---- username / url ----

    @Test
    void usernameFlags() {
        assertEquals("relay", ProxyOptions.create().buildUsername());
        assertEquals("country-US-class-residential-session-abc123-wallet-" + UUID + "-allowhttp-1",
                ProxyOptions.create().allowHttp(true).agenticWalletId(UUID.toUpperCase()).sessionId("abc123")
                        .ipClass("residential").country("us").buildUsername());
        assertEquals("class-mobile", ProxyOptions.create().ipClass("mobile").buildUsername());
    }

    @ParameterizedTest
    @ValueSource(strings = {"CU", "ir", "KP", "ru", "SY"})
    void ofacRefused(String c) {
        ValidationException e = assertThrows(ValidationException.class, () -> ProxyOptions.create().country(c).buildUsername());
        assertEquals("INVALID_ARGUMENT", e.getCode());
    }

    @Test
    void flagValidation() {
        assertThrows(ValidationException.class, () -> ProxyOptions.create().country("USA").buildUsername());
        assertThrows(ValidationException.class, () -> ProxyOptions.create().ipClass("auto").buildUsername());
        assertThrows(ValidationException.class, () -> ProxyOptions.create().sessionId("a-b").buildUsername());
        assertThrows(ValidationException.class, () -> ProxyOptions.create().sessionId("x".repeat(65)).buildUsername());
        assertThrows(ValidationException.class, () -> ProxyOptions.create().agenticWalletId("nope").buildUsername());
    }

    @Test
    void buildUrl() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        assertEquals("http://country-DE:" + API_KEY + "@proxy.dominusnode.com:8080", c.proxy().buildUrl(ProxyOptions.create().country("de")));
        assertEquals("socks5://relay:" + API_KEY + "@proxy.dominusnode.com:1080", c.proxy().buildUrl(null, "socks5", null));
        assertEquals("http://relay:dn_test_otherkey99@proxy.dominusnode.com:8080", c.proxy().buildUrl(null, "http", "dn_test_otherkey99"));
        assertEquals("relay", c.proxy().buildUsername(null));
        assertThrows(ValidationException.class, () -> c.proxy().buildUrl(null, "https", null));
        assertThrows(ValidationException.class, () -> c.proxy().buildUrl(null, "http", "not-a-key"));
        DominusNodeClient anon = client(t);
        assertThrows(AuthenticationException.class, () -> anon.proxy().buildUrl(null));
        DominusNodeClient custom = new DominusNodeClient(Config.builder().proxyHost("[::1]").httpProxyPort(3128).transport(t).build());
        assertEquals("http://relay:" + API_KEY + "@[::1]:3128", custom.proxy().buildUrl(null, "http", API_KEY));
        assertThrows(ValidationException.class, () -> new DominusNodeClient(Config.builder().proxyHost("evil.com/x").build()));
        assertThrows(ValidationException.class, () -> new DominusNodeClient(Config.builder().httpProxyPort(0).build()));
        assertThrows(ValidationException.class, () -> new DominusNodeClient(Config.builder().socks5ProxyPort(65536).build()));
    }

    // ---- private address table ----

    @ParameterizedTest
    @ValueSource(strings = {
            "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1",
            "100.64.0.1", "100.127.255.255", "192.0.0.1", "192.0.2.5", "192.0.1.1", "192.0.255.255", "198.18.0.1", "198.19.255.255", "224.0.0.1", "255.255.255.255",
            "2130706433", "0x7f000001", "0177.0.0.1", "127.1", "0x7f.1", "017700000001", "10.0x1.1",
            "::", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "::7f00:1", "::ffff:10.0.0.1",
            "64:ff9b::127.0.0.1", "64:ff9b::a00:1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "fec0::1",
            "ff02::1", "2001:0000:4136:e378::1", "2001::1", "2002:c0a8:0101::1", "2001:db8::1", "0:0:0:0:0:0:0:1"
    })
    void privateAddresses(String ip) {
        assertTrue(Ssrf.isPrivateIp(ip), ip);
    }

    @ParameterizedTest
    @ValueSource(strings = {"8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "192.1.0.1", "198.20.0.1", "2606:4700::1111",
            "::ffff:8.8.8.8", "64:ff9b::8.8.8.8", "example.com", "1.2.3.4.5"})
    void publicAddresses(String ip) {
        assertFalse(Ssrf.isPrivateIp(ip), ip);
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "ftp://example.com/", "file:///etc/passwd", "https://user:pw@example.com/", "https://example.com:8443/",
            "http://localhost/", "https://LOCALHOST./", "https://foo.localhost/", "https://printer.local/",
            "https://svc.internal/", "https://1.0.0.127.in-addr.arpa/", "https://ip6-localhost/", "https://localhost.localdomain/",
            "https://127.0.0.1/", "https://2130706433/", "https://0x7f000001/", "https://[::1]/", "https://[::ffff:7f00:1]/",
            "https://169.254.169.254/latest", "not a url"
    })
    void urlRefusals(String url) {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        c.proxy().setResolver(h -> { throw new AssertionError("no DNS for refused URLs"); });
        assertThrows(ProxyException.class, () -> c.proxy().fetch(url));
    }

    @Test
    void fetchArgumentChecks() {
        MockTransport t = new MockTransport();
        DominusNodeClient c = connected(t);
        c.proxy().setResolver(h -> { throw new AssertionError("no DNS"); });
        assertEquals("INVALID_ARGUMENT", assertThrows(ValidationException.class,
                () -> c.proxy().fetch("https://example.com/", ProxyOptions.create().method("POST"))).getCode());
        assertThrows(ValidationException.class, () -> c.proxy().fetch("http://example.com/"));
        assertThrows(ValidationException.class, () -> c.proxy().fetch("https://example.com/", ProxyOptions.create().header("X-A", "b\r\nEvil: 1")));
        assertThrows(ValidationException.class, () -> c.proxy().fetch("https://example.com/", ProxyOptions.create().header("Bad Name", "v")));
        assertThrows(ValidationException.class, () -> c.proxy().fetch("https://example.com/", ProxyOptions.create().header("X", "a\0b")));
        assertThrows(ValidationException.class, () -> c.proxy().fetch("https://example.com/", ProxyOptions.create().country("RU")));
        assertThrows(AuthenticationException.class, () -> client(t).proxy().fetch("https://example.com/"));
    }

    @Test
    void dnsRebindingMixedAnswer() {
        HostResolver mixed = h -> List.of(InetAddress.getByAddress(h, new byte[]{93, (byte) 184, (byte) 216, 34}),
                InetAddress.getByAddress(h, new byte[]{10, 0, 0, 5}));
        ProxyException e = assertThrows(ProxyException.class, () -> Ssrf.assertPublicResolution("rebind.example", mixed));
        assertTrue(e.getMessage().contains("private"));
        HostResolver v6 = h -> List.of(InetAddress.getByName("::1"));
        assertThrows(ProxyException.class, () -> Ssrf.assertPublicResolution("x.example", v6));
        assertThrows(ProxyException.class, () -> Ssrf.assertPublicResolution("x.example", h -> List.of()));
        assertThrows(ProxyException.class, () -> Ssrf.assertPublicResolution("x.example", h -> { throw new java.net.UnknownHostException(h); }));
        Ssrf.assertPublicResolution("ok.example", PUBLIC);
    }

    // ---- local fake gateway ----

    static final class Gateway implements AutoCloseable {
        final ServerSocket server;
        final List<String> requestLines = new ArrayList<>();
        final AtomicReference<Throwable> error = new AtomicReference<>();
        final Thread thread;

        Gateway(String response, byte[] extraBody) throws Exception {
            server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
            thread = new Thread(() -> {
                try (Socket s = server.accept()) {
                    BufferedReader r = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.ISO_8859_1));
                    String line;
                    while ((line = r.readLine()) != null && !line.isEmpty()) synchronized (requestLines) { requestLines.add(line); }
                    OutputStream out = s.getOutputStream();
                    out.write(response.getBytes(StandardCharsets.ISO_8859_1));
                    if (extraBody != null) out.write(extraBody);
                    out.flush();
                } catch (Throwable e) {
                    error.set(e);
                }
            });
            thread.start();
        }

        int port() { return server.getLocalPort(); }

        List<String> lines() throws InterruptedException {
            thread.join(5000);
            synchronized (requestLines) { return new ArrayList<>(requestLines); }
        }

        @Override
        public void close() throws Exception { server.close(); }
    }

    static DominusNodeClient gatewayClient(MockTransport t, int port) {
        DominusNodeClient c = new DominusNodeClient(Config.builder().baseUrl("https://api.test").transport(t)
                .proxyHost("127.0.0.1").httpProxyPort(port).resolver(PUBLIC).build());
        t.reply(200, "{\"token\":\"" + JWT + "\",\"refreshToken\":\"" + REFRESH + "\"}");
        c.connectWithKey(API_KEY);
        return c;
    }

    @Test
    void httpPathThroughGateway() throws Exception {
        try (Gateway g = new Gateway("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello", null)) {
            DominusNodeClient c = gatewayClient(new MockTransport(), g.port());
            FetchResponse r = c.proxy().fetch("http://example.com/a/b?q=1",
                    ProxyOptions.create().allowHttp(true).country("US").header("X-Test", "1").header("Authorization", "drop me"));
            assertEquals(200, r.status);
            assertEquals("OK", r.statusText);
            assertEquals("hello", r.text());
            assertFalse(r.truncated);
            assertEquals("text/plain", r.headers.get("content-type"));
            List<String> lines = g.lines();
            assertEquals("GET http://example.com/a/b?q=1 HTTP/1.1", lines.get(0));
            String expectedAuth = "Proxy-Authorization: Basic " + Base64.getEncoder().encodeToString(
                    ("country-US-allowhttp-1:" + API_KEY).getBytes(StandardCharsets.UTF_8));
            assertTrue(lines.contains(expectedAuth), lines.toString());
            assertTrue(lines.contains("Host: example.com"));
            assertTrue(lines.contains("Connection: close"));
            assertTrue(lines.contains("X-Test: 1"));
            assertTrue(lines.stream().noneMatch(l -> l.startsWith("Authorization")));
        }
    }

    @Test
    void redirectReturnedNotFollowed() throws Exception {
        try (Gateway g = new Gateway("HTTP/1.1 301 Moved Permanently\r\nLocation: http://169.254.169.254/\r\nContent-Length: 0\r\n\r\n", null)) {
            DominusNodeClient c = gatewayClient(new MockTransport(), g.port());
            FetchResponse r = c.proxy().fetch("http://example.com/", ProxyOptions.create().allowHttp(true));
            assertEquals(301, r.status);
            assertEquals("http://169.254.169.254/", r.headers.get("location"));
            assertEquals(1, g.lines().stream().filter(l -> l.startsWith("GET ")).count());
        }
    }

    @Test
    void bodyTruncatedAtMaxBytes() throws Exception {
        byte[] big = new byte[5000];
        java.util.Arrays.fill(big, (byte) 'z');
        try (Gateway g = new Gateway("HTTP/1.1 200 OK\r\nContent-Length: 5000\r\n\r\n", big)) {
            DominusNodeClient c = gatewayClient(new MockTransport(), g.port());
            FetchResponse r = c.proxy().fetch("http://example.com/", ProxyOptions.create().allowHttp(true).maxBytes(100));
            assertTrue(r.truncated);
            assertEquals(100, r.body.length);
        }
    }

    @Test
    void chunkedBodyAndHead() throws Exception {
        try (Gateway g = new Gateway("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n", null)) {
            DominusNodeClient c = gatewayClient(new MockTransport(), g.port());
            assertEquals("hello world", c.proxy().fetch("http://example.com/", ProxyOptions.create().allowHttp(true)).text());
        }
        try (Gateway g = new Gateway("HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n", null)) {
            DominusNodeClient c = gatewayClient(new MockTransport(), g.port());
            FetchResponse r = c.proxy().fetch("http://example.com/", ProxyOptions.create().allowHttp(true).method("head"));
            assertEquals(0, r.body.length);
            assertTrue(g.lines().get(0).startsWith("HEAD "));
        }
    }

    @Test
    void connectRefused() throws Exception {
        try (Gateway g = new Gateway("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n", null)) {
            DominusNodeClient c = gatewayClient(new MockTransport(), g.port());
            ProxyException e = assertThrows(ProxyException.class, () -> c.proxy().fetch("https://example.com/x", ProxyOptions.create().sessionId("s1")));
            assertEquals(407, e.getStatusCode());
            List<String> lines = g.lines();
            assertEquals("CONNECT example.com:443 HTTP/1.1", lines.get(0));
            assertTrue(lines.contains("Proxy-Authorization: Basic " + Base64.getEncoder().encodeToString(
                    ("session-s1:" + API_KEY).getBytes(StandardCharsets.UTF_8))));
        }
    }

    @Test
    void timeoutRaisesProxyException() throws Exception {
        try (ServerSocket silent = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            DominusNodeClient c = gatewayClient(new MockTransport(), silent.getLocalPort());
            ProxyException e = assertThrows(ProxyException.class,
                    () -> c.proxy().fetch("https://example.com/", ProxyOptions.create().timeoutMs(200)));
            assertTrue(e.getMessage().contains("timed out"), e.getMessage());
            assertFalse(e.getMessage().contains(API_KEY));
        }
    }

    @Test
    void defaultHosts() {
        assertEquals("https://api.dominusnode.com", Config.DEFAULT_BASE_URL);
        assertEquals("proxy.dominusnode.com", Config.DEFAULT_PROXY_HOST);
    }
}
