package dominusnode

import (
	"context"
	"strings"
)

// ---------------------------------------------------------------- auth (4)

// AuthResource: /api/auth.
type AuthResource struct{ h *httpClient }

// VerifyKeyResult is the response of POST /api/auth/verify-key.
type VerifyKeyResult struct {
	Valid        bool   `json:"valid"`
	Token        string `json:"token"`
	RefreshToken string `json:"refreshToken"`
	UserID       string `json:"userId"`
	Email        string `json:"email"`
}

// String redacts the tokens.
func (v VerifyKeyResult) String() string {
	return "VerifyKeyResult(userId=" + v.UserID + ", tokens=" + redacted + ")"
}

// RefreshResult is the response of POST /api/auth/refresh.
type RefreshResult struct {
	Token        string `json:"token"`
	RefreshToken string `json:"refreshToken,omitempty"`
}

// String redacts the tokens.
func (RefreshResult) String() string { return "RefreshResult(" + redacted + ")" }

// User is the account profile. Extra holds no fields: unknown fields are dropped.
type User struct {
	ID            string `json:"id"`
	Email         string `json:"email"`
	WalletAddress string `json:"wallet_address,omitempty"`
	EmailVerified *bool  `json:"email_verified,omitempty"`
	IsAdmin       *bool  `json:"is_admin,omitempty"`
	Status        string `json:"status,omitempty"`
	CreatedAt     string `json:"created_at,omitempty"`
}

// MeResult is the response of GET /api/auth/me.
type MeResult struct {
	User User `json:"user"`
}

// VerifyKey: POST /api/auth/verify-key [none].
func (r *AuthResource) VerifyKey(ctx context.Context, apiKey string) (*VerifyKeyResult, error) {
	if err := ValidateAPIKey(apiKey); err != nil {
		return nil, err
	}
	var out VerifyKeyResult
	return &out, r.h.post(ctx, "/api/auth/verify-key", map[string]any{"apiKey": apiKey}, authNone, &out)
}

// Refresh: POST /api/auth/refresh [none].
func (r *AuthResource) Refresh(ctx context.Context, refreshToken string) (*RefreshResult, error) {
	if refreshToken == "" {
		return nil, invalidArg("refreshToken is required")
	}
	var out RefreshResult
	return &out, r.h.post(ctx, "/api/auth/refresh", map[string]any{"refreshToken": refreshToken}, authNone, &out)
}

// Logout: POST /api/auth/logout [jwt].
func (r *AuthResource) Logout(ctx context.Context) error {
	return r.h.post(ctx, "/api/auth/logout", map[string]any{}, authJWT, nil)
}

// Me: GET /api/auth/me [jwt].
func (r *AuthResource) Me(ctx context.Context) (*MeResult, error) {
	var out MeResult
	return &out, r.h.get(ctx, "/api/auth/me", authJWT, &out)
}

// ---------------------------------------------------------------- walletAuth (4)

// WalletAuthResource: EIP-191 wallet sign-in.
type WalletAuthResource struct {
	h      *httpClient
	tokens *tokenManager
}

// WalletChallenge is the response of POST /api/auth/wallet/challenge.
type WalletChallenge struct {
	Message   string `json:"message"`
	Nonce     string `json:"nonce"`
	Challenge string `json:"challenge"`
	ExpiresAt string `json:"expiresAt"`
}

// WalletVerifyResult: tokens, or MfaRequired with a challenge token (nothing stored).
type WalletVerifyResult struct {
	Token             string `json:"token,omitempty"`
	RefreshToken      string `json:"refreshToken,omitempty"`
	User              *User  `json:"user,omitempty"`
	MfaRequired       bool   `json:"mfaRequired,omitempty"`
	MfaChallengeToken string `json:"mfaChallengeToken,omitempty"`
}

// String redacts the tokens.
func (WalletVerifyResult) String() string { return "WalletVerifyResult(" + redacted + ")" }

