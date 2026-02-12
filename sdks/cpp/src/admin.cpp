#include "dominode/admin.hpp"
#include "dominode/http_client.hpp"

#include <cctype>
#include <iomanip>
#include <sstream>

namespace dominode {

// URL-encode a path segment (same approach as keys.cpp)
static std::string url_encode(const std::string& value) {
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

AdminResource::AdminResource(HttpClient& http) : http_(http) {}

AdminUsersResult AdminResource::list_users(int page, int limit) {
    std::ostringstream path;
    path << "/api/admin/users?page=" << page << "&limit=" << limit;
    auto resp = http_.get(path.str());
    return resp.get<AdminUsersResult>();
}

AdminUser AdminResource::get_user(const std::string& user_id) {
    auto resp = http_.get("/api/admin/users/" + url_encode(user_id));
    return resp.at("user").get<AdminUser>();
}

void AdminResource::suspend_user(const std::string& user_id) {
    http_.put("/api/admin/users/" + url_encode(user_id) + "/suspend");
}

void AdminResource::activate_user(const std::string& user_id) {
    http_.put("/api/admin/users/" + url_encode(user_id) + "/activate");
}

void AdminResource::delete_user(const std::string& user_id) {
    http_.del("/api/admin/users/" + url_encode(user_id));
}

RevenueStats AdminResource::get_revenue(const std::string& since, const std::string& until) {
    std::ostringstream path;
    path << "/api/admin/revenue";

    bool has_param = false;
    auto append = [&](const std::string& key, const std::string& value) {
        if (value.empty()) return;
        path << (has_param ? '&' : '?') << key << '=' << url_encode(value);
        has_param = true;
    };

    append("since", since);
    append("until", until);

    auto resp = http_.get(path.str());
    return resp.get<RevenueStats>();
}

DailyRevenueResult AdminResource::get_daily_revenue(const std::string& since, const std::string& until) {
    std::ostringstream path;
    path << "/api/admin/revenue/daily";

    bool has_param = false;
    auto append = [&](const std::string& key, const std::string& value) {
        if (value.empty()) return;
        path << (has_param ? '&' : '?') << key << '=' << url_encode(value);
        has_param = true;
    };

    append("since", since);
    append("until", until);

    auto resp = http_.get(path.str());
    return resp.get<DailyRevenueResult>();
}

SystemStats AdminResource::get_stats() {
    auto resp = http_.get("/api/admin/stats");
    return resp.get<SystemStats>();
}

} // namespace dominode
