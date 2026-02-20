#include "dominusnode/teams.hpp"
#include "dominusnode/http_client.hpp"

#include <sstream>
#include <iomanip>
#include <cctype>
#include <stdexcept>

namespace dominusnode {

static void validate_amount_cents(int amount_cents, const char* name = "amountCents") {
    if (amount_cents <= 0 || amount_cents > 2147483647) {
        throw std::invalid_argument(std::string(name) + " must be a positive integer <= 2,147,483,647");
    }
}

// Percent-encode a URI path segment to prevent path injection.
static std::string url_encode(const std::string& value) {
    std::ostringstream encoded;
    encoded.fill('0');
    encoded << std::hex;
    for (unsigned char c : value) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            encoded << c;
        } else {
            encoded << '%' << std::uppercase << std::setw(2) << static_cast<int>(c);
        }
    }
    return encoded.str();
}

TeamsResource::TeamsResource(HttpClient& http) : http_(http) {}

Team TeamsResource::create(const std::string& name, int max_members) {
    nlohmann::json body = {{"name", name}};
    if (max_members > 0) {
        body["maxMembers"] = max_members;
    }
    auto resp = http_.post("/api/teams", body);
    return resp.get<Team>();
}

std::vector<Team> TeamsResource::list() {
    auto resp = http_.get("/api/teams");
    return resp.get<std::vector<Team>>();
}

Team TeamsResource::get(const std::string& team_id) {
    auto resp = http_.get("/api/teams/" + url_encode(team_id));
    return resp.get<Team>();
}

Team TeamsResource::update(const std::string& team_id, const nlohmann::json& updates) {
    auto resp = http_.patch("/api/teams/" + url_encode(team_id), updates);
    return resp.get<Team>();
}

TeamDeleteResponse TeamsResource::delete_team(const std::string& team_id) {
    auto resp = http_.del("/api/teams/" + url_encode(team_id));
    return resp.get<TeamDeleteResponse>();
}

TeamFundResponse TeamsResource::fund_wallet(const std::string& team_id, int amount_cents) {
    validate_amount_cents(amount_cents);
    nlohmann::json body = {{"amountCents", amount_cents}};
    auto resp = http_.post("/api/teams/" + url_encode(team_id) + "/wallet/fund", body);
    return resp.get<TeamFundResponse>();
}

TeamTransactionsResponse TeamsResource::get_transactions(
    const std::string& team_id, int limit, int offset) {
    std::ostringstream path;
    path << "/api/teams/" << url_encode(team_id)
         << "/wallet/transactions?limit=" << limit << "&offset=" << offset;
    auto resp = http_.get(path.str());
    return resp.get<TeamTransactionsResponse>();
}

TeamMembersResponse TeamsResource::list_members(const std::string& team_id) {
    auto resp = http_.get("/api/teams/" + url_encode(team_id) + "/members");
    return resp.get<TeamMembersResponse>();
}

TeamMember TeamsResource::add_member(const std::string& team_id, const std::string& email,
                                     const std::string& role) {
    nlohmann::json body = {{"email", email}};
    if (!role.empty()) {
        body["role"] = role;
    }
    auto resp = http_.post("/api/teams/" + url_encode(team_id) + "/members", body);
    return resp.get<TeamMember>();
}

TeamMember TeamsResource::update_member_role(const std::string& team_id, const std::string& user_id,
                                             const std::string& role) {
    nlohmann::json body = {{"role", role}};
    auto resp = http_.patch("/api/teams/" + url_encode(team_id) + "/members/" + url_encode(user_id), body);
    return resp.get<TeamMember>();
}

void TeamsResource::remove_member(const std::string& team_id, const std::string& user_id) {
    http_.del("/api/teams/" + url_encode(team_id) + "/members/" + url_encode(user_id));
}

TeamInvite TeamsResource::create_invite(const std::string& team_id, const std::string& email,
                                        const std::string& role) {
    nlohmann::json body = {{"email", email}};
    if (!role.empty()) {
        body["role"] = role;
    }
    auto resp = http_.post("/api/teams/" + url_encode(team_id) + "/invites", body);
    return resp.get<TeamInvite>();
}

TeamInvitesResponse TeamsResource::list_invites(const std::string& team_id) {
    auto resp = http_.get("/api/teams/" + url_encode(team_id) + "/invites");
    return resp.get<TeamInvitesResponse>();
}

void TeamsResource::cancel_invite(const std::string& team_id, const std::string& invite_id) {
    http_.del("/api/teams/" + url_encode(team_id) + "/invites/" + url_encode(invite_id));
}

TeamMember TeamsResource::accept_invite(const std::string& token) {
    nlohmann::json body = nlohmann::json::object();
    auto resp = http_.post("/api/teams/invites/" + url_encode(token) + "/accept", body);
    return resp.get<TeamMember>();
}

TeamKeyCreateResponse TeamsResource::create_key(const std::string& team_id, const std::string& label) {
    nlohmann::json body = {{"label", label}};
    auto resp = http_.post("/api/teams/" + url_encode(team_id) + "/keys", body);
    return resp.get<TeamKeyCreateResponse>();
}

TeamKeysResponse TeamsResource::list_keys(const std::string& team_id) {
    auto resp = http_.get("/api/teams/" + url_encode(team_id) + "/keys");
    return resp.get<TeamKeysResponse>();
}

void TeamsResource::revoke_key(const std::string& team_id, const std::string& key_id) {
    http_.del("/api/teams/" + url_encode(team_id) + "/keys/" + url_encode(key_id));
}

} // namespace dominusnode
