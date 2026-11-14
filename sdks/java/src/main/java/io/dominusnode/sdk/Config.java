package io.dominusnode.sdk;

import io.dominusnode.sdk.proxy.GatewayTls;
import io.dominusnode.sdk.proxy.HostResolver;

/** Client configuration. Build with {@link #builder()}. */
public final class Config {
    public static final String DEFAULT_BASE_URL = "https://api.dominusnode.com";
    public static final String DEFAULT_PROXY_HOST = "proxy.dominusnode.com";
    public static final int DEFAULT_HTTP_PROXY_PORT = 8080;
    public static final int DEFAULT_SOCKS5_PROXY_PORT = 1080;

    final String baseUrl;
    final String proxyHost;
    final int httpProxyPort;
    final int socks5ProxyPort;
    final String accessToken;
    final String refreshToken;
    final Transport transport;
    final HostResolver resolver;
    final GatewayTls gatewayTls;

    private Config(Builder b) {
        baseUrl = b.baseUrl;
        proxyHost = b.proxyHost;
        httpProxyPort = b.httpProxyPort;
        socks5ProxyPort = b.socks5ProxyPort;
        accessToken = b.accessToken;
        refreshToken = b.refreshToken;
        transport = b.transport;
        resolver = b.resolver;
        gatewayTls = b.gatewayTls;
    }

    public static Builder builder() { return new Builder(); }

    public static Config defaults() { return builder().build(); }

    @Override
    public String toString() { return "Config(baseUrl=" + baseUrl + ", proxyHost=" + proxyHost + ")"; }

    public static final class Builder {
        private String baseUrl = DEFAULT_BASE_URL;
        private String proxyHost = DEFAULT_PROXY_HOST;
        private int httpProxyPort = DEFAULT_HTTP_PROXY_PORT;
        private int socks5ProxyPort = DEFAULT_SOCKS5_PROXY_PORT;
        private String accessToken;
        private String refreshToken;
        private Transport transport;
        private HostResolver resolver;
        // 2.2: TLS to the gateway is the default (production refuses credentials on 8080/1080).
        private GatewayTls gatewayTls = GatewayTls.defaults();

        public Builder baseUrl(String v) { baseUrl = v; return this; }

        public Builder proxyHost(String v) { proxyHost = v; return this; }

        public Builder httpProxyPort(int v) { httpProxyPort = v; return this; }

        public Builder socks5ProxyPort(int v) { socks5ProxyPort = v; return this; }

        /** Pre-existing JWT pair (e.g. from walletAuth.verify()). */
        public Builder tokens(String access, String refresh) { accessToken = access; refreshToken = refresh; return this; }

        /** Custom transport (tests). Must not follow redirects. */
        public Builder transport(Transport v) { transport = v; return this; }

        /** DNS resolver for the proxy.fetch rebinding check (tests). */
        public Builder resolver(HostResolver v) { resolver = v; return this; }

        /**
         * TLS to the gateway (HTTPS proxy listener); buildUrl then defaults to https://. Default since 2.2:
         * {@link GatewayTls#defaults()} (port 8443, self-hosted coordinators
         * too). {@code null} selects plaintext.
         */
        public Builder gatewayTls(GatewayTls v) { gatewayTls = v; return this; }

        /** Plaintext 8080/1080 to the gateway (local dev only; production gateways refuse credentials there). */
        public Builder plaintextGateway() { gatewayTls = null; return this; }

        public Config build() { return new Config(this); }

        @Override
        public String toString() { return "Config.Builder"; }
    }
}
