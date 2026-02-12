package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Proxy server endpoint addresses.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class ProxyEndpoints {

    private final String http;
    private final String socks5;

    @JsonCreator
    public ProxyEndpoints(
            @JsonProperty("http") String http,
            @JsonProperty("socks5") String socks5) {
        this.http = http;
        this.socks5 = socks5;
    }

    /** HTTP proxy endpoint (host:port). */
    public String getHttp() { return http; }

    /** SOCKS5 proxy endpoint (host:port). */
    public String getSocks5() { return socks5; }

    @Override
    public String toString() {
        return "ProxyEndpoints{http='" + http + "', socks5='" + socks5 + "'}";
    }
}
