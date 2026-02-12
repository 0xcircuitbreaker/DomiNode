package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Collections;
import java.util.List;

/**
 * Proxy server configuration including endpoints, supported countries, and geo-targeting.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class ProxyConfig {

    private final ProxyEndpointConfig httpProxy;
    private final ProxyEndpointConfig socks5Proxy;
    private final List<String> supportedCountries;
    private final List<String> blockedCountries;
    private final GeoTargeting geoTargeting;

    @JsonCreator
    public ProxyConfig(
            @JsonProperty("httpProxy") ProxyEndpointConfig httpProxy,
            @JsonProperty("socks5Proxy") ProxyEndpointConfig socks5Proxy,
            @JsonProperty("supportedCountries") List<String> supportedCountries,
            @JsonProperty("blockedCountries") List<String> blockedCountries,
            @JsonProperty("geoTargeting") GeoTargeting geoTargeting) {
        this.httpProxy = httpProxy;
        this.socks5Proxy = socks5Proxy;
        this.supportedCountries = supportedCountries != null
                ? Collections.unmodifiableList(supportedCountries) : Collections.emptyList();
        this.blockedCountries = blockedCountries != null
                ? Collections.unmodifiableList(blockedCountries) : Collections.emptyList();
        this.geoTargeting = geoTargeting;
    }

    /** HTTP proxy endpoint configuration. */
    public ProxyEndpointConfig getHttpProxy() { return httpProxy; }

    /** SOCKS5 proxy endpoint configuration. */
    public ProxyEndpointConfig getSocks5Proxy() { return socks5Proxy; }

    /** List of country codes supported for geo-targeting. */
    public List<String> getSupportedCountries() { return supportedCountries; }

    /** List of OFAC-blocked country codes. */
    public List<String> getBlockedCountries() { return blockedCountries; }

    /** Geo-targeting capability flags. */
    public GeoTargeting getGeoTargeting() { return geoTargeting; }

    @Override
    public String toString() {
        return "ProxyConfig{httpProxy=" + httpProxy + ", socks5Proxy=" + socks5Proxy
                + ", supportedCountries=" + supportedCountries.size() + " countries}";
    }
}
