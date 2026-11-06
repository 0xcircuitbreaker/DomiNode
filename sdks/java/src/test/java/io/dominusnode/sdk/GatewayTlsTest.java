package io.dominusnode.sdk;

import io.dominusnode.sdk.errors.ProxyException;
import io.dominusnode.sdk.errors.ValidationException;
import io.dominusnode.sdk.proxy.FetchResponse;
import io.dominusnode.sdk.proxy.GatewayTls;
import io.dominusnode.sdk.proxy.HostResolver;
import io.dominusnode.sdk.proxy.ProxyOptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.net.ServerSocketFactory;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import static io.dominusnode.sdk.TestSupport.*;
import static org.junit.jupiter.api.Assertions.*;

/** CONNECT tunnel integrity (no direct dial to the target) and gatewayTls (TLS to the gateway). */
class GatewayTlsTest {
    static final HostResolver PUBLIC = h -> List.of(InetAddress.getByAddress(h, new byte[]{93, (byte) 184, (byte) 216, 34}));
    static String caPem;
    static SSLContext serverCtx;

    @BeforeAll
    static void makeCert(@TempDir Path dir) throws Exception {
        String keytool = Path.of(System.getProperty("java.home"), "bin", "keytool").toString();
        Path ks = dir.resolve("gw.p12");
        run(keytool, "-genkeypair", "-alias", "gw", "-keyalg", "RSA", "-keysize", "2048", "-validity", "1",
                "-dname", "CN=localhost", "-ext", "san=dns:localhost,ip:127.0.0.1", "-storetype", "PKCS12",
                "-keystore", ks.toString(), "-storepass", "changeit", "-keypass", "changeit");
        Path pem = dir.resolve("gw.pem");
        run(keytool, "-exportcert", "-rfc", "-alias", "gw", "-keystore", ks.toString(), "-storepass", "changeit",
                "-file", pem.toString());
        caPem = Files.readString(pem);
        KeyStore store = KeyStore.getInstance("PKCS12");
        try (FileInputStream in = new FileInputStream(ks.toFile())) { store.load(in, "changeit".toCharArray()); }
        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(store, "changeit".toCharArray());
        serverCtx = SSLContext.getInstance("TLS");
        serverCtx.init(kmf.getKeyManagers(), null, null);
    }

    static void run(String... cmd) throws Exception {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(0, p.waitFor(), out);
    }

    /** Fake gateway: after 200 to CONNECT it records the first bytes on the SAME connection. */
    static final class Gw implements AutoCloseable {
        final ServerSocket server;
        final List<String> heads = new CopyOnWriteArrayList<>();
        final List<byte[]> tunneled = new CopyOnWriteArrayList<>();
        final AtomicInteger accepted = new AtomicInteger();

        Gw(boolean tls, String httpResponse) throws Exception {
            ServerSocketFactory f = tls ? serverCtx.getServerSocketFactory() : ServerSocketFactory.getDefault();
            server = f.createServerSocket(0, 5, InetAddress.getLoopbackAddress());
            Thread t = new Thread(() -> {
                while (true) {
                    try (Socket s = server.accept()) {
                        accepted.incrementAndGet();
                        s.setSoTimeout(3000);
                        InputStream in = s.getInputStream();
                        ByteArrayOutputStream head = new ByteArrayOutputStream();
                        int c;
                        while ((c = in.read()) != -1) {
                            head.write(c);
                            if (head.toString(StandardCharsets.ISO_8859_1).endsWith("\r\n\r\n")) break;
                        }
                        String h = head.toString(StandardCharsets.ISO_8859_1);
                        heads.add(h);
                        OutputStream out = s.getOutputStream();
                        if (h.startsWith("CONNECT ")) {
                            out.write("HTTP/1.1 200 Connection Established\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
                            out.flush();
                            byte[] buf = new byte[8192];
                            int n = in.read(buf);
                            tunneled.add(java.util.Arrays.copyOf(buf, Math.max(n, 0)));
                        } else {
                            out.write(httpResponse.getBytes(StandardCharsets.ISO_8859_1));
                            out.flush();
                        }
                    } catch (Exception e) {
                        if (server.isClosed()) return;
                    }
                }
            });
            t.setDaemon(true);
            t.start();
        }

        int port() { return server.getLocalPort(); }

        @Override
        public void close() throws Exception { server.close(); }
    }

    static DominusNodeClient client(Config.Builder b) {
        DominusNodeClient c = new DominusNodeClient(b.baseUrl("https://api.test").transport(new MockTransport()).resolver(PUBLIC).build());
        return c;
    }

