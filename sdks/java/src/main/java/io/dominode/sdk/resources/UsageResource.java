package io.dominode.sdk.resources;

import io.dominode.sdk.errors.DomiNodeException;
import io.dominode.sdk.internal.HttpClient;
import io.dominode.sdk.types.DailyUsageResponse;
import io.dominode.sdk.types.TopHostsResponse;
import io.dominode.sdk.types.UsageResponse;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Usage statistics: detailed records, daily aggregation, top hosts, and CSV export.
 */
public final class UsageResource {

    private final HttpClient http;

    /**
     * @param http the HTTP client
     */
    public UsageResource(HttpClient http) {
        this.http = http;
    }

    /**
     * Get usage records with default parameters.
     *
     * @return usage response with summary, records, and pagination
     * @throws DomiNodeException on API errors
     */
    public UsageResponse get() throws DomiNodeException {
        return get(null, null, -1, -1);
    }

    /**
     * Get usage records for a date range.
     *
     * @param since start date (ISO 8601), or {@code null}
     * @param until end date (ISO 8601), or {@code null}
     * @return usage response
     * @throws DomiNodeException on API errors
     */
    public UsageResponse get(String since, String until) throws DomiNodeException {
        return get(since, until, -1, -1);
    }

    /**
     * Get usage records with date range and pagination.
     *
     * @param since  start date (ISO 8601), or {@code null}
     * @param until  end date (ISO 8601), or {@code null}
     * @param limit  max records (pass -1 for default)
     * @param offset offset for pagination (pass -1 for default)
     * @return usage response
     * @throws DomiNodeException on API errors
     */
    public UsageResponse get(String since, String until, int limit, int offset) throws DomiNodeException {
        String path = buildPath("/api/usage", since, until, limit, offset, null);
        return http.get(path, UsageResponse.class);
    }

    /**
     * Get daily usage aggregation with default date range.
     *
     * @return daily usage response
     * @throws DomiNodeException on API errors
     */
    public DailyUsageResponse getDaily() throws DomiNodeException {
        return getDaily(null, null);
    }

    /**
     * Get daily usage aggregation for a date range.
     *
     * @param since start date (ISO 8601), or {@code null}
     * @param until end date (ISO 8601), or {@code null}
     * @return daily usage response
     * @throws DomiNodeException on API errors
     */
    public DailyUsageResponse getDaily(String since, String until) throws DomiNodeException {
        String path = buildPath("/api/usage/daily", since, until, -1, -1, null);
        return http.get(path, DailyUsageResponse.class);
    }

    /**
     * Get top target hosts by bandwidth with default parameters.
     *
     * @return top hosts response
     * @throws DomiNodeException on API errors
     */
    public TopHostsResponse getTopHosts() throws DomiNodeException {
        return getTopHosts(null, null, null);
    }

    /**
     * Get top target hosts by bandwidth for a date range.
     *
     * @param since start date (ISO 8601), or {@code null}
     * @param until end date (ISO 8601), or {@code null}
     * @param limit max hosts to return, or {@code null} for default
     * @return top hosts response
     * @throws DomiNodeException on API errors
     */
    public TopHostsResponse getTopHosts(String since, String until, Integer limit) throws DomiNodeException {
        String path = buildPath("/api/usage/top-hosts", since, until, limit != null ? limit : -1, -1, null);
        return http.get(path, TopHostsResponse.class);
    }

    /**
     * Export usage records as a CSV string with default date range.
     *
     * @return CSV content
     * @throws DomiNodeException on API errors
     */
    public String exportCsv() throws DomiNodeException {
        return exportCsv(null, null);
    }

    /**
     * Export usage records as a CSV string for a date range.
     *
     * @param since start date (ISO 8601), or {@code null}
     * @param until end date (ISO 8601), or {@code null}
     * @return CSV content
     * @throws DomiNodeException on API errors
     */
    public String exportCsv(String since, String until) throws DomiNodeException {
        String path = buildPath("/api/usage/export", since, until, -1, -1, null);
        return http.getRaw(path, true);
    }

    /**
     * Build a query path with optional parameters.
     */
    private static String buildPath(String base, String since, String until,
                                     int limit, int offset, Integer extraLimit) {
        StringBuilder sb = new StringBuilder(base);
        String sep = "?";
        if (since != null) {
            sb.append(sep).append("since=").append(URLEncoder.encode(since, StandardCharsets.UTF_8));
            sep = "&";
        }
        if (until != null) {
            sb.append(sep).append("until=").append(URLEncoder.encode(until, StandardCharsets.UTF_8));
            sep = "&";
        }
        if (limit >= 0) {
            sb.append(sep).append("limit=").append(limit);
            sep = "&";
        }
        if (offset >= 0) {
            sb.append(sep).append("offset=").append(offset);
        }
        return sb.toString();
    }
}
