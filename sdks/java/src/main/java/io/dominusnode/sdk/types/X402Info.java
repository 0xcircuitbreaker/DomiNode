package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * x402 protocol information response.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class X402Info {

    private final boolean supported;
    private final boolean enabled;
    private final String protocol;
    private final String version;
    private final List<X402Facilitator> facilitators;
    private final X402Pricing pricing;
    private final List<String> currencies;
    private final String walletType;
    private final boolean agenticWallets;

    @JsonCreator
    public X402Info(
            @JsonProperty("supported") boolean supported,
            @JsonProperty("enabled") boolean enabled,
            @JsonProperty("protocol") String protocol,
            @JsonProperty("version") String version,
            @JsonProperty("facilitators") List<X402Facilitator> facilitators,
            @JsonProperty("pricing") X402Pricing pricing,
            @JsonProperty("currencies") List<String> currencies,
            @JsonProperty("walletType") String walletType,
            @JsonProperty("agenticWallets") boolean agenticWallets) {
        this.supported = supported;
        this.enabled = enabled;
        this.protocol = protocol;
        this.version = version;
        this.facilitators = facilitators;
        this.pricing = pricing;
        this.currencies = currencies;
        this.walletType = walletType;
        this.agenticWallets = agenticWallets;
    }

    public boolean isSupported() { return supported; }
    public boolean isEnabled() { return enabled; }
    public String getProtocol() { return protocol; }
    public String getVersion() { return version; }
    public List<X402Facilitator> getFacilitators() { return facilitators; }
    public X402Pricing getPricing() { return pricing; }
    public List<String> getCurrencies() { return currencies; }
    public String getWalletType() { return walletType; }
    public boolean isAgenticWallets() { return agenticWallets; }

    @Override
    public String toString() {
        return "X402Info{supported=" + supported + ", enabled=" + enabled
                + ", protocol='" + protocol + "', version='" + version + "'}";
    }
}
