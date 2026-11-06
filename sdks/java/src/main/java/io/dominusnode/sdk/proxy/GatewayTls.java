package io.dominusnode.sdk.proxy;

import io.dominusnode.sdk.internal.Validation;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Collection;

/**
 * TLS to the gateway's HTTPS proxy listener ({@code PROXY_TLS_PORT}) so {@code Proxy-Authorization} is
 * encrypted; CONNECT and requests then run inside that channel. Certificate and hostname verification
 * are always on: system roots, plus an optional PEM {@code ca} for the gateway only.
 */
public final class GatewayTls {
    public static final int DEFAULT_PORT = 8443;

    private final int port;
    private final String servername;
    private final SSLSocketFactory factory;

    private GatewayTls(Builder b) {
        if (b.port < 1 || b.port > 65535) throw Validation.invalid("gatewayTls.port must be a TCP port");
        if (b.servername != null && !b.servername.matches("^[A-Za-z0-9.-]{1,253}$")) {
            throw Validation.invalid("gatewayTls.servername is invalid");
        }
        this.port = b.port;
        this.servername = b.servername;
        this.factory = buildFactory(b.caPem);
    }

    /** Defaults: port 8443, system roots, server name = proxyHost. */
    public static GatewayTls defaults() { return builder().build(); }

    public static Builder builder() { return new Builder(); }

    public int port() { return port; }

    /** Name to verify and send as SNI, or null to use the proxy host. */
    public String servername() { return servername; }

    SSLSocketFactory socketFactory() { return factory; }

    private static SSLSocketFactory buildFactory(String caPem) {
        try {
            if (caPem == null) return (SSLSocketFactory) SSLSocketFactory.getDefault();
            Collection<? extends Certificate> extra = CertificateFactory.getInstance("X.509")
                    .generateCertificates(new ByteArrayInputStream(caPem.getBytes(StandardCharsets.US_ASCII)));
            if (extra.isEmpty()) throw Validation.invalid("gatewayTls.ca must contain a PEM certificate");
            KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
            ks.load(null, null);
            TrustManagerFactory sys = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            sys.init((KeyStore) null);
            int i = 0;
            for (TrustManager tm : sys.getTrustManagers()) {
                if (tm instanceof X509TrustManager) {
                    for (X509Certificate c : ((X509TrustManager) tm).getAcceptedIssuers()) ks.setCertificateEntry("sys" + i++, c);
                }
            }
            for (Certificate c : extra) ks.setCertificateEntry("ca" + i++, c);
            TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init(ks);
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, tmf.getTrustManagers(), null);
            return ctx.getSocketFactory();
        } catch (io.dominusnode.sdk.errors.DominusNodeException e) {
            throw e;
        } catch (Exception e) {
            throw Validation.invalid("gatewayTls.ca must contain a PEM certificate");
        }
    }

    @Override
    public String toString() { return "GatewayTls(port=" + port + ", servername=" + servername + ")"; }

    public static final class Builder {
        private int port = DEFAULT_PORT;
        private String caPem;
        private String servername;

        public Builder port(int v) { port = v; return this; }

        /** Extra PEM root certificate trusted for the gateway (added to the system roots). */
        public Builder ca(String pem) { caPem = pem; return this; }

        /** TLS server name (and verified name) when proxyHost is an IP literal or differs. */
        public Builder servername(String v) { servername = v; return this; }

        public GatewayTls build() { return new GatewayTls(this); }
    }
}
