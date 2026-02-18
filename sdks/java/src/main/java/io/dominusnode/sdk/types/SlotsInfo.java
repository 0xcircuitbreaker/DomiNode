package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Registration slot availability information.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class SlotsInfo {

    private final int total;
    private final int used;
    private final int remaining;
    private final boolean unlimited;

    @JsonCreator
    public SlotsInfo(
            @JsonProperty("total") int total,
            @JsonProperty("used") int used,
            @JsonProperty("remaining") int remaining,
            @JsonProperty("unlimited") boolean unlimited) {
        this.total = total;
        this.used = used;
        this.remaining = remaining;
        this.unlimited = unlimited;
    }

    /** Total number of registration slots. */
    public int getTotal() { return total; }

    /** Number of slots currently used. */
    public int getUsed() { return used; }

    /** Number of remaining available slots. */
    public int getRemaining() { return remaining; }

    /** Whether registration is unlimited (no slot cap). */
    public boolean isUnlimited() { return unlimited; }

    @Override
    public String toString() {
        return "SlotsInfo{total=" + total + ", used=" + used + ", remaining=" + remaining
                + ", unlimited=" + unlimited + "}";
    }
}
