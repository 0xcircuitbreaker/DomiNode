package dominusnode

import (
	"context"
	"fmt"
	"net/url"
)

// AgenticWallet represents a server-side custodial sub-wallet.
type AgenticWallet struct {
	ID                 string   `json:"id"`
	Label              string   `json:"label"`
	BalanceCents       int      `json:"balanceCents"`
	SpendingLimitCents int      `json:"spendingLimitCents"`
	DailyLimitCents    *int     `json:"dailyLimitCents"`
	AllowedDomains     []string `json:"allowedDomains"`
	Status             string   `json:"status"`
	CreatedAt          string   `json:"createdAt"`
}

// AgenticWalletTransaction represents a transaction on an agentic wallet.
type AgenticWalletTransaction struct {
	ID          string  `json:"id"`
	WalletID    string  `json:"walletId"`
	Type        string  `json:"type"`
	AmountCents int     `json:"amountCents"`
	Description string  `json:"description"`
	SessionID   *string `json:"sessionId"`
	CreatedAt   string  `json:"createdAt"`
}

// AgenticWalletListResponse is the response from listing agentic wallets.
type AgenticWalletListResponse struct {
	Wallets []AgenticWallet `json:"wallets"`
}

// AgenticWalletFundResponse is the response from funding an agentic wallet.
type AgenticWalletFundResponse struct {
	Transaction AgenticWalletTransaction `json:"transaction"`
}

// AgenticWalletTransactionsResponse is the response from listing agentic wallet transactions.
type AgenticWalletTransactionsResponse struct {
	Transactions []AgenticWalletTransaction `json:"transactions"`
}

// AgenticWalletDeleteResponse is the response from deleting an agentic wallet.
type AgenticWalletDeleteResponse struct {
	Deleted       bool `json:"deleted"`
	RefundedCents int  `json:"refundedCents"`
}

// UpdateWalletPolicyParams contains the fields for updating an agentic wallet's policy.
type UpdateWalletPolicyParams struct {
	DailyLimitCents *int     `json:"dailyLimitCents"`
	AllowedDomains  []string `json:"allowedDomains"`
}

// AgenticWalletResource provides agentic wallet operations.
type AgenticWalletResource struct {
	http *httpClient
}

func newAgenticWalletResource(http *httpClient) *AgenticWalletResource {
	return &AgenticWalletResource{http: http}
}

// Create creates a new agentic wallet with the given label, spending limit, and optional policy fields.
func (r *AgenticWalletResource) Create(ctx context.Context, label string, spendingLimitCents int, dailyLimitCents *int, allowedDomains []string) (*AgenticWallet, error) {
	if err := validateAmountCents(spendingLimitCents); err != nil {
		return nil, err
	}
	body := map[string]interface{}{
		"label":              label,
		"spendingLimitCents": spendingLimitCents,
	}
	if dailyLimitCents != nil {
		if *dailyLimitCents < 1 || *dailyLimitCents > 1_000_000 {
			return nil, fmt.Errorf("dailyLimitCents must be between 1 and 1,000,000")
		}
		body["dailyLimitCents"] = *dailyLimitCents
	}
	if allowedDomains != nil {
		body["allowedDomains"] = allowedDomains
	}
	var result AgenticWallet
	if err := r.http.post(ctx, "/api/agent-wallet", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// List returns all agentic wallets for the authenticated user.
func (r *AgenticWalletResource) List(ctx context.Context) (*AgenticWalletListResponse, error) {
	var result AgenticWalletListResponse
	if err := r.http.get(ctx, "/api/agent-wallet", &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Get returns a single agentic wallet by ID.
// R33 H-3: URL-encode walletID to prevent path injection.
func (r *AgenticWalletResource) Get(ctx context.Context, walletID string) (*AgenticWallet, error) {
	var result AgenticWallet
	if err := r.http.get(ctx, fmt.Sprintf("/api/agent-wallet/%s", url.PathEscape(walletID)), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Fund transfers funds from the main wallet to the agentic wallet.
func (r *AgenticWalletResource) Fund(ctx context.Context, walletID string, amountCents int) (*AgenticWalletFundResponse, error) {
	if err := validateAmountCents(amountCents); err != nil {
		return nil, err
	}
	body := map[string]interface{}{
		"amountCents": amountCents,
	}
	var result AgenticWalletFundResponse
	if err := r.http.post(ctx, fmt.Sprintf("/api/agent-wallet/%s/fund", url.PathEscape(walletID)), body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Transactions returns the transaction history for an agentic wallet.
func (r *AgenticWalletResource) Transactions(ctx context.Context, walletID string, limit, offset int) (*AgenticWalletTransactionsResponse, error) {
	var result AgenticWalletTransactionsResponse
	path := fmt.Sprintf("/api/agent-wallet/%s/transactions?limit=%d&offset=%d", url.PathEscape(walletID), limit, offset)
	if err := r.http.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Freeze freezes an agentic wallet, preventing further spending.
func (r *AgenticWalletResource) Freeze(ctx context.Context, walletID string) (*AgenticWallet, error) {
	var result AgenticWallet
	if err := r.http.post(ctx, fmt.Sprintf("/api/agent-wallet/%s/freeze", url.PathEscape(walletID)), map[string]interface{}{}, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Unfreeze unfreezes an agentic wallet, allowing spending again.
func (r *AgenticWalletResource) Unfreeze(ctx context.Context, walletID string) (*AgenticWallet, error) {
	var result AgenticWallet
	if err := r.http.post(ctx, fmt.Sprintf("/api/agent-wallet/%s/unfreeze", url.PathEscape(walletID)), map[string]interface{}{}, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Delete deletes an agentic wallet and refunds remaining balance to the main wallet.
func (r *AgenticWalletResource) Delete(ctx context.Context, walletID string) (*AgenticWalletDeleteResponse, error) {
	var result AgenticWalletDeleteResponse
	if err := r.http.del(ctx, fmt.Sprintf("/api/agent-wallet/%s", url.PathEscape(walletID)), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// UpdateWalletPolicy updates the policy fields on an agentic wallet.
func (r *AgenticWalletResource) UpdateWalletPolicy(ctx context.Context, walletID string, policy UpdateWalletPolicyParams) (*AgenticWallet, error) {
	if policy.DailyLimitCents != nil {
		if *policy.DailyLimitCents < 1 || *policy.DailyLimitCents > 1_000_000 {
			return nil, fmt.Errorf("dailyLimitCents must be between 1 and 1,000,000")
		}
	}
	var result AgenticWallet
	if err := r.http.patch(ctx, fmt.Sprintf("/api/agent-wallet/%s/policy", url.PathEscape(walletID)), policy, &result); err != nil {
		return nil, err
	}
	return &result, nil
}
