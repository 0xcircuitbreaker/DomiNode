#pragma once

#include "dominusnode/types.hpp"

namespace dominusnode {

class HttpClient;

/// Active proxy sessions resource.
class SessionsResource {
public:
    explicit SessionsResource(HttpClient& http);

    /// Get all active proxy sessions for the authenticated user.
    ActiveSessionsResult get_active();

private:
    HttpClient& http_;
};

} // namespace dominusnode
