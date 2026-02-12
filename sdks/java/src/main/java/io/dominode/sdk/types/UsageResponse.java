package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Collections;
import java.util.List;

/**
 * Usage records response with summary, pagination, and period.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class UsageResponse {

    private final UsageSummary summary;
    private final List<UsageRecord> records;
    private final Pagination pagination;
    private final UsagePeriod period;

    @JsonCreator
    public UsageResponse(
            @JsonProperty("summary") UsageSummary summary,
            @JsonProperty("records") List<UsageRecord> records,
            @JsonProperty("pagination") Pagination pagination,
            @JsonProperty("period") UsagePeriod period) {
        this.summary = summary;
        this.records = records != null ? Collections.unmodifiableList(records) : Collections.emptyList();
        this.pagination = pagination;
        this.period = period;
    }

    /** Aggregated usage summary. */
    public UsageSummary getSummary() { return summary; }

    /** List of individual usage records. */
    public List<UsageRecord> getRecords() { return records; }

    /** Pagination metadata. */
    public Pagination getPagination() { return pagination; }

    /** Query time period. */
    public UsagePeriod getPeriod() { return period; }

    @Override
    public String toString() {
        return "UsageResponse{summary=" + summary + ", records=" + records.size() + " items}";
    }
}
