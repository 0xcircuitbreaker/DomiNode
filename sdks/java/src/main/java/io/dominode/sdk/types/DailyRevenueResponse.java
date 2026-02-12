package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Collections;
import java.util.List;

/**
 * Response containing daily revenue breakdown.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class DailyRevenueResponse {

    private final List<DailyRevenue> days;
    private final UsagePeriod period;

    @JsonCreator
    public DailyRevenueResponse(
            @JsonProperty("days") List<DailyRevenue> days,
            @JsonProperty("period") UsagePeriod period) {
        this.days = days != null ? Collections.unmodifiableList(days) : Collections.emptyList();
        this.period = period;
    }

    /** Daily revenue entries. */
    public List<DailyRevenue> getDays() { return days; }

    /** Query time period. */
    public UsagePeriod getPeriod() { return period; }

    @Override
    public String toString() {
        return "DailyRevenueResponse{days=" + days.size() + " entries}";
    }
}