    static void assertClientHello(byte[] data, String sni) {
        assertTrue(data.length > 0 && data[0] == 0x16, "first tunneled bytes must be a TLS handshake record");
        assertTrue(new String(data, StandardCharsets.ISO_8859_1).contains(sni), "ClientHello must carry the target SNI");
    }

    @Test
    void httpsRidesConnectTunnelPlainGateway() throws Exception {
        try (Gw gw = new Gw(false, "")) {
            DominusNodeClient c = client(Config.builder().proxyHost("127.0.0.1").httpProxyPort(gw.port()));
            assertThrows(ProxyException.class, () -> c.proxy().fetch("https://example.com/x", ProxyOptions.create().apiKey(API_KEY).timeoutMs(3000)));
            assertEquals(1, gw.accepted.get());
            assertTrue(gw.heads.get(0).startsWith("CONNECT example.com:443 HTTP/1.1\r\n"));
            assertClientHello(gw.tunneled.get(0), "example.com");
        }
    }

    @Test
    void connectInsideGatewayTls() throws Exception {
        try (Gw gw = new Gw(true, "")) {
            DominusNodeClient c = client(Config.builder().proxyHost("localhost")
                    .gatewayTls(GatewayTls.builder().port(gw.port()).ca(caPem).build()));
            // The fake target cert is not publicly trusted: the inner handshake fails after the tunnel.
            ProxyException e = assertThrows(ProxyException.class,
                    () -> c.proxy().fetch("https://example.com/x", ProxyOptions.create().country("US").apiKey(API_KEY).timeoutMs(3000)));
            assertFalse(e.getMessage().contains(API_KEY));
            String head = gw.heads.get(0);
            assertTrue(head.startsWith("CONNECT example.com:443 HTTP/1.1\r\n"), head);
            String want = Base64.getEncoder().encodeToString(("country-US:" + API_KEY).getBytes(StandardCharsets.UTF_8));
            assertTrue(head.contains("Proxy-Authorization: Basic " + want));
            assertClientHello(gw.tunneled.get(0), "example.com");
        }
    }

    @Test
    void httpOverGatewayTlsWithIpAndServername() throws Exception {
        try (Gw gw = new Gw(true, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi")) {
            DominusNodeClient c = client(Config.builder().proxyHost("127.0.0.1")
                    .gatewayTls(GatewayTls.builder().port(gw.port()).ca(caPem).servername("localhost").build()));
            FetchResponse r = c.proxy().fetch("http://example.com/p", ProxyOptions.create().allowHttp(true).apiKey(API_KEY));
            assertEquals("hi", r.text());
            assertTrue(gw.heads.get(0).startsWith("GET http://example.com/p HTTP/1.1\r\n"));
        }
    }

    @Test
    void unverifiedGatewayCertRefusedBeforeSending() throws Exception {
        try (Gw gw = new Gw(true, "")) {
            for (GatewayTls g : List.of(GatewayTls.builder().port(gw.port()).build(),
                    GatewayTls.builder().port(gw.port()).ca(caPem).servername("other.example").build())) {
                DominusNodeClient c = client(Config.builder().proxyHost("localhost").gatewayTls(g));
                ProxyException e = assertThrows(ProxyException.class,
                        () -> c.proxy().fetch("https://example.com/", ProxyOptions.create().apiKey(API_KEY).timeoutMs(3000)));
                assertFalse(e.getMessage().contains(API_KEY));
            }
            Thread.sleep(50);
            assertTrue(gw.heads.isEmpty());
        }
    }

    @Test
    void buildUrlDefaultsToHttps() {
        DominusNodeClient c = client(Config.builder().proxyHost("proxy.example.com").gatewayTls(GatewayTls.defaults()));
        String u = c.proxy().buildUrl(ProxyOptions.create().apiKey(API_KEY));
        assertTrue(u.startsWith("https://relay:dn_live_") && u.endsWith("@proxy.example.com:8443"), u);
        assertTrue(c.proxy().buildUrl(null, "http", API_KEY).endsWith(":8080"));
        DominusNodeClient plain = client(Config.builder().proxyHost("proxy.example.com"));
        assertTrue(plain.proxy().buildUrl(null, null, API_KEY).startsWith("http://"));
        assertThrows(ValidationException.class, () -> plain.proxy().buildUrl(null, "https", API_KEY));
    }

    @Test
    void configValidation() {
        assertThrows(ValidationException.class, () -> GatewayTls.builder().port(0).build());
        assertThrows(ValidationException.class, () -> GatewayTls.builder().port(65536).build());
        assertThrows(ValidationException.class, () -> GatewayTls.builder().servername("bad name").build());
        assertThrows(ValidationException.class, () -> GatewayTls.builder().ca("not pem").build());
    }
}
