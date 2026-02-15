#pragma once

#include "dominusnode/types.hpp"
#include <string>

namespace dominusnode {

class HttpClient;

/// Plans resource - list plans, get/change user plan.
class PlansResource {
public:
    explicit PlansResource(HttpClient& http);

    /// List all available plans (does not require authentication).
    ListPlansResult list();

    /// Get the current user's plan and monthly usage.
    UserPlanResult get_user_plan();

    /// Change the current user's plan.
    ChangePlanResult change_plan(const std::string& plan_id);

private:
    HttpClient& http_;
};

} // namespace dominusnode
