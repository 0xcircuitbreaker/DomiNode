package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A subscription plan available on the platform.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class Plan {

    private final String id;
    private final String name;
    private final int pricePerGbCents;
    private final double pricePerGbUsd;
    private final long monthlyBandwidthBytes;
    private final Double monthlyBandwidthGB;
    private final boolean isDefault;

    @JsonCreator
    public Plan(
            @JsonProperty("id") String id,
            @JsonProperty("name") String name,
            @JsonProperty("pricePerGbCents") int pricePerGbCents,
            @JsonProperty("pricePerGbUsd") double pricePerGbUsd,
            @JsonProperty("monthlyBandwidthBytes") long monthlyBandwidthBytes,
            @JsonProperty("monthlyBandwidthGB") Double monthlyBandwidthGB,
            @JsonProperty("isDefault") boolean isDefault) {
        this.id = id;
        this.name = name;
        this.pricePerGbCents = pricePerGbCents;
        this.pricePerGbUsd = pricePerGbUsd;
        this.monthlyBandwidthBytes = monthlyBandwidthBytes;
        this.monthlyBandwidthGB = monthlyBandwidthGB;
        this.isDefault = isDefault;
    }

    /** Plan identifier. */
    public String getId() { return id; }

    /** Plan display name. */
    public String getName() { return name; }

    /** Price per GB in cents. */
    public int getPricePerGbCents() { return pricePerGbCents; }

    /** Price per GB in USD. */
    public double getPricePerGbUsd() { return pricePerGbUsd; }

    /** Monthly bandwidth limit in bytes. */
    public long getMonthlyBandwidthBytes() { return monthlyBandwidthBytes; }

    /** Monthly bandwidth limit in GB, or {@code null} for unlimited. */
    public Double getMonthlyBandwidthGB() { return monthlyBandwidthGB; }

    /** Whether this is the default plan for new users. */
    public boolean isDefault() { return isDefault; }

    @Override
    public String toString() {
        return "Plan{id='" + id + "', name='" + name + "', pricePerGbCents=" + pricePerGbCents + "}";
    }
}
