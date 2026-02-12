package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Revenue data for a single day.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class DailyRevenue {

    private final String date;
    private final int revenueCents;
    private final double revenueUsd;

    @JsonCreator
    public DailyRevenue(
            @JsonProperty("date") String date,
            @JsonProperty("revenueCents") int revenueCents,
            @JsonProperty("revenueUsd") double revenueUsd) {
        this.date = date;
        this.revenueCents = revenueCents;
        this.revenueUsd = revenueUsd;
    }

    /** Date in YYYY-MM-DD format. */
    public String getDate() { return date; }

    /** Revenue in cents for this day. */
    public int getRevenueCents() { return revenueCents; }

    /** Revenue in USD for this day. */
    public double getRevenueUsd() { return revenueUsd; }

    @Override
    public String toString() {
        return "DailyRevenue{date='" + date + "', revenueCents=" + revenueCents + "}";
    }
}
