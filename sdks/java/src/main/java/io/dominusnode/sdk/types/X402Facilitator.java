package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A facilitator for x402 payments.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class X402Facilitator {

    private final String address;
    private final String chain;
    private final String network;

    @JsonCreator
    public X402Facilitator(
            @JsonProperty("address") String address,
            @JsonProperty("chain") String chain,
            @JsonProperty("network") String network) {
        this.address = address;
        this.chain = chain;
        this.network = network;
    }

    public String getAddress() { return address; }
    public String getChain() { return chain; }
    public String getNetwork() { return network; }

    @Override
    public String toString() {
        return "X402Facilitator{address='" + address + "', chain='" + chain + "', network='" + network + "'}";
    }
}
