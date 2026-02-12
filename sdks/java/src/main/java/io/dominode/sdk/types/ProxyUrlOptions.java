package io.dominode.sdk.types;

/**
 * Options for building a proxy URL with geo-targeting and session configuration.
 *
 * <p>Use the builder pattern to construct instances:</p>
 * <pre>{@code
 * ProxyUrlOptions opts = ProxyUrlOptions.builder()
 *     .protocol("socks5")
 *     .country("US")
 *     .state("CA")
 *     .city("Los Angeles")
 *     .build();
 * }</pre>
 */
public final class ProxyUrlOptions {

    private final String protocol;
    private final String country;
    private final String state;
    private final String city;
    private final Integer asn;
    private final String sessionId;

    private ProxyUrlOptions(Builder builder) {
        this.protocol = builder.protocol;
        this.country = builder.country;
        this.state = builder.state;
        this.city = builder.city;
        this.asn = builder.asn;
        this.sessionId = builder.sessionId;
    }

    /** Protocol: "http" or "socks5". Defaults to "http". */
    public String getProtocol() { return protocol; }

    /** Target country code (e.g., "US", "DE"). */
    public String getCountry() { return country; }

    /** Target state/region code. */
    public String getState() { return state; }

    /** Target city name. */
    public String getCity() { return city; }

    /** Target ASN number. */
    public Integer getAsn() { return asn; }

    /** Sticky session identifier for session persistence. */
    public String getSessionId() { return sessionId; }

    /**
     * Create a new builder for {@link ProxyUrlOptions}.
     *
     * @return a new builder instance
     */
    public static Builder builder() {
        return new Builder();
    }

    @Override
    public String toString() {
        return "ProxyUrlOptions{protocol='" + protocol + "', country='" + country
                + "', state='" + state + "', city='" + city
                + "', asn=" + asn + ", sessionId='" + sessionId + "'}";
    }

    /**
     * Builder for {@link ProxyUrlOptions}.
     */
    public static final class Builder {
        private String protocol;
        private String country;
        private String state;
        private String city;
        private Integer asn;
        private String sessionId;

        private Builder() {}

        /** Set the proxy protocol ("http" or "socks5"). */
        public Builder protocol(String protocol) { this.protocol = protocol; return this; }

        /** Set the target country code. */
        public Builder country(String country) { this.country = country; return this; }

        /** Set the target state/region. */
        public Builder state(String state) { this.state = state; return this; }

        /** Set the target city. */
        public Builder city(String city) { this.city = city; return this; }

        /** Set the target ASN. */
        public Builder asn(int asn) { this.asn = asn; return this; }

        /** Set a sticky session identifier. */
        public Builder sessionId(String sessionId) { this.sessionId = sessionId; return this; }

        /** Build the {@link ProxyUrlOptions} instance. */
        public ProxyUrlOptions build() { return new ProxyUrlOptions(this); }
    }
}
