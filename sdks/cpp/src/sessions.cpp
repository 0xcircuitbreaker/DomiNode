#include "dominode/sessions.hpp"
#include "dominode/http_client.hpp"

namespace dominode {

SessionsResource::SessionsResource(HttpClient& http) : http_(http) {}

ActiveSessionsResult SessionsResource::get_active() {
    auto resp = http_.get("/api/sessions/active");
    return resp.get<ActiveSessionsResult>();
}

} // namespace dominode
