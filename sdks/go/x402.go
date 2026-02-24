package dominusnode

import "context"

// X402Facilitator represents a facilitator for x402 payments.
type X402Facilitator struct {
	Address string `json:"address"`
	Chain   string `json:"chain"`
	Network string `json:"network"`
}

// X402Pricing contains pricing information for x402 payments.
type X402Pricing struct {
	PerRequestCents int    `json:"perRequestCents"`
	PerGbCents      int    `json:"perGbCents"`
	Currency        string `json:"currency"`
}

// X402Info is the response from the x402 info endpoint.
type X402Info struct {
	Supported      bool              `json:"supported"`
	Enabled        bool              `json:"enabled"`
	Protocol       string            `json:"protocol"`
	Version        string            `json:"version"`
	Facilitators   []X402Facilitator `json:"facilitators"`
	Pricing        X402Pricing       `json:"pricing"`
	Currencies     []string          `json:"currencies"`
	WalletType     string            `json:"walletType"`
	AgenticWallets bool              `json:"agenticWallets"`
}

// X402Resource provides x402 protocol information operations.
type X402Resource struct {
	http *httpClient
}

func newX402Resource(http *httpClient) *X402Resource {
	return &X402Resource{http: http}
}

// GetInfo returns x402 protocol information including facilitator details,
// pricing, supported chains, and currencies.
// This endpoint does not require authentication.
func (r *X402Resource) GetInfo(ctx context.Context) (*X402Info, error) {
	var result X402Info
	if err := r.http.getPublic(ctx, "/api/x402/info", &result); err != nil {
		return nil, err
	}
	return &result, nil
}