// WalletLinkResult is the response of POST /api/auth/wallet/link.
type WalletLinkResult struct {
	Success       bool   `json:"success"`
	WalletAddress string `json:"walletAddress"`
}

// Challenge: POST /api/auth/wallet/challenge [none].
func (r *WalletAuthResource) Challenge(ctx context.Context, address string) (*WalletChallenge, error) {
	if err := validateAddress(address, "address"); err != nil {
		return nil, err
	}
	var out WalletChallenge
	return &out, r.h.post(ctx, "/api/auth/wallet/challenge", map[string]any{"address": address}, authNone, &out)
}

// Verify: POST /api/auth/wallet/verify [none]. Stores the JWT pair unless MFA is required.
func (r *WalletAuthResource) Verify(ctx context.Context, address, signature string) (*WalletVerifyResult, error) {
	if err := validateAddress(address, "address"); err != nil {
		return nil, err
	}
	if err := validateSignature(signature, "signature"); err != nil {
		return nil, err
	}
	var out WalletVerifyResult
	if err := r.h.post(ctx, "/api/auth/wallet/verify", map[string]any{"address": address, "signature": signature}, authNone, &out); err != nil {
		return nil, err
	}
	if out.MfaRequired {
		return &WalletVerifyResult{MfaRequired: true, MfaChallengeToken: out.MfaChallengeToken}, nil
	}
	if out.Token != "" && out.RefreshToken != "" {
		r.tokens.setTokens(out.Token, out.RefreshToken)
	}
	return &out, nil
}

// SignIn: Challenge -> signer -> Verify. Refuses if the challenge does not name the signer's address.
func (r *WalletAuthResource) SignIn(ctx context.Context, signer Signer) (*WalletVerifyResult, error) {
	if err := assertSigner(signer, "signer"); err != nil {
		return nil, err
	}
	ch, err := r.Challenge(ctx, signer.Address())
	if err != nil {
		return nil, err
	}
	if !strings.Contains(strings.ToLower(ch.Message), strings.ToLower(signer.Address())) {
		return nil, protocolErr("wallet challenge does not name the signer's address; refusing to sign")
	}
	sig, err := sign(ctx, signer, ch.Message, "signer")
	if err != nil {
		return nil, err
	}
	return r.Verify(ctx, signer.Address(), sig)
}

// Link: POST /api/auth/wallet/link [jwt].
func (r *WalletAuthResource) Link(ctx context.Context, address, signature string) (*WalletLinkResult, error) {
	if err := validateAddress(address, "address"); err != nil {
		return nil, err
	}
	if err := validateSignature(signature, "signature"); err != nil {
		return nil, err
	}
	var out WalletLinkResult
	return &out, r.h.post(ctx, "/api/auth/wallet/link", map[string]any{"address": address, "signature": signature}, authJWT, &out)
}

// ---------------------------------------------------------------- keys (3)

// KeysResource: /api/keys.
type KeysResource struct{ h *httpClient }

// APIKeyInfo is a listed key (no secret).
type APIKeyInfo struct {
	ID        string  `json:"id"`
	Prefix    string  `json:"prefix"`
	Label     string  `json:"label"`
	CreatedAt string  `json:"created_at"`
	RevokedAt *string `json:"revoked_at"`
}

// CreatedAPIKey holds the new key, returned once.
type CreatedAPIKey struct {
	ID        string `json:"id"`
	Prefix    string `json:"prefix"`
	Label     string `json:"label"`
	CreatedAt string `json:"created_at"`
	Key       Secret `json:"key"`
}

// APIKeyList is the response of GET /api/keys.
type APIKeyList struct {
	Keys []APIKeyInfo `json:"keys"`
}

