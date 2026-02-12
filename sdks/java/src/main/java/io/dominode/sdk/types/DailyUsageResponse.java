package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Collections;
import java.util.List;

/**
 * Response containing daily usage aggregation data.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class DailyUsageResponse {

    private final List<DailyUsage> days;
    private final UsagePeriod period;

    @JsonCreator
    public DailyUsageResponse(
            @JsonProperty("days") List<DailyUsage> days,
            @JsonProperty("period") UsagePeriod period) {
        this.days = days != null ? Collections.unmodifiableList(days) : Collections.emptyList();
        this.period = period;
    }

    /** List of daily usage entries. */
    public List<DailyUsage> getDays() { return days; }

    /** Query time period. */
    public UsagePeriod getPeriod() { return period; }

    @Override
    public String toString() {
        return "DailyUsageResponse{days=" + days.size() + " entries}";
    }
}
