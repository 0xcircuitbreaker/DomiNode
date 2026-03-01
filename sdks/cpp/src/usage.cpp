#include "dominusnode/usage.hpp"
#include "dominusnode/http_client.hpp"

#include <cctype>
#include <iomanip>
#include <sstream>

namespace dominusnode {

// URL-encode query parameter values
static std::string url_encode_param(const std::string& value) {
    std::ostringstream encoded;
    for (unsigned char c : value) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            encoded << static_cast<char>(c);
        } else {
            encoded << '%' << std::hex << std::uppercase
                    << ((c >> 4) & 0x0F)
                    << (c & 0x0F);
        }
    }
    return encoded.str();
}

UsageResource::UsageResource(HttpClient& http) : http_(http) {}

std::string UsageResource::build_query_string(const DateRange& range,
                                               std::optional<int> limit,
                                               std::optional<int> offset) const {
    std::ostringstream qs;
    bool has_param = false;

    auto append = [&](const std::string& key, const std::string& value) {
        if (value.empty()) return;
        qs << (has_param ? '&' : '?') << key << '=' << url_encode_param(value);
        has_param = true;
    };
    auto append_int = [&](const std::string& key, int value) {
        qs << (has_param ? '&' : '?') << key << '=' << value;
        has_param = true;
    };

    append("since", range.from);
    append("until", range.to);
    if (limit.has_value()) append_int("limit", *limit);
    if (offset.has_value()) append_int("offset", *offset);

    return qs.str();
}

UsageResult UsageResource::get(const DateRange& range,
                                std::optional<int> limit,
                                std::optional<int> offset) {
    std::string path = "/api/usage" + build_query_string(range, limit, offset);
    auto resp = http_.get(path);
    return resp.get<UsageResult>();
}

DailyUsageResult UsageResource::get_daily(const DateRange& range) {
    std::string path = "/api/usage/daily" + build_query_string(range);
    auto resp = http_.get(path);
    return resp.get<DailyUsageResult>();
}

TopHostsResult UsageResource::get_top_hosts(const DateRange& range,
                                             std::optional<int> limit) {
    std::string path = "/api/usage/top-hosts" + build_query_string(range, limit);
    auto resp = http_.get(path);
    return resp.get<TopHostsResult>();
}

std::string UsageResource::export_csv(const DateRange& range) {
    std::string path = "/api/usage/export" + build_query_string(range);
    auto resp = http_.get(path);
    // The response may be a raw string or JSON-wrapped string
    if (resp.is_string()) {
        return resp.get<std::string>();
    }
    return resp.dump();
}

} // namespace dominusnode
