package io.dominode.sdk.resources;

import io.dominode.sdk.errors.DomiNodeException;
import io.dominode.sdk.internal.HttpClient;
import io.dominode.sdk.types.ProxyConfig;
import io.dominode.sdk.types.ProxyHealth;
import io.dominode.sdk.types.ProxyStatus;
import io.dominode.sdk.types.ProxyUrlOptions;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.function.Supplier;

/**
 * Proxy operations: URL building, health checks, status, and configuration.
 */
public final class ProxyResource {

    private final HttpClient http;
    private final String proxyHost;
    private final int httpProxyPort;
    private final int socks5ProxyPort;
    private final Supplier<String> getApiKey;

    /**
     * @param http            the HTTP client
     * @param proxyHost       proxy server hostname
     * @param httpProxyPort   HTTP proxy port
     * @param socks5ProxyPort SOCKS5 proxy port
     * @param getApiKey       supplier for the current API key
     */
    public ProxyResource(HttpClient http, String proxyHost, int httpProxyPort,
                         int socks5ProxyPort, Supplier<String> getApiKey) {
        this.http = http;
        this.proxyHost = proxyHost;
        this.httpProxyPort = httpProxyPort;
        this.socks5ProxyPort = socks5ProxyPort;
        this.getApiKey = getApiKey;
    }

    /**
     * Build a proxy URL using the stored API key and default options (HTTP protocol).
     *
     * @return a fully-formed proxy URL string
     * @throws IllegalStateException if no API key is set
     */
    public String buildUrl() {
        String apiKey = getApiKey.get();
        if (apiKey == null) {
            throw new IllegalStateException("No API key set. Call connectWithKey() first.");
        }
        return buildUrl(apiKey, null);
    }

    /**
     * Build a proxy URL using the stored API key with options.
     *
     * @param options proxy URL options (protocol, geo-targeting, session)
     * @return a fully-formed proxy URL string
     * @throws IllegalStateException if no API key is set
     */
    public String buildUrl(ProxyUrlOptions options) {
        String apiKey = getApiKey.get();
        if (apiKey == null) {
            throw new IllegalStateException("No API key set. Call connectWithKey() first.");
        }
        return buildUrl(apiKey, options);
    }

    /**
     * Build a proxy URL with an explicit API key and options.
     *
     * <p>The username encodes geo-targeting parameters following PacketStream conventions.
     * Both the username components and the API key are URL-encoded to prevent injection.</p>
     *
     * @param apiKey  the API key to use
     * @param options proxy URL options, or {@code null} for defaults
     * @return a fully-formed proxy URL string
     */
    public String buildUrl(String apiKey, ProxyUrlOptions options) {
        String protocol = "http";
        if (options != null && options.getProtocol() != null) {
            protocol = options.getProtocol();
        }

        int port = "socks5".equals(protocol) ? socks5ProxyPort : httpProxyPort;

        // Build username with geo-targeting parts, all URL-encoded
        StringBuilder username = new StringBuilder("user");
        if (options != null) {
            if (options.getCountry() != null) {
                username.append("-country_").append(encode(options.getCountry()));
            }
            if (options.getState() != null) {
                username.append("-state_").append(encode(options.getState()));
            }
            if (options.getCity() != null) {
                username.append("-city_").append(encode(options.getCity()));
            }
            if (options.getAsn() != null) {
                username.append("-asn_").append(encode(String.valueOf(options.getAsn())));
            }
            if (options.getSessionId() != null) {
                username.append("-session_").append(encode(options.getSessionId()));
            }
        }

        String encodedKey = encode(apiKey);
        return protocol + "://" + username + ":" + encodedKey + "@" + proxyHost + ":" + port;
    }

    /**
     * Get public proxy health status. Does not require authentication.
     *
     * @return proxy health information
     * @throws DomiNodeException on API errors
     */
    public ProxyHealth getHealth() throws DomiNodeException {
        return http.get("/api/proxy/health", ProxyHealth.class, false);
    }

    /**
     * Get detailed proxy status including provider info. Requires authentication.
     *
     * @return proxy status with provider details
     * @throws DomiNodeException on API errors
     */
    public ProxyStatus getStatus() throws DomiNodeException {
        return http.get("/api/proxy/status", ProxyStatus.class);
    }

    /**
     * Get proxy server configuration. Requires authentication.
     *
     * @return proxy configuration
     * @throws DomiNodeException on API errors
     */
    public ProxyConfig getConfig() throws DomiNodeException {
        return http.get("/api/proxy/config", ProxyConfig.class);
    }

    /**
     * URL-encode a string for use in proxy URLs.
     */
    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
