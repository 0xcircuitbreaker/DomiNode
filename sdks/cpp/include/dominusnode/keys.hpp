#pragma once

#include "dominusnode/types.hpp"
#include <string>

namespace dominusnode {

class HttpClient;

/// API key management resource.
class KeysResource {
public:
    explicit KeysResource(HttpClient& http);

    /// Create a new API key. The raw key is returned only once.
    CreateKeyResult create(const std::string& label = "Default");

    /// List all API keys for the authenticated user.
    ListKeysResult list();

    /// Revoke an API key by its ID.
    void revoke(const std::string& id);

private:
    HttpClient& http_;
};

} // namespace dominusnode
