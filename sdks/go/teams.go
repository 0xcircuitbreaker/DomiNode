package dominusnode

import (
	"context"
	"encoding/json"
)

// TeamsResource: /api/teams [jwt] (18 methods).
type TeamsResource struct{ h *httpClient }

// Team is a shared-wallet team.
type Team struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	OwnerID      string `json:"ownerId"`
	MaxMembers   int    `json:"maxMembers"`
	Status       string `json:"status"`
	BalanceCents int64  `json:"balanceCents"`
	CreatedAt    string `json:"createdAt"`
	Role         string `json:"role,omitempty"`
}

// TeamMember is a member row.
type TeamMember struct {
	ID       string `json:"id"`
	TeamID   string `json:"teamId"`
	UserID   string `json:"userId"`
	Email    string `json:"email"`
	Role     string `json:"role"`
	JoinedAt string `json:"joinedAt"`
}

// TeamInvite is a pending invite.
type TeamInvite struct {
	ID        string `json:"id"`
	TeamID    string `json:"teamId"`
	Email     string `json:"email"`
	Role      string `json:"role"`
	InvitedBy string `json:"invitedBy"` // user id of the member who sent the invite
	ExpiresAt string `json:"expiresAt"`
	CreatedAt string `json:"createdAt"`
}

// TeamKey is a listed team key (no secret).
// Prefix is the server's `prefix` field (older servers sent `keyPrefix`; both are accepted).
type TeamKey struct {
	ID        string  `json:"id"`
	Prefix    string  `json:"prefix"`
	Label     string  `json:"label"`
	UserID    string  `json:"userId"`
	TeamID    string  `json:"teamId"`
	CreatedAt string  `json:"createdAt"`
	RevokedAt *string `json:"revokedAt"`
}

