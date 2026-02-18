#pragma once

#include "dominusnode/types.hpp"

namespace dominusnode {

class HttpClient;

/// Slot availability and waitlist operations.
/// All methods are public (no authentication required).
class SlotsResource {
public:
    explicit SlotsResource(HttpClient& http);

    /// Check available registration slots.
    SlotsInfo get_slots();

    /// Join the waitlist when registration slots are full.
    WaitlistJoinResult join_waitlist(const std::string& email);

    /// Get the number of people on the waitlist.
    WaitlistCount get_waitlist_count();

private:
    HttpClient& http_;
};

} // namespace dominusnode
