package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Current wallet balance information.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class Wallet {

    private final int balanceCents;
    private final double balanceUsd;
    private final String currency;
    private final String lastToppedUp;

    @JsonCreator
    public Wallet(
            @JsonProperty("balanceCents") int balanceCents,
            @JsonProperty("balanceUsd") double balanceUsd,
            @JsonProperty("currency") String currency,
            @JsonProperty("lastToppedUp") String lastToppedUp) {
        this.balanceCents = balanceCents;
        this.balanceUsd = balanceUsd;
        this.currency = currency;
        this.lastToppedUp = lastToppedUp;
    }

    /** Balance in cents (integer). */
    public int getBalanceCents() { return balanceCents; }

    /** Balance in USD (decimal). */
    public double getBalanceUsd() { return balanceUsd; }

    /** Currency code (e.g., "USD"). */
    public String getCurrency() { return currency; }

    /** ISO 8601 timestamp of last top-up, or {@code null}. */
    public String getLastToppedUp() { return lastToppedUp; }

    @Override
    public String toString() {
        return "Wallet{balanceCents=" + balanceCents + ", currency='" + currency + "'}";
    }
}