// UnmarshalJSON accepts `prefix` or the legacy `keyPrefix`.
func (k *TeamKey) UnmarshalJSON(b []byte) error {
	type plain TeamKey
	var raw struct {
		plain
		KeyPrefix string `json:"keyPrefix"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	*k = TeamKey(raw.plain)
	if k.Prefix == "" {
		k.Prefix = raw.KeyPrefix
	}
	return nil
}

// TeamKeyCreated holds the new team key, returned once.
type TeamKeyCreated struct {
	ID        string `json:"id"`
	Prefix    string `json:"prefix"`
	Label     string `json:"label"`
	CreatedAt string `json:"createdAt,omitempty"`
	Key       Secret `json:"key"`
}

// TeamTransaction is a team-wallet ledger row.
type TeamTransaction struct {
	ID          string `json:"id"`
	TeamID      string `json:"teamId"`
	Type        string `json:"type"`
	AmountCents int64  `json:"amountCents"`
	Description string `json:"description"`
	CreatedAt   string `json:"createdAt"`
}

// TeamList is the response of GET /api/teams.
type TeamList struct {
	Teams []Team `json:"teams"`
}

// TeamDeleteResult is the response of DELETE /api/teams/{id}.
type TeamDeleteResult struct {
	RefundedCents int64 `json:"refundedCents"`
}

// TeamFundResult is the response of the fund call.
type TeamFundResult struct {
	Transaction TeamTransaction `json:"transaction"`
}

// TeamTransactions is the response of the transactions call.
type TeamTransactions struct {
	Transactions []TeamTransaction `json:"transactions"`
}

// TeamMembers is the response of ListMembers.
type TeamMembers struct {
	Members []TeamMember `json:"members"`
}

// TeamInvites is the response of ListInvites.
type TeamInvites struct {
	Invites []TeamInvite `json:"invites"`
}

// TeamKeys is the response of ListKeys.
type TeamKeys struct {
	Keys []TeamKey `json:"keys"`
}

// TeamUpdate is the PATCH body of Update (nil fields omitted).
type TeamUpdate struct {
	Name       *string `json:"name,omitempty"`
	MaxMembers *int    `json:"maxMembers,omitempty"`
}

func teamPath(id string) string { return "/api/teams/" + seg(id) }

// Create: POST /api/teams.
func (r *TeamsResource) Create(ctx context.Context, name string, maxMembers *int) (*Team, error) {
	body := map[string]any{"name": name}
	if maxMembers != nil {
		body["maxMembers"] = *maxMembers
	}
	var out Team
	return &out, r.h.post(ctx, "/api/teams", body, authJWT, &out)
}

// List: GET /api/teams.
func (r *TeamsResource) List(ctx context.Context) (*TeamList, error) {
	var out TeamList
	return &out, r.h.get(ctx, "/api/teams", authJWT, &out)
}

// Get: GET /api/teams/{id}.
func (r *TeamsResource) Get(ctx context.Context, teamID string) (*Team, error) {
	var out Team
	return &out, r.h.get(ctx, teamPath(teamID), authJWT, &out)
}

// Update: PATCH /api/teams/{id}.
func (r *TeamsResource) Update(ctx context.Context, teamID string, u TeamUpdate) (*Team, error) {
	var out Team
	return &out, r.h.patch(ctx, teamPath(teamID), u, authJWT, &out)
}

// Delete: DELETE /api/teams/{id}.
func (r *TeamsResource) Delete(ctx context.Context, teamID string) (*TeamDeleteResult, error) {
	var out TeamDeleteResult
	return &out, r.h.del(ctx, teamPath(teamID), authJWT, &out)
}

// FundWallet: POST /api/teams/{id}/wallet/fund.
func (r *TeamsResource) FundWallet(ctx context.Context, teamID string, amountCents int64) (*TeamFundResult, error) {
	if err := validateCents(amountCents, "amountCents", false); err != nil {
		return nil, err
	}
	var out TeamFundResult
	return &out, r.h.post(ctx, teamPath(teamID)+"/wallet/fund", map[string]any{"amountCents": amountCents}, authJWT, &out)
}

// GetTransactions: GET /api/teams/{id}/wallet/transactions?limit&offset.
func (r *TeamsResource) GetTransactions(ctx context.Context, teamID string, limit, offset *int) (*TeamTransactions, error) {
	var out TeamTransactions
	return &out, r.h.get(ctx, teamPath(teamID)+"/wallet/transactions"+query(qInt("limit", limit), qInt("offset", offset)), authJWT, &out)
}

// ListMembers: GET /api/teams/{id}/members.
func (r *TeamsResource) ListMembers(ctx context.Context, teamID string) (*TeamMembers, error) {
	var out TeamMembers
	return &out, r.h.get(ctx, teamPath(teamID)+"/members", authJWT, &out)
}

func emailRole(email, role string) map[string]any {
	b := map[string]any{"email": email}
	if role != "" {
		b["role"] = role
	}
	return b
}

// AddMember: POST /api/teams/{id}/members. role "" = server default.
func (r *TeamsResource) AddMember(ctx context.Context, teamID, email, role string) (*TeamMember, error) {
	var out TeamMember
	return &out, r.h.post(ctx, teamPath(teamID)+"/members", emailRole(email, role), authJWT, &out)
}

// UpdateMemberRole: PATCH /api/teams/{id}/members/{userId}.
func (r *TeamsResource) UpdateMemberRole(ctx context.Context, teamID, userID, role string) (*TeamMember, error) {
	var out TeamMember
	return &out, r.h.patch(ctx, teamPath(teamID)+"/members/"+seg(userID), map[string]any{"role": role}, authJWT, &out)
}

// RemoveMember: DELETE /api/teams/{id}/members/{userId}.
func (r *TeamsResource) RemoveMember(ctx context.Context, teamID, userID string) error {
	return r.h.del(ctx, teamPath(teamID)+"/members/"+seg(userID), authJWT, nil)
}

// CreateInvite: POST /api/teams/{id}/invites.
func (r *TeamsResource) CreateInvite(ctx context.Context, teamID, email, role string) (*TeamInvite, error) {
	var out TeamInvite
	return &out, r.h.post(ctx, teamPath(teamID)+"/invites", emailRole(email, role), authJWT, &out)
}

// ListInvites: GET /api/teams/{id}/invites.
func (r *TeamsResource) ListInvites(ctx context.Context, teamID string) (*TeamInvites, error) {
	var out TeamInvites
	return &out, r.h.get(ctx, teamPath(teamID)+"/invites", authJWT, &out)
}

// CancelInvite: DELETE /api/teams/{id}/invites/{inviteId}.
func (r *TeamsResource) CancelInvite(ctx context.Context, teamID, inviteID string) error {
	return r.h.del(ctx, teamPath(teamID)+"/invites/"+seg(inviteID), authJWT, nil)
}

// AcceptInvite: POST /api/teams/invites/{token}/accept.
func (r *TeamsResource) AcceptInvite(ctx context.Context, token string) (*TeamMember, error) {
	var out TeamMember
	return &out, r.h.post(ctx, "/api/teams/invites/"+seg(token)+"/accept", map[string]any{}, authJWT, &out)
}

// CreateKey: POST /api/teams/{id}/keys; label 1..100.
func (r *TeamsResource) CreateKey(ctx context.Context, teamID, label string) (*TeamKeyCreated, error) {
	if err := validateNonEmpty(label, "label", 100); err != nil {
		return nil, err
	}
	var raw struct {
		ID        string `json:"id"`
		Prefix    string `json:"prefix"`
		KeyPrefix string `json:"keyPrefix"`
		Label     string `json:"label"`
		CreatedAt string `json:"createdAt"`
		Key       string `json:"key"`
	}
	if err := r.h.post(ctx, teamPath(teamID)+"/keys", map[string]any{"label": label}, authJWT, &raw); err != nil {
		return nil, err
	}
	prefix := raw.Prefix
	if prefix == "" {
		prefix = raw.KeyPrefix
	}
	return &TeamKeyCreated{ID: raw.ID, Prefix: prefix, Label: raw.Label, CreatedAt: raw.CreatedAt, Key: NewSecret(raw.Key)}, nil
}

// ListKeys: GET /api/teams/{id}/keys.
func (r *TeamsResource) ListKeys(ctx context.Context, teamID string) (*TeamKeys, error) {
	var out TeamKeys
	return &out, r.h.get(ctx, teamPath(teamID)+"/keys", authJWT, &out)
}

// RevokeKey: DELETE /api/teams/{id}/keys/{keyId}.
func (r *TeamsResource) RevokeKey(ctx context.Context, teamID, keyID string) error {
	return r.h.del(ctx, teamPath(teamID)+"/keys/"+seg(keyID), authJWT, nil)
}
