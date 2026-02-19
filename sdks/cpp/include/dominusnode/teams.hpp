#pragma once

#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace dominusnode {

class HttpClient;

// ─── Types ──────────────────────────────────────────────────────────────

struct Team {
    std::string id;
    std::string name;
    std::string owner_id;
    int max_members = 0;
    int balance_cents = 0;
    std::string created_at;
};

inline void from_json(const nlohmann::json& j, Team& t) {
    j.at("id").get_to(t.id);
    j.at("name").get_to(t.name);
    t.owner_id = j.value("ownerId", "");
    t.max_members = j.value("maxMembers", 0);
    t.balance_cents = j.value("balanceCents", 0);
    t.created_at = j.value("createdAt", "");
}

struct TeamMember {
    std::string user_id;
    std::string email;
    std::string role;
    std::string joined_at;
};

inline void from_json(const nlohmann::json& j, TeamMember& m) {
    m.user_id = j.value("userId", "");
    j.at("email").get_to(m.email);
    j.at("role").get_to(m.role);
    m.joined_at = j.value("joinedAt", "");
}

struct TeamInvite {
    std::string id;
    std::string team_id;
    std::string email;
    std::string role;
    std::string token;
    std::string expires_at;
    std::string created_at;
};

inline void from_json(const nlohmann::json& j, TeamInvite& i) {
    j.at("id").get_to(i.id);
    i.team_id = j.value("teamId", "");
    j.at("email").get_to(i.email);
    j.at("role").get_to(i.role);
    i.token = j.value("token", "");
    i.expires_at = j.value("expiresAt", "");
    i.created_at = j.value("createdAt", "");
}

struct TeamTransaction {
    std::string id;
    std::string team_id;
    std::string type;
    int amount_cents = 0;
    std::string description;
    std::string created_at;
};

inline void from_json(const nlohmann::json& j, TeamTransaction& t) {
    j.at("id").get_to(t.id);
    t.team_id = j.value("teamId", "");
    j.at("type").get_to(t.type);
    t.amount_cents = j.value("amountCents", 0);
    t.description = j.value("description", "");
    t.created_at = j.value("createdAt", "");
}

struct TeamKey {
    std::string id;
    std::string key_prefix;
    std::string label;
    std::string created_at;
};

inline void from_json(const nlohmann::json& j, TeamKey& k) {
    j.at("id").get_to(k.id);
    k.key_prefix = j.value("keyPrefix", "");
    j.at("label").get_to(k.label);
    k.created_at = j.value("createdAt", "");
}

struct TeamKeyCreateResponse {
    std::string id;
    std::string key;
    std::string key_prefix;
    std::string label;
};

inline void from_json(const nlohmann::json& j, TeamKeyCreateResponse& r) {
    j.at("id").get_to(r.id);
    j.at("key").get_to(r.key);
    r.key_prefix = j.value("keyPrefix", "");
    j.at("label").get_to(r.label);
}

struct TeamDeleteResponse {
    int refunded_cents = 0;
};

inline void from_json(const nlohmann::json& j, TeamDeleteResponse& r) {
    r.refunded_cents = j.value("refundedCents", 0);
}

struct TeamFundResponse {
    TeamTransaction transaction;
};

inline void from_json(const nlohmann::json& j, TeamFundResponse& r) {
    j.at("transaction").get_to(r.transaction);
}

struct TeamTransactionsResponse {
    std::vector<TeamTransaction> transactions;
};

inline void from_json(const nlohmann::json& j, TeamTransactionsResponse& r) {
    j.at("transactions").get_to(r.transactions);
}

struct TeamMembersResponse {
    std::vector<TeamMember> members;
};

inline void from_json(const nlohmann::json& j, TeamMembersResponse& r) {
    j.at("members").get_to(r.members);
}

struct TeamInvitesResponse {
    std::vector<TeamInvite> invites;
};

inline void from_json(const nlohmann::json& j, TeamInvitesResponse& r) {
    j.at("invites").get_to(r.invites);
}

struct TeamKeysResponse {
    std::vector<TeamKey> keys;
};

inline void from_json(const nlohmann::json& j, TeamKeysResponse& r) {
    j.at("keys").get_to(r.keys);
}

// ─── Resource ───────────────────────────────────────────────────────────

class TeamsResource {
public:
    explicit TeamsResource(HttpClient& http);

    Team create(const std::string& name, int max_members = 0);
    std::vector<Team> list();
    Team get(const std::string& team_id);
    Team update(const std::string& team_id, const nlohmann::json& updates);
    TeamDeleteResponse delete_team(const std::string& team_id);

    TeamFundResponse fund_wallet(const std::string& team_id, int amount_cents);
    TeamTransactionsResponse get_transactions(
        const std::string& team_id, int limit = 50, int offset = 0);

    TeamMembersResponse list_members(const std::string& team_id);
    TeamMember add_member(const std::string& team_id, const std::string& email,
                          const std::string& role = "");
    TeamMember update_member_role(const std::string& team_id, const std::string& user_id,
                                  const std::string& role);
    void remove_member(const std::string& team_id, const std::string& user_id);

    TeamInvite create_invite(const std::string& team_id, const std::string& email,
                             const std::string& role = "");
    TeamInvitesResponse list_invites(const std::string& team_id);
    void cancel_invite(const std::string& team_id, const std::string& invite_id);
    TeamMember accept_invite(const std::string& token);

    TeamKeyCreateResponse create_key(const std::string& team_id, const std::string& label);
    TeamKeysResponse list_keys(const std::string& team_id);
    void revoke_key(const std::string& team_id, const std::string& key_id);

private:
    HttpClient& http_;
};

} // namespace dominusnode
