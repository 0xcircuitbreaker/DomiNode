#include "dominusnode/slots.hpp"
#include "dominusnode/http_client.hpp"

namespace dominusnode {

SlotsResource::SlotsResource(HttpClient& http) : http_(http) {}

SlotsInfo SlotsResource::get_slots() {
    auto resp = http_.get("/api/slots", false);
    return resp.get<SlotsInfo>();
}

WaitlistJoinResult SlotsResource::join_waitlist(const std::string& email) {
    nlohmann::json body = {{"email", email}};
    auto resp = http_.post("/api/waitlist/join", body, false);
    return resp.get<WaitlistJoinResult>();
}

WaitlistCount SlotsResource::get_waitlist_count() {
    auto resp = http_.get("/api/waitlist/count", false);
    return resp.get<WaitlistCount>();
}

} // namespace dominusnode
