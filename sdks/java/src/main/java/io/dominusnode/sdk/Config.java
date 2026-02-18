package io.dominusnode.sdk;

import java.time.Duration;

/**
 * Configuration for the Dominus Node client.
 *
 * <p>Uses the builder pattern for fluent construction:</p>
 * <pre>{@code
 * Config config = Config.builder()
 *     .baseUrl("http://localhost:3000")
 *     .apiKey("dn_live_abc123")
 *     .build();
 * }</pre>
 */
public final class Config {

    /** Default Dominus Node API base URL. */
    public static final String DEFAULT_BASE_URL = "https://api.dominusnode.com";

    /** Default proxy server hostname. */
    public static final String DEFAULT_PROXY_HOST = "proxy.dominusnode.com";

    /** Default HTTP proxy port. */
    public static final int DEFAULT_HTTP_PROXY_PORT = 8080;

    /** Default SOCKS5 proxy port. */
    public static final int DEFAULT_SOCKS5_PROXY_PORT = 1080;

    private final String baseUrl;
    private final String apiKey;
    private final String email;
    private final String password;
    private final String accessToken;
    private final String refreshToken;
    private final String proxyHost;
    private final int httpProxyPort;
    private final int socks5ProxyPort;
    private final Duration timeout;

    private Config(Builder builder) {
        this.baseUrl = builder.baseUrl;
        this.apiKey = builder.apiKey;
        this.email = builder.email;
        this.password = builder.password;
        this.accessToken = builder.accessToken;
        this.refreshToken = builder.refreshToken;
        this.proxyHost = builder.proxyHost;
        this.httpProxyPort = builder.httpProxyPort;
        this.socks5ProxyPort = builder.socks5ProxyPort;
        this.timeout = builder.timeout;
    }

    /** API base URL. */
    public String getBaseUrl() { return baseUrl; }

    /** API key for auto-connection, or {@code null}. */
    public String getApiKey() { return apiKey; }

    /** Email for credential-based auto-connection, or {@code null}. */
    public String getEmail() { return email; }

    /** Password for credential-based auto-connection, or {@code null}. */
    public String getPassword() { return password; }

    /** Pre-existing access token, or {@code null}. */
    public String getAccessToken() { return accessToken; }

    /** Pre-existing refresh token, or {@code null}. */
    public String getRefreshToken() { return refreshToken; }

    /** Proxy server hostname. */
    public String getProxyHost() { return proxyHost; }

    /** HTTP proxy port number. */
    public int getHttpProxyPort() { return httpProxyPort; }

    /** SOCKS5 proxy port number. */
    public int getSocks5ProxyPort() { return socks5ProxyPort; }

    /** HTTP request timeout. */
    public Duration getTimeout() { return timeout; }

    @Override
    public String toString() {
        return "Config{baseUrl='" + baseUrl + "'"
                + ", apiKey=" + (apiKey != null ? "'<redacted>'" : "null")
                + ", email=" + (email != null ? "'<redacted>'" : "null")
                + ", password=" + (password != null ? "'<redacted>'" : "null")
                + ", accessToken=" + (accessToken != null ? "'<redacted>'" : "null")
                + ", refreshToken=" + (refreshToken != null ? "'<redacted>'" : "null")
                + ", proxyHost='" + proxyHost + "'"
                + ", httpProxyPort=" + httpProxyPort
                + ", socks5ProxyPort=" + socks5ProxyPort
                + ", timeout=" + timeout
                + "}";
    }

    /**
     * Create a new configuration builder.
     *
     * @return a new builder with default values
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Builder for {@link Config}.
     */
    public static final class Builder {
        private String baseUrl = DEFAULT_BASE_URL;
        private String apiKey;
        private String email;
        private String password;
        private String accessToken;
        private String refreshToken;
        private String proxyHost = DEFAULT_PROXY_HOST;
        private int httpProxyPort = DEFAULT_HTTP_PROXY_PORT;
        private int socks5ProxyPort = DEFAULT_SOCKS5_PROXY_PORT;
        private Duration timeout = Duration.ofSeconds(30);

        private Builder() {}

        /** Set the API base URL. */
        public Builder baseUrl(String baseUrl) { this.baseUrl = baseUrl; return this; }

        /** Set the API key for auto-connection on client creation. */
        public Builder apiKey(String apiKey) { this.apiKey = apiKey; return this; }

        /** Set the email for credential-based auto-connection. */
        public Builder email(String email) { this.email = email; return this; }

        /** Set the password for credential-based auto-connection. */
        public Builder password(String password) { this.password = password; return this; }

        /** Set a pre-existing access token. */
        public Builder accessToken(String accessToken) { this.accessToken = accessToken; return this; }

        /** Set a pre-existing refresh token. */
        public Builder refreshToken(String refreshToken) { this.refreshToken = refreshToken; return this; }

        /** Set the proxy server hostname. */
        public Builder proxyHost(String proxyHost) { this.proxyHost = proxyHost; return this; }

        /** Set the HTTP proxy port. */
        public Builder httpProxyPort(int httpProxyPort) { this.httpProxyPort = httpProxyPort; return this; }

        /** Set the SOCKS5 proxy port. */
        public Builder socks5ProxyPort(int socks5ProxyPort) { this.socks5ProxyPort = socks5ProxyPort; return this; }

        /** Set the HTTP request timeout. */
        public Builder timeout(Duration timeout) { this.timeout = timeout; return this; }

        /** Build the {@link Config} instance.
         *
         * @throws IllegalArgumentException if any configuration is invalid
         */
        public Config build() {
            if (baseUrl == null || baseUrl.isEmpty()) {
                throw new IllegalArgumentException("baseUrl must not be null or empty");
            }
            if (httpProxyPort < 1 || httpProxyPort > 65535) {
                throw new IllegalArgumentException("httpProxyPort must be between 1 and 65535");
            }
            if (socks5ProxyPort < 1 || socks5ProxyPort > 65535) {
                throw new IllegalArgumentException("socks5ProxyPort must be between 1 and 65535");
            }
            if (timeout != null && timeout.isNegative()) {
                throw new IllegalArgumentException("timeout must not be negative");
            }
            return new Config(this);
        }
    }
}