// Create: POST /api/keys [jwt]. label "" means "Default".
func (r *KeysResource) Create(ctx context.Context, label string) (*CreatedAPIKey, error) {
	if label == "" {
		label = "Default"
	}
	if err := validateNonEmpty(label, "label", 100); err != nil {
		return nil, err
	}
	var raw struct {
		ID        string `json:"id"`
		Prefix    string `json:"prefix"`
		Label     string `json:"label"`
		CreatedAt string `json:"created_at"`
		Key       string `json:"key"`
	}
	if err := r.h.post(ctx, "/api/keys", map[string]any{"label": label}, authJWT, &raw); err != nil {
		return nil, err
	}
	return &CreatedAPIKey{raw.ID, raw.Prefix, raw.Label, raw.CreatedAt, NewSecret(raw.Key)}, nil
}

// List: GET /api/keys [jwt].
func (r *KeysResource) List(ctx context.Context) (*APIKeyList, error) {
	var out APIKeyList
	return &out, r.h.get(ctx, "/api/keys", authJWT, &out)
}

// Revoke: DELETE /api/keys/{id} [jwt].
func (r *KeysResource) Revoke(ctx context.Context, id string) error {
	if err := validateNonEmpty(id, "id", 256); err != nil {
		return err
	}
	return r.h.del(ctx, "/api/keys/"+seg(id), authJWT, nil)
}

// ---------------------------------------------------------------- wallet (5)

// WalletResource: requester prepaid wallet (cents).
type WalletResource struct{ h *httpClient }

// WalletBalance is the response of GET /api/wallet.
type WalletBalance struct {
	BalanceCents int64   `json:"balanceCents"`
	BalanceUsd   float64 `json:"balanceUsd"`
	Currency     string  `json:"currency"`
	LastToppedUp *string `json:"lastToppedUp"`
}

// WalletTransaction is one wallet ledger row.
type WalletTransaction struct {
	ID              string  `json:"id"`
	Type            string  `json:"type"`
	AmountCents     int64   `json:"amountCents"`
	AmountUsd       float64 `json:"amountUsd"`
	Description     string  `json:"description"`
	PaymentProvider *string `json:"paymentProvider"`
	CreatedAt       string  `json:"createdAt"`
}

// WalletTransactions is the response of GET /api/wallet/transactions.
type WalletTransactions struct {
	Transactions []WalletTransaction `json:"transactions"`
}

// Forecast is the response of GET /api/wallet/forecast.
type Forecast struct {
	DailyAvgCents float64  `json:"dailyAvgCents"`
	DaysRemaining *float64 `json:"daysRemaining"`
	Trend         string   `json:"trend"`
	TrendPct      float64  `json:"trendPct"`
}

// CryptoInvoice is the response of POST /api/wallet/topup/crypto.
type CryptoInvoice struct {
	InvoiceID   string  `json:"invoiceId"`
	InvoiceURL  string  `json:"invoiceUrl"`
	PayCurrency string  `json:"payCurrency"`
	PriceAmount float64 `json:"priceAmount"`
}

// CryptoInvoiceStatus is the response of GET /api/wallet/crypto/status/{id}.
type CryptoInvoiceStatus struct {
	InvoiceID   string `json:"invoiceId"`
	Status      string `json:"status"`
	AmountCents int64  `json:"amountCents"`
	Provider    string `json:"provider"`
	CreatedAt   string `json:"createdAt"`
}

// CryptoCurrencies accepted by TopUpCrypto.
var CryptoCurrencies = []string{"btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb", "link"}

func oneOf(v string, set []string) bool {
	for _, s := range set {
		if v == s {
			return true
		}
	}
	return false
}

// GetBalance: GET /api/wallet [jwt].
func (r *WalletResource) GetBalance(ctx context.Context) (*WalletBalance, error) {
	var out WalletBalance
	return &out, r.h.get(ctx, "/api/wallet", authJWT, &out)
}

// GetTransactions: GET /api/wallet/transactions?limit&offset [jwt].
func (r *WalletResource) GetTransactions(ctx context.Context, limit, offset *int) (*WalletTransactions, error) {
	var out WalletTransactions
	return &out, r.h.get(ctx, "/api/wallet/transactions"+query(qInt("limit", limit), qInt("offset", offset)), authJWT, &out)
}

