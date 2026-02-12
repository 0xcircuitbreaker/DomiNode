#include "dominode/plans.hpp"
#include "dominode/http_client.hpp"

namespace dominode {

PlansResource::PlansResource(HttpClient& http) : http_(http) {}

ListPlansResult PlansResource::list() {
    auto resp = http_.get("/api/plans", false);
    return resp.get<ListPlansResult>();
}

UserPlanResult PlansResource::get_user_plan() {
    auto resp = http_.get("/api/plans/user/plan");
    return resp.get<UserPlanResult>();
}

ChangePlanResult PlansResource::change_plan(const std::string& plan_id) {
    nlohmann::json body = {{"planId", plan_id}};
    auto resp = http_.put("/api/plans/user/plan", body);
    return resp.get<ChangePlanResult>();
}

} // namespace dominode
