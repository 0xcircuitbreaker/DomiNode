package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Result from wallet link endpoint.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class WalletLinkResult {

    private final boolean success;
    private final String walletAddress;

    @JsonCreator
    public WalletLinkResult(
            @JsonProperty("success") boolean success,
            @JsonProperty("walletAddress") String walletAddress) {
        this.success = success;
        this.walletAddress = walletAddress;
    }

    public boolean isSuccess() { return success; }
    public String getWalletAddress() { return walletAddress; }

    @Override
    public String toString() {
        return "WalletLinkResult{success=" + success + ", walletAddress='" + walletAddress + "'}";
    }
}
