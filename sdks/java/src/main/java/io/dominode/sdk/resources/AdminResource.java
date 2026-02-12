package io.dominode.sdk.resources;

import io.dominode.sdk.errors.DomiNodeException;
import io.dominode.sdk.internal.HttpClient;
import io.dominode.sdk.internal.JsonUtil;
import io.dominode.sdk.types.AdminUserDetail;
import io.dominode.sdk.types.AdminUsersResponse;
import io.dominode.sdk.types.DailyRevenueResponse;
import io.dominode.sdk.types.RevenueStats;
import io.dominode.sdk.types.SystemStats;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Admin operations: user management, revenue statistics, and system stats.
 *
 * <p>All methods in this resource require admin privileges.</p>
 */
public final class AdminResource {

    private final HttpClient http;

    /**
     * @param http the HTTP client
     */
    public AdminResource(HttpClient http) {
        this.http = http;
    }

    /**
     * List all users with default pagination.
     *
     * @return paginated users response
     * @throws DomiNodeException on API errors
     */
    public AdminUsersResponse listUsers() throws DomiNodeException {
        return listUsers(-1, -1);
    }

    /**
     * List all users with pagination.
     *
     * @param page  page number (1-based, pass -1 for default)
     * @param limit users per page (pass -1 for default)
     * @return paginated users response
     * @throws DomiNodeException on API errors
     */
    public AdminUsersResponse listUsers(int page, int limit) throws DomiNodeException {
        StringBuilder path = new StringBuilder("/api/admin/users");
        String sep = "?";
        if (page >= 0) {
            path.append(sep).append("page=").append(page);
            sep = "&";
        }
        if (limit >= 0) {
            path.append(sep).append("limit=").append(limit);
        }
        return http.get(path.toString(), AdminUsersResponse.class);
    }

    /**
     * Get detailed info for a specific user.
     *
     * @param id user ID
     * @return user detail
     * @throws DomiNodeException on API errors
     */
    public AdminUserDetail getUser(String id) throws DomiNodeException {
        String encodedId = URLEncoder.encode(id, StandardCharsets.UTF_8);
        return http.get("/api/admin/users/" + encodedId, AdminUserDetail.class);
    }

    /**
     * Suspend a user account.
     *
     * @param id user ID
     * @throws DomiNodeException on API errors
     */
    public void suspendUser(String id) throws DomiNodeException {
        String encodedId = URLEncoder.encode(id, StandardCharsets.UTF_8);
        http.put("/api/admin/users/" + encodedId + "/suspend", null, Object.class);
    }

    /**
     * Reactivate a suspended user account.
     *
     * @param id user ID
     * @throws DomiNodeException on API errors
     */
    public void activateUser(String id) throws DomiNodeException {
        String encodedId = URLEncoder.encode(id, StandardCharsets.UTF_8);
        http.put("/api/admin/users/" + encodedId + "/activate", null, Object.class);
    }

    /**
     * Soft-delete a user account.
     *
     * @param id user ID
     * @throws DomiNodeException on API errors
     */
    public void deleteUser(String id) throws DomiNodeException {
        String encodedId = URLEncoder.encode(id, StandardCharsets.UTF_8);
        http.delete("/api/admin/users/" + encodedId);
    }

    /**
     * Get revenue statistics with default date range.
     *
     * @return revenue stats
     * @throws DomiNodeException on API errors
     */
    public RevenueStats getRevenue() throws DomiNodeException {
        return getRevenue(null, null);
    }

    /**
     * Get revenue statistics for a date range.
     *
     * @param since start date (ISO 8601), or {@code null}
     * @param until end date (ISO 8601), or {@code null}
     * @return revenue stats
     * @throws DomiNodeException on API errors
     */
    public RevenueStats getRevenue(String since, String until) throws DomiNodeException {
        String path = buildDatePath("/api/admin/revenue", since, until);
        return http.get(path, RevenueStats.class);
    }

    /**
     * Get daily revenue breakdown with default date range.
     *
     * @return daily revenue response
     * @throws DomiNodeException on API errors
     */
    public DailyRevenueResponse getDailyRevenue() throws DomiNodeException {
        return getDailyRevenue(null, null);
    }

    /**
     * Get daily revenue breakdown for a date range.
     *
     * @param since start date (ISO 8601), or {@code null}
     * @param until end date (ISO 8601), or {@code null}
     * @return daily revenue response
     * @throws DomiNodeException on API errors
     */
    public DailyRevenueResponse getDailyRevenue(String since, String until) throws DomiNodeException {
        String path = buildDatePath("/api/admin/revenue/daily", since, until);
        return http.get(path, DailyRevenueResponse.class);
    }

    /**
     * Get system-wide statistics.
     *
     * @return system stats
     * @throws DomiNodeException on API errors
     */
    public SystemStats getStats() throws DomiNodeException {
        return http.get("/api/admin/stats", SystemStats.class);
    }

    /**
     * Build a path with optional since/until query parameters.
     */
    private static String buildDatePath(String base, String since, String until) {
        StringBuilder sb = new StringBuilder(base);
        String sep = "?";
        if (since != null) {
            sb.append(sep).append("since=").append(URLEncoder.encode(since, StandardCharsets.UTF_8));
            sep = "&";
        }
        if (until != null) {
            sb.append(sep).append("until=").append(URLEncoder.encode(until, StandardCharsets.UTF_8));
        }
        return sb.toString();
    }
}
