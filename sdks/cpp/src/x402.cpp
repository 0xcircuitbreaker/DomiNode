#include "dominusnode/x402.hpp"
#include "dominusnode/http_client.hpp"

namespace dominusnode {

X402Resource::X402Resource(HttpClient& http) : http_(http) {}

X402Info X402Resource::get_info() {
    auto resp = http_.get("/api/x402/info", false);
    return resp.get<X402Info>();
}

} // namespace dominusnode
