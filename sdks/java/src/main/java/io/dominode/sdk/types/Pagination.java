package io.dominode.sdk.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Pagination metadata for list responses.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class Pagination {

    private final int limit;
    private final int offset;
    private final int total;
    private final int page;
    private final int totalPages;

    @JsonCreator
    public Pagination(
            @JsonProperty("limit") int limit,
            @JsonProperty("offset") int offset,
            @JsonProperty("total") int total,
            @JsonProperty("page") int page,
            @JsonProperty("totalPages") int totalPages) {
        this.limit = limit;
        this.offset = offset;
        this.total = total;
        this.page = page;
        this.totalPages = totalPages;
    }

    /** Maximum number of items per page. */
    public int getLimit() { return limit; }

    /** Offset from the beginning. */
    public int getOffset() { return offset; }

    /** Total number of items. */
    public int getTotal() { return total; }

    /** Current page number (1-based). */
    public int getPage() { return page; }

    /** Total number of pages. */
    public int getTotalPages() { return totalPages; }

    @Override
    public String toString() {
        return "Pagination{limit=" + limit + ", offset=" + offset + ", total=" + total + "}";
    }
}
