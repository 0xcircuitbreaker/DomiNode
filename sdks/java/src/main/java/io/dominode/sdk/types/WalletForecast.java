package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Spending forecast based on recent usage patterns.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class WalletForecast {

    private final int dailyAvgCents;
    private final Integer daysRemaining;
    private final String trend;
    private final double trendPct;

    @JsonCreator
    public WalletForecast(
            @JsonProperty("dailyAvgCents") int dailyAvgCents,
            @JsonProperty("daysRemaining") Integer daysRemaining,
            @JsonProperty("trend") String trend,
            @JsonProperty("trendPct") double trendPct) {
        this.dailyAvgCents = dailyAvgCents;
        this.daysRemaining = daysRemaining;
        this.trend = trend;
        this.trendPct = trendPct;
    }

    /** Average daily spending in cents. */
    public int getDailyAvgCents() { return dailyAvgCents; }

    /** Estimated days until balance runs out, or {@code null} if no usage. */
    public Integer getDaysRemaining() { return daysRemaining; }

    /** Trend direction: "up", "down", or "stable". */
    public String getTrend() { return trend; }

    /** Trend percentage change. */
    public double getTrendPct() { return trendPct; }

    @Override
    public String toString() {
        return "WalletForecast{dailyAvgCents=" + dailyAvgCents
                + ", daysRemaining=" + daysRemaining
                + ", trend='" + trend + "'}";
    }
}