// GetForecast: GET /api/wallet/forecast [jwt].
func (r *WalletResource) GetForecast(ctx context.Context) (*Forecast, error) {
	var out Forecast
	return &out, r.h.get(ctx, "/api/wallet/forecast", authJWT, &out)
}

// TopUpCrypto: POST /api/wallet/topup/crypto [jwt]; 1000..100000 cents.
func (r *WalletResource) TopUpCrypto(ctx context.Context, amountCents int64, currency string) (*CryptoInvoice, error) {
	if err := validateCents(amountCents, "amountCents", false); err != nil {
		return nil, err
	}
	if amountCents < 1000 || amountCents > 100_000 {
		return nil, invalidArg("crypto top-up must be between 1000 and 100000 cents ($10-$1,000)")
	}
	c := strings.ToLower(currency)
	if !oneOf(c, CryptoCurrencies) {
		return nil, invalidArg("currency must be one of %s", strings.Join(CryptoCurrencies, ", "))
	}
	var out CryptoInvoice
	body := map[string]any{"amountUsd": float64(amountCents) / 100, "currency": c}
	return &out, r.h.post(ctx, "/api/wallet/topup/crypto", body, authJWT, &out)
}

// GetCryptoStatus: GET /api/wallet/crypto/status/{invoiceId} [jwt].
func (r *WalletResource) GetCryptoStatus(ctx context.Context, invoiceID string) (*CryptoInvoiceStatus, error) {
	if err := validateUUID(invoiceID, "invoiceId"); err != nil {
		return nil, err
	}
	var out CryptoInvoiceStatus
	return &out, r.h.get(ctx, "/api/wallet/crypto/status/"+seg(invoiceID), authJWT, &out)
}

// ---------------------------------------------------------------- agenticWallets (9)

// AgenticWalletResource: /api/agent-wallet [jwt].
type AgenticWalletResource struct{ h *httpClient }

// AgenticWallet is a spending-limited sub-wallet.
type AgenticWallet struct {
	ID                 string   `json:"id"`
	Label              string   `json:"label"`
	BalanceCents       int64    `json:"balanceCents"`
	SpendingLimitCents int64    `json:"spendingLimitCents"`
	DailyLimitCents    *int64   `json:"dailyLimitCents"`
	AllowedDomains     []string `json:"allowedDomains"`
	Status             string   `json:"status"`
	CreatedAt          string   `json:"createdAt"`
}

// AgenticWalletTransaction is one sub-wallet ledger row.
type AgenticWalletTransaction struct {
	ID          string  `json:"id"`
	WalletID    string  `json:"walletId"`
	Type        string  `json:"type"`
	AmountCents int64   `json:"amountCents"`
	Description string  `json:"description"`
	SessionID   *string `json:"sessionId"`
	CreatedAt   string  `json:"createdAt"`
}

// AgenticWalletList is the response of GET /api/agent-wallet.
type AgenticWalletList struct {
	Wallets []AgenticWallet `json:"wallets"`
}

// AgenticWalletFundResult is the response of the fund call.
type AgenticWalletFundResult struct {
	Transaction AgenticWalletTransaction `json:"transaction"`
}

// AgenticWalletTransactions is the response of the transactions call.
type AgenticWalletTransactions struct {
	Transactions []AgenticWalletTransaction `json:"transactions"`
}

// AgenticWalletDeleteResult is the response of DELETE.
type AgenticWalletDeleteResult struct {
	Deleted       bool  `json:"deleted"`
	RefundedCents int64 `json:"refundedCents"`
}

// CreateAgenticWalletOptions: SpendingLimitCents defaults to 10000.
type CreateAgenticWalletOptions struct {
	SpendingLimitCents *int64
	DailyLimitCents    *int64
	AllowedDomains     []string
}

