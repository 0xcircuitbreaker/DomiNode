#pragma once

#include "dominusnode/types.hpp"
#include <optional>
#include <string>

namespace dominusnode {

class HttpClient;

/// Admin resource - user management, revenue analytics, system stats.
/// All methods require admin privileges.
class AdminResource {
public:
    explicit AdminResource(HttpClient& http);

    // ─── User Management ────────────────────────────────────────────

    /// List all users (paginated).
    AdminUsersResult list_users(int page = 1, int limit = 20);

    /// Get a specific user's details.
    AdminUser get_user(const std::string& user_id);

    /// Suspend a user account.
    void suspend_user(const std::string& user_id);

    /// Reactivate a suspended user account.
    void activate_user(const std::string& user_id);

    /// Soft-delete a user account.
    void delete_user(const std::string& user_id);

    // ─── Revenue Analytics ──────────────────────────────────────────

    /// Get revenue statistics for a date range.
    RevenueStats get_revenue(const std::string& since = "", const std::string& until = "");

    /// Get daily revenue breakdown.
    DailyRevenueResult get_daily_revenue(const std::string& since = "", const std::string& until = "");

    // ─── System Stats ───────────────────────────────────────────────

    /// Get system-wide statistics.
    SystemStats get_stats();

private:
    HttpClient& http_;
};

} // namespace dominusnode
