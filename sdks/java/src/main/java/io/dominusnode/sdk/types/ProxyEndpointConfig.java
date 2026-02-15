package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Configuration for a single proxy endpoint (host and port).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class ProxyEndpointConfig {

    private final String host;
    private final int port;

    @JsonCreator
    public ProxyEndpointConfig(
            @JsonProperty("host") String host,
            @JsonProperty("port") int port) {
        this.host = host;
        this.port = port;
    }

    /** Hostname. */
    public String getHost() { return host; }

    /** Port number. */
    public int getPort() { return port; }

    @Override
    public String toString() {
        return "ProxyEndpointConfig{host='" + host + "', port=" + port + "}";
    }
}