// WalletPolicy is the PATCH body of UpdateWalletPolicy (nil fields are omitted).
type WalletPolicy struct {
	DailyLimitCents *int64   `json:"dailyLimitCents,omitempty"`
	AllowedDomains  []string `json:"allowedDomains,omitempty"`
}

func awPath(id string) string { return "/api/agent-wallet/" + seg(id) }

// Create: POST /api/agent-wallet.
func (r *AgenticWalletResource) Create(ctx context.Context, label string, opts CreateAgenticWalletOptions) (*AgenticWallet, error) {
	spend := int64(10000)
	if opts.SpendingLimitCents != nil {
		spend = *opts.SpendingLimitCents
	}
	if err := validateCents(spend, "spendingLimitCents", true); err != nil {
		return nil, err
	}
	body := map[string]any{"label": label, "spendingLimitCents": spend}
	if opts.DailyLimitCents != nil {
		if err := validateCents(*opts.DailyLimitCents, "dailyLimitCents", true); err != nil {
			return nil, err
		}
		body["dailyLimitCents"] = *opts.DailyLimitCents
	}
	if opts.AllowedDomains != nil {
		body["allowedDomains"] = opts.AllowedDomains
	}
	var out AgenticWallet
	return &out, r.h.post(ctx, "/api/agent-wallet", body, authJWT, &out)
}

// List: GET /api/agent-wallet.
func (r *AgenticWalletResource) List(ctx context.Context) (*AgenticWalletList, error) {
	var out AgenticWalletList
	return &out, r.h.get(ctx, "/api/agent-wallet", authJWT, &out)
}

// Get: GET /api/agent-wallet/{id}.
func (r *AgenticWalletResource) Get(ctx context.Context, walletID string) (*AgenticWallet, error) {
	var out AgenticWallet
	return &out, r.h.get(ctx, awPath(walletID), authJWT, &out)
}

// Fund: POST /api/agent-wallet/{id}/fund.
func (r *AgenticWalletResource) Fund(ctx context.Context, walletID string, amountCents int64) (*AgenticWalletFundResult, error) {
	if err := validateCents(amountCents, "amountCents", false); err != nil {
		return nil, err
	}
	var out AgenticWalletFundResult
	return &out, r.h.post(ctx, awPath(walletID)+"/fund", map[string]any{"amountCents": amountCents}, authJWT, &out)
}

// UpdateWalletPolicy: PATCH /api/agent-wallet/{id}/policy.
func (r *AgenticWalletResource) UpdateWalletPolicy(ctx context.Context, walletID string, policy WalletPolicy) (*AgenticWallet, error) {
	if policy.DailyLimitCents != nil {
		if err := validateCents(*policy.DailyLimitCents, "dailyLimitCents", true); err != nil {
			return nil, err
		}
	}
	var out AgenticWallet
	return &out, r.h.patch(ctx, awPath(walletID)+"/policy", policy, authJWT, &out)
}

// Transactions: GET /api/agent-wallet/{id}/transactions?limit&offset.
func (r *AgenticWalletResource) Transactions(ctx context.Context, walletID string, limit, offset *int) (*AgenticWalletTransactions, error) {
	var out AgenticWalletTransactions
	return &out, r.h.get(ctx, awPath(walletID)+"/transactions"+query(qInt("limit", limit), qInt("offset", offset)), authJWT, &out)
}

// Freeze: POST /api/agent-wallet/{id}/freeze.
func (r *AgenticWalletResource) Freeze(ctx context.Context, walletID string) (*AgenticWallet, error) {
	var out AgenticWallet
	return &out, r.h.post(ctx, awPath(walletID)+"/freeze", map[string]any{}, authJWT, &out)
}

// Unfreeze: POST /api/agent-wallet/{id}/unfreeze.
func (r *AgenticWalletResource) Unfreeze(ctx context.Context, walletID string) (*AgenticWallet, error) {
	var out AgenticWallet
	return &out, r.h.post(ctx, awPath(walletID)+"/unfreeze", map[string]any{}, authJWT, &out)
}

