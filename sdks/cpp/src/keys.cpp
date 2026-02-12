#include "dominode/keys.hpp"
#include "dominode/http_client.hpp"

#include <sstream>

namespace dominode {

KeysResource::KeysResource(HttpClient& http) : http_(http) {}

CreateKeyResult KeysResource::create(const std::string& label) {
    nlohmann::json body = {{"label", label}};
    auto resp = http_.post("/api/keys", body);
    return resp.get<CreateKeyResult>();
}

ListKeysResult KeysResource::list() {
    auto resp = http_.get("/api/keys");
    return resp.get<ListKeysResult>();
}

void KeysResource::revoke(const std::string& id) {
    // URL-encode the id (simple encoding for UUID-like strings)
    std::ostringstream path;
    path << "/api/keys/";
    for (char c : id) {
        if (std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.') {
            path << c;
        } else {
            path << '%' << std::hex << std::uppercase
                 << ((static_cast<unsigned char>(c) >> 4) & 0x0F)
                 << (static_cast<unsigned char>(c) & 0x0F);
        }
    }
    http_.del(path.str());
}

} // namespace dominode
