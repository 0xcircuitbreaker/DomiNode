package io.dominusnode.sdk.resources;

import com.fasterxml.jackson.databind.JsonNode;
import io.dominusnode.sdk.errors.AuthenticationException;
import io.dominusnode.sdk.internal.ApiClient;
import io.dominusnode.sdk.internal.ApiClient.Auth;
import io.dominusnode.sdk.internal.Validation;
import io.dominusnode.sdk.proxy.FetchResponse;
import io.dominusnode.sdk.proxy.GatewayTls;
import io.dominusnode.sdk.proxy.HostResolver;
import io.dominusnode.sdk.proxy.ProxyFetcher;
import io.dominusnode.sdk.proxy.ProxyOptions;

import java.util.function.Supplier;

/**
 * Proxy gateway helpers. The API key goes in the PASSWORD; routing flags go in the USERNAME
 * (country-US-class-residential-session-abc123-allowhttp-1).
 */
public final class ProxyResource {
    private final ApiClient http;
    private final String host;
    private final int httpPort;
    private final int socksPort;
    private final Supplier<String> apiKey;
    private final GatewayTls gatewayTls;
    private volatile HostResolver resolver;

    public ProxyResource(ApiClient http, String host, int httpPort, int socksPort, Supplier<String> apiKey, HostResolver resolver) {
        this(http, host, httpPort, socksPort, apiKey, resolver, null);
    }

    public ProxyResource(ApiClient http, String host, int httpPort, int socksPort, Supplier<String> apiKey, HostResolver resolver,
                         GatewayTls gatewayTls) {
        if (host == null || !(host.matches("^[A-Za-z0-9.-]{1,253}$") || host.matches("^\\[[0-9A-Fa-f:.]+\\]$"))) {
            throw Validation.invalid("proxyHost contains invalid characters");
        }
        this.http = http;
        this.host = host;
        this.httpPort = port(httpPort, "httpProxyPort");
        this.socksPort = port(socksPort, "socks5ProxyPort");
        this.apiKey = apiKey;
        this.resolver = resolver == null ? HostResolver.SYSTEM : resolver;
        this.gatewayTls = gatewayTls;
    }

    private static int port(int p, String name) {
        if (p < 1 || p > 65535) throw Validation.invalid(name + " must be a TCP port");
        return p;
    }

    private String key(String override) {
        String k = override != null ? override : apiKey.get();
        if (k == null) throw new AuthenticationException("proxy access needs an API key: call connectWithKey() or pass apiKey");
        return Validation.apiKey(k);
    }

    /** Gateway username ("relay" when no flags). */
    public String buildUsername(ProxyOptions options) {
        return (options == null ? ProxyOptions.create() : options).buildUsername();
    }

    public String buildUrl(ProxyOptions options) { return buildUrl(options, null, null); }

    /**
     * {@code <protocol>://<user>:<key>@<proxyHost>:<port>}; protocol http, https (TLS to the gateway; needs
     * gatewayTls) or socks5. Default (null): https when gatewayTls is configured, else http. The result
     * CONTAINS the API key: do not log it.
     */
    public String buildUrl(ProxyOptions options, String protocol, String apiKeyOverride) {
        String proto = protocol == null ? (gatewayTls != null ? "https" : "http") : protocol;
        if (!proto.equals("http") && !proto.equals("https") && !proto.equals("socks5")) {
            throw Validation.invalid("protocol must be http, https or socks5");
        }
        if (proto.equals("https") && gatewayTls == null) throw Validation.invalid("protocol https needs the gatewayTls config");
        ProxyOptions o = options == null ? ProxyOptions.create() : options;
        String user = o.buildUsername();
        String k = key(apiKeyOverride != null ? apiKeyOverride : o.getApiKey());
        int p = proto.equals("socks5") ? socksPort : proto.equals("https") ? gatewayTls.port() : httpPort;
        return proto + "://" + Validation.seg(user) + ":" + Validation.seg(k) + "@" + host + ":" + p;
    }

    public FetchResponse fetch(String url) { return fetch(url, ProxyOptions.create()); }

    /**
     * GET/HEAD a URL through the relay. Ports 80/443 only; private/local targets and names resolving to
     * private addresses are refused; redirects are returned, not followed; body capped at 10 MB;
     * http:// needs allowHttp.
     */
    public FetchResponse fetch(String url, ProxyOptions options) {
        ProxyOptions o = options == null ? ProxyOptions.create() : options;
        String k = key(o.getApiKey());
        String h = host.startsWith("[") ? host.substring(1, host.length() - 1) : host;
        return ProxyFetcher.fetch(h, httpPort, gatewayTls, resolver, k, url, o);
    }

    /** GET /api/proxy/health [none]. */
    public JsonNode getHealth() { return http.get("/api/proxy/health", Auth.NONE); }

    /** GET /api/proxy/config [jwt]. */
    public JsonNode getConfig() { return http.get("/api/proxy/config", Auth.JWT); }

    /** Replace the DNS resolver used by the rebinding check (tests). */
    public void setResolver(HostResolver r) { this.resolver = r == null ? HostResolver.SYSTEM : r; }
}
