package dominusnode

import (
	"context"
	"fmt"
	"net/url"
)

// Team represents a team with shared wallet and members.
type Team struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	OwnerID      string `json:"ownerId"`
	MaxMembers   int    `json:"maxMembers"`
	BalanceCents int    `json:"balanceCents"`
	CreatedAt    string `json:"createdAt"`
}

// TeamMember represents a member of a team.
type TeamMember struct {
	UserID   string `json:"userId"`
	Email    string `json:"email"`
	Role     string `json:"role"`
	JoinedAt string `json:"joinedAt"`
}

// TeamInvite represents a pending team invite.
type TeamInvite struct {
	ID        string `json:"id"`
	TeamID    string `json:"teamId"`
	Email     string `json:"email"`
	Role      string `json:"role"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
	CreatedAt string `json:"createdAt"`
}

// TeamTransaction represents a wallet transaction on a team.
type TeamTransaction struct {
	ID          string `json:"id"`
	TeamID      string `json:"teamId"`
	Type        string `json:"type"`
	AmountCents int    `json:"amountCents"`
	Description string `json:"description"`
	CreatedAt   string `json:"createdAt"`
}

// TeamKey represents an API key belonging to a team.
type TeamKey struct {
	ID        string `json:"id"`
	KeyPrefix string `json:"keyPrefix"`
	Label     string `json:"label"`
	CreatedAt string `json:"createdAt"`
}

// TeamKeyCreateResponse is the response from creating a team API key.
type TeamKeyCreateResponse struct {
	ID        string `json:"id"`
	Key       string `json:"key"`
	KeyPrefix string `json:"keyPrefix"`
	Label     string `json:"label"`
}

// TeamDeleteResponse is the response from deleting a team.
type TeamDeleteResponse struct {
	RefundedCents int `json:"refundedCents"`
}

// TeamFundResponse is the response from funding a team wallet.
type TeamFundResponse struct {
	Transaction TeamTransaction `json:"transaction"`
}

// TeamTransactionsResponse is the response from listing team wallet transactions.
type TeamTransactionsResponse struct {
	Transactions []TeamTransaction `json:"transactions"`
}

// TeamMembersResponse is the response from listing team members.
type TeamMembersResponse struct {
	Members []TeamMember `json:"members"`
}

// TeamInvitesResponse is the response from listing team invites.
type TeamInvitesResponse struct {
	Invites []TeamInvite `json:"invites"`
}

// TeamKeysResponse is the response from listing team API keys.
type TeamKeysResponse struct {
	Keys []TeamKey `json:"keys"`
}

// TeamsResource provides team operations.
type TeamsResource struct {
	http *httpClient
}

func newTeamsResource(http *httpClient) *TeamsResource {
	return &TeamsResource{http: http}
}

// Create creates a new team with the given name and optional max members.
func (r *TeamsResource) Create(ctx context.Context, name string, maxMembers int) (*Team, error) {
	body := map[string]interface{}{
		"name": name,
	}
	if maxMembers > 0 {
		body["maxMembers"] = maxMembers
	}
	var result Team
	if err := r.http.post(ctx, "/api/teams", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// List returns all teams the authenticated user belongs to.
func (r *TeamsResource) List(ctx context.Context) ([]Team, error) {
	var result []Team
	if err := r.http.get(ctx, "/api/teams", &result); err != nil {
		return nil, err
	}
	return result, nil
}

// Get returns a single team by ID.
func (r *TeamsResource) Get(ctx context.Context, teamID string) (*Team, error) {
	var result Team
	if err := r.http.get(ctx, fmt.Sprintf("/api/teams/%s", url.PathEscape(teamID)), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Update updates a team's settings.
func (r *TeamsResource) Update(ctx context.Context, teamID string, updates map[string]interface{}) (*Team, error) {
	var result Team
	if err := r.http.patch(ctx, fmt.Sprintf("/api/teams/%s", url.PathEscape(teamID)), updates, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Delete deletes a team and refunds remaining wallet balance.
func (r *TeamsResource) Delete(ctx context.Context, teamID string) (*TeamDeleteResponse, error) {
	var result TeamDeleteResponse
	if err := r.http.del(ctx, fmt.Sprintf("/api/teams/%s", url.PathEscape(teamID)), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// FundWallet transfers funds from the user's main wallet to the team wallet.
func (r *TeamsResource) FundWallet(ctx context.Context, teamID string, amountCents int) (*TeamFundResponse, error) {
	body := map[string]interface{}{
		"amountCents": amountCents,
	}
	var result TeamFundResponse
	if err := r.http.post(ctx, fmt.Sprintf("/api/teams/%s/wallet/fund", url.PathEscape(teamID)), body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetTransactions returns wallet transaction history for a team.
func (r *TeamsResource) GetTransactions(ctx context.Context, teamID string, limit, offset int) (*TeamTransactionsResponse, error) {
	var result TeamTransactionsResponse
	path := fmt.Sprintf("/api/teams/%s/wallet/transactions?limit=%d&offset=%d", url.PathEscape(teamID), limit, offset)
	if err := r.http.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// ListMembers returns all members of a team.
func (r *TeamsResource) ListMembers(ctx context.Context, teamID string) (*TeamMembersResponse, error) {
	var result TeamMembersResponse
	if err := r.http.get(ctx, fmt.Sprintf("/api/teams/%s/members", url.PathEscape(teamID)), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// AddMember adds a member to a team.
func (r *TeamsResource) AddMember(ctx context.Context, teamID, email, role string) (*TeamMember, error) {
	body := map[string]interface{}{
		"email": email,
	}
	if role != "" {
		body["role"] = role
	}
	var result TeamMember
	if err := r.http.post(ctx, fmt.Sprintf("/api/teams/%s/members", url.PathEscape(teamID)), body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// UpdateMemberRole updates a member's role within a team.
func (r *TeamsResource) UpdateMemberRole(ctx context.Context, teamID, userID, role string) (*TeamMember, error) {
	body := map[string]interface{}{
		"role": role,
	}
	var result TeamMember
	path := fmt.Sprintf("/api/teams/%s/members/%s", url.PathEscape(teamID), url.PathEscape(userID))
	if err := r.http.patch(ctx, path, body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// RemoveMember removes a member from a team.
func (r *TeamsResource) RemoveMember(ctx context.Context, teamID, userID string) error {
	path := fmt.Sprintf("/api/teams/%s/members/%s", url.PathEscape(teamID), url.PathEscape(userID))
	return r.http.del(ctx, path, nil)
}

// CreateInvite creates an invite for a team.
func (r *TeamsResource) CreateInvite(ctx context.Context, teamID, email, role string) (*TeamInvite, error) {
	body := map[string]interface{}{
		"email": email,
	}
	if role != "" {
		body["role"] = role
	}
	var result TeamInvite
	if err := r.http.post(ctx, fmt.Sprintf("/api/teams/%s/invites", url.PathEscape(teamID)), body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// ListInvites returns pending invites for a team.
func (r *TeamsResource) ListInvites(ctx context.Context, teamID string) (*TeamInvitesResponse, error) {
	var result TeamInvitesResponse
	if err := r.http.get(ctx, fmt.Sprintf("/api/teams/%s/invites", url.PathEscape(teamID)), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// CancelInvite cancels a pending team invite.
func (r *TeamsResource) CancelInvite(ctx context.Context, teamID, inviteID string) error {
	path := fmt.Sprintf("/api/teams/%s/invites/%s", url.PathEscape(teamID), url.PathEscape(inviteID))
	return r.http.del(ctx, path, nil)
}

// AcceptInvite accepts a team invite using the invite token.
func (r *TeamsResource) AcceptInvite(ctx context.Context, token string) (*TeamMember, error) {
	var result TeamMember
	if err := r.http.post(ctx, fmt.Sprintf("/api/teams/invites/%s/accept", url.PathEscape(token)), map[string]interface{}{}, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// CreateKey creates a new API key for the team.
func (r *TeamsResource) CreateKey(ctx context.Context, teamID, label string) (*TeamKeyCreateResponse, error) {
	body := map[string]interface{}{
		"label": label,
	}
	var result TeamKeyCreateResponse
	if err := r.http.post(ctx, fmt.Sprintf("/api/teams/%s/keys", url.PathEscape(teamID)), body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// ListKeys returns all API keys for a team.
func (r *TeamsResource) ListKeys(ctx context.Context, teamID string) (*TeamKeysResponse, error) {
	var result TeamKeysResponse
	if err := r.http.get(ctx, fmt.Sprintf("/api/teams/%s/keys", url.PathEscape(teamID)), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// RevokeKey revokes a team API key by its ID.
func (r *TeamsResource) RevokeKey(ctx context.Context, teamID, keyID string) error {
	return r.http.del(ctx, fmt.Sprintf("/api/teams/%s/keys/%s", url.PathEscape(teamID), url.PathEscape(keyID)), nil)
}
