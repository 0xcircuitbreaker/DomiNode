package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Geo-targeting capabilities of the proxy service.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class GeoTargeting {

    private final boolean stateSupport;
    private final boolean citySupport;
    private final boolean asnSupport;

    @JsonCreator
    public GeoTargeting(
            @JsonProperty("stateSupport") boolean stateSupport,
            @JsonProperty("citySupport") boolean citySupport,
            @JsonProperty("asnSupport") boolean asnSupport) {
        this.stateSupport = stateSupport;
        this.citySupport = citySupport;
        this.asnSupport = asnSupport;
    }

    /** Whether state-level targeting is supported. */
    public boolean isStateSupport() { return stateSupport; }

    /** Whether city-level targeting is supported. */
    public boolean isCitySupport() { return citySupport; }

    /** Whether ASN-level targeting is supported. */
    public boolean isAsnSupport() { return asnSupport; }

    @Override
    public String toString() {
        return "GeoTargeting{stateSupport=" + stateSupport
                + ", citySupport=" + citySupport + ", asnSupport=" + asnSupport + "}";
    }
}