// Delete: DELETE /api/agent-wallet/{id}.
func (r *AgenticWalletResource) Delete(ctx context.Context, walletID string) (*AgenticWalletDeleteResult, error) {
	var out AgenticWalletDeleteResult
	return &out, r.h.del(ctx, awPath(walletID), authJWT, &out)
}

// ---------------------------------------------------------------- usage (4)

// UsageResource: /api/usage [jwt]. From/To map to since/until (ISO 8601).
type UsageResource struct{ h *httpClient }

// DateRange bounds a usage query ("" = unset).
type DateRange struct {
	From string
	To   string
}

// Period echoes the server's date window.
type Period struct {
	Since string `json:"since"`
	Until string `json:"until"`
}

// UsageRecord is one metered request.
type UsageRecord struct {
	ID         string `json:"id"`
	SessionID  string `json:"sessionId"`
	BytesIn    int64  `json:"bytesIn"`
	BytesOut   int64  `json:"bytesOut"`
	TotalBytes int64  `json:"totalBytes"`
	CostCents  int64  `json:"costCents"`
	ProxyType  string `json:"proxyType"`
	TargetHost string `json:"targetHost"`
	CreatedAt  string `json:"createdAt"`
}

// UsageResult is the response of GET /api/usage.
type UsageResult struct {
	Summary struct {
		TotalBytes     int64   `json:"totalBytes"`
		TotalCostCents int64   `json:"totalCostCents"`
		RequestCount   int64   `json:"requestCount"`
		TotalGB        float64 `json:"totalGB"`
		TotalCostUsd   float64 `json:"totalCostUsd"`
	} `json:"summary"`
	Records    []UsageRecord `json:"records"`
	Pagination struct {
		Limit  int   `json:"limit"`
		Offset int   `json:"offset"`
		Total  int64 `json:"total"`
	} `json:"pagination"`
	Period Period `json:"period"`
}

// DailyUsage is the response of GET /api/usage/daily.
type DailyUsage struct {
	Days []struct {
		Date           string  `json:"date"`
		TotalBytes     int64   `json:"totalBytes"`
		TotalGB        float64 `json:"totalGB"`
		TotalCostCents int64   `json:"totalCostCents"`
		TotalCostUsd   float64 `json:"totalCostUsd"`
		RequestCount   int64   `json:"requestCount"`
	} `json:"days"`
	Period Period `json:"period"`
}

// TopHosts is the response of GET /api/usage/top-hosts.
type TopHosts struct {
	Hosts []struct {
		TargetHost   string  `json:"targetHost"`
		TotalBytes   int64   `json:"totalBytes"`
		TotalGB      float64 `json:"totalGB"`
		RequestCount int64   `json:"requestCount"`
	} `json:"hosts"`
	Period Period `json:"period"`
}

// Get: GET /api/usage?since&until&limit&offset.
func (r *UsageResource) Get(ctx context.Context, rng DateRange, limit, offset *int) (*UsageResult, error) {
	var out UsageResult
	q := query(qStr("since", rng.From), qStr("until", rng.To), qInt("limit", limit), qInt("offset", offset))
	return &out, r.h.get(ctx, "/api/usage"+q, authJWT, &out)
}

// GetDaily: GET /api/usage/daily?since&until.
func (r *UsageResource) GetDaily(ctx context.Context, rng DateRange) (*DailyUsage, error) {
	var out DailyUsage
	return &out, r.h.get(ctx, "/api/usage/daily"+query(qStr("since", rng.From), qStr("until", rng.To)), authJWT, &out)
}

// GetTopHosts: GET /api/usage/top-hosts?since&until&limit.
func (r *UsageResource) GetTopHosts(ctx context.Context, rng DateRange, limit *int) (*TopHosts, error) {
	var out TopHosts
	q := query(qStr("since", rng.From), qStr("until", rng.To), qInt("limit", limit))
	return &out, r.h.get(ctx, "/api/usage/top-hosts"+q, authJWT, &out)
}

