#include "dominusnode/sessions.hpp"
#include "dominusnode/http_client.hpp"

namespace dominusnode {

SessionsResource::SessionsResource(HttpClient& http) : http_(http) {}

ActiveSessionsResult SessionsResource::get_active() {
    auto resp = http_.get("/api/sessions/active");
    return resp.get<ActiveSessionsResult>();
}

} // namespace dominusnode
