package io.dominusnode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Monthly usage stats relative to the user's plan limits.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class UserPlanUsage {

    private final long monthlyUsageBytes;
    private final double monthlyUsageGB;
    private final long limitBytes;
    private final Double limitGB;
    private final Double percentUsed;

    @JsonCreator
    public UserPlanUsage(
            @JsonProperty("monthlyUsageBytes") long monthlyUsageBytes,
            @JsonProperty("monthlyUsageGB") double monthlyUsageGB,
            @JsonProperty("limitBytes") long limitBytes,
            @JsonProperty("limitGB") Double limitGB,
            @JsonProperty("percentUsed") Double percentUsed) {
        this.monthlyUsageBytes = monthlyUsageBytes;
        this.monthlyUsageGB = monthlyUsageGB;
        this.limitBytes = limitBytes;
        this.limitGB = limitGB;
        this.percentUsed = percentUsed;
    }

    /** Bytes used this month. */
    public long getMonthlyUsageBytes() { return monthlyUsageBytes; }

    /** Gigabytes used this month. */
    public double getMonthlyUsageGB() { return monthlyUsageGB; }

    /** Plan limit in bytes. */
    public long getLimitBytes() { return limitBytes; }

    /** Plan limit in GB, or {@code null} for unlimited. */
    public Double getLimitGB() { return limitGB; }

    /** Percent of limit used, or {@code null} for unlimited plans. */
    public Double getPercentUsed() { return percentUsed; }

    @Override
    public String toString() {
        return "UserPlanUsage{monthlyUsageGB=" + monthlyUsageGB
                + ", limitGB=" + limitGB + ", percentUsed=" + percentUsed + "}";
    }
}