// ExportCSV: GET /api/usage/export?since&until -> raw CSV.
func (r *UsageResource) ExportCSV(ctx context.Context, rng DateRange) (string, error) {
	b, err := r.h.do(ctx, request{method: "GET", path: "/api/usage/export" + query(qStr("since", rng.From), qStr("until", rng.To)), auth: authJWT})
	return string(b), err
}

// ---------------------------------------------------------------- sessions (2)

// SessionsResource: active sessions and burned-exit reports.
type SessionsResource struct{ h *httpClient }

// ActiveSession deliberately has no IP field.
type ActiveSession struct {
	ID        string `json:"id"`
	StartedAt string `json:"startedAt"`
	Status    string `json:"status"`
}

// ActiveSessions is the response of GetActive.
type ActiveSessions struct {
	Sessions []ActiveSession `json:"sessions"`
}

// ReportResult is the response of Report.
type ReportResult struct {
	ReportID     string `json:"reportId"`
	ReportsToday int    `json:"reportsToday"`
	LimitPerDay  int    `json:"limitPerDay"`
}

// ReportReasons accepted by Report.
var ReportReasons = []string{"blocked", "captcha", "rate_limited", "slow", "bad_content", "other"}

// GetActive: GET /api/sessions/active [jwt]. Only id/startedAt/status are kept.
func (r *SessionsResource) GetActive(ctx context.Context) (*ActiveSessions, error) {
	var raw struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := r.h.get(ctx, "/api/sessions/active", authJWT, &raw); err != nil {
		return nil, err
	}
	out := &ActiveSessions{Sessions: make([]ActiveSession, 0, len(raw.Sessions))}
	str := func(v any) string {
		if s, ok := v.(string); ok {
			return s
		}
		return ""
	}
	for _, s := range raw.Sessions {
		out.Sessions = append(out.Sessions, ActiveSession{ID: str(s["id"]), StartedAt: str(s["startedAt"]), Status: str(s["status"])})
	}
	return out, nil
}

// Report: POST /v1/sessions/{id}/report [agent].
func (r *SessionsResource) Report(ctx context.Context, sessionID, reason string) (*ReportResult, error) {
	if err := validateUUID(sessionID, "sessionId"); err != nil {
		return nil, err
	}
	if !oneOf(reason, ReportReasons) {
		return nil, invalidArg("reason must be one of %s", strings.Join(ReportReasons, ", "))
	}
	var out ReportResult
	return &out, r.h.post(ctx, "/v1/sessions/"+seg(sessionID)+"/report", map[string]any{"reason": reason}, authAgent, &out)
}

// ---------------------------------------------------------------- x402 (1)

// X402Resource: x402 micropayment info.
type X402Resource struct{ h *httpClient }

// X402Facilitator describes one facilitator.
type X402Facilitator struct {
	Network          string `json:"network"`
	ReceivingAddress string `json:"receivingAddress"`
	Currency         string `json:"currency"`
}

// X402Info is the response of GET /api/x402/info.
type X402Info struct {
	Supported      bool                       `json:"supported"`
	Enabled        bool                       `json:"enabled"`
	Protocol       string                     `json:"protocol"`
	Version        string                     `json:"version"`
	Facilitators   map[string]X402Facilitator `json:"facilitators"`
	Pricing        map[string]any             `json:"pricing"`
	Currencies     []string                   `json:"currencies"`
	WalletType     string                     `json:"walletType"`
	AgenticWallets bool                       `json:"agenticWallets"`
}

// GetInfo: GET /api/x402/info [none].
func (r *X402Resource) GetInfo(ctx context.Context) (*X402Info, error) {
	var out X402Info
	return &out, r.h.get(ctx, "/api/x402/info", authNone, &out)
}
