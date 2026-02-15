#pragma once

#include "dominusnode/types.hpp"
#include <optional>
#include <string>

namespace dominusnode {

class HttpClient;

/// Date range options for usage queries.
struct DateRange {
    std::string from;
    std::string to;
};

/// Usage data resource.
class UsageResource {
public:
    explicit UsageResource(HttpClient& http);

    /// Get detailed usage records with summary.
    UsageResult get(const DateRange& range = {},
                    std::optional<int> limit = std::nullopt,
                    std::optional<int> offset = std::nullopt);

    /// Get daily usage aggregation for charts.
    DailyUsageResult get_daily(const DateRange& range = {});

    /// Get top target hosts by bandwidth.
    TopHostsResult get_top_hosts(const DateRange& range = {},
                                 std::optional<int> limit = std::nullopt);

    /// Export usage records as CSV string.
    std::string export_csv(const DateRange& range = {});

private:
    HttpClient& http_;
    std::string build_query_string(const DateRange& range,
                                   std::optional<int> limit = std::nullopt,
                                   std::optional<int> offset = std::nullopt) const;
};

} // namespace dominusnode
