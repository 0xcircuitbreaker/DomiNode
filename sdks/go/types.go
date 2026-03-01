package dominusnode

import "fmt"

// --- Auth types ---

// User represents a Dominus Node user account.
type User struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	IsAdmin   bool   `json:"is_admin"`
	CreatedAt string `json:"created_at,omitempty"`
}

// LoginResult is the response from login or register operations.
// When MFARequired is true, the caller must complete MFA verification
// before the client is fully authenticated.
type LoginResult struct {
	User              *User  `json:"user,omitempty"`
	MFARequired       bool   `json:"mfaRequired,omitempty"`
	MFAChallengeToken string `json:"mfaChallengeToken,omitempty"`
	Token             string `json:"token,omitempty"`
	RefreshToken      string `json:"refreshToken,omitempty"`
}

// String returns a redacted string representation of LoginResult,
// hiding sensitive token values.
func (lr LoginResult) String() string {
	tokenStr := "<none>"
	if lr.Token != "" {
		tokenStr = "<redacted>"
	}
	refreshStr := "<none>"
	if lr.RefreshToken != "" {
		refreshStr = "<redacted>"
	}
	return fmt.Sprintf("LoginResult{User: %v, MFARequired: %v, Token: %s, RefreshToken: %s}",
		lr.User, lr.MFARequired, tokenStr, refreshStr)
}

// GoString returns a redacted Go-syntax representation of LoginResult.
func (lr LoginResult) GoString() string {
	return lr.String()
}

// TokenPair holds an access token and refresh token pair.
type TokenPair struct {
	AccessToken  string `json:"token"`
	RefreshToken string `json:"refreshToken,omitempty"`
}

// String returns a redacted string representation of TokenPair.
// Prevent accidental credential leakage in logs.
func (tp TokenPair) String() string {
	accessStr := "<none>"
	if tp.AccessToken != "" {
		accessStr = "<redacted>"
	}
	refreshStr := "<none>"
	if tp.RefreshToken != "" {
		refreshStr = "<redacted>"
	}
	return fmt.Sprintf("TokenPair{AccessToken: %s, RefreshToken: %s}", accessStr, refreshStr)
}

// GoString returns a redacted Go-syntax representation of TokenPair.
func (tp TokenPair) GoString() string {
	return tp.String()
}

// VerifyKeyResult is the response from API key verification.
type VerifyKeyResult struct {
	Valid        bool   `json:"valid"`
	Token        string `json:"token"`
	RefreshToken string `json:"refreshToken"`
	UserID       string `json:"userId"`
	Email        string `json:"email"`
}

// String returns a redacted string representation of VerifyKeyResult.
// Prevent accidental credential leakage in logs.
func (vr VerifyKeyResult) String() string {
	tokenStr := "<none>"
	if vr.Token != "" {
		tokenStr = "<redacted>"
	}
	refreshStr := "<none>"
	if vr.RefreshToken != "" {
		refreshStr = "<redacted>"
	}
	return fmt.Sprintf("VerifyKeyResult{Valid: %v, Token: %s, RefreshToken: %s, UserID: %s, Email: <redacted>}",
		vr.Valid, tokenStr, refreshStr, vr.UserID)
}

// GoString returns a redacted Go-syntax representation of VerifyKeyResult.
func (vr VerifyKeyResult) GoString() string {
	return vr.String()
}

// MFASetup contains the data needed to set up MFA for a user.
type MFASetup struct {
	Secret      string   `json:"secret"`
	OTPAuthURI  string   `json:"otpauthUri"`
	BackupCodes []string `json:"backupCodes"`
}

// String returns a redacted string representation of MFASetup.
func (m MFASetup) String() string {
	return fmt.Sprintf("MFASetup{Secret: <redacted>, OTPAuthURI: <redacted>, BackupCodes: [%d codes redacted]}", len(m.BackupCodes))
}

// GoString returns a redacted Go-syntax representation of MFASetup.
func (m MFASetup) GoString() string {
	return m.String()
}

// MFAStatus represents the current MFA configuration status.
type MFAStatus struct {
	Enabled              bool `json:"enabled"`
	BackupCodesRemaining int  `json:"backupCodesRemaining"`
}

// MFAEnableResult is the response from enabling MFA.
type MFAEnableResult struct {
	Enabled bool `json:"enabled"`
}

// MFADisableResult is the response from disabling MFA.
type MFADisableResult struct {
	Enabled bool `json:"enabled"`
}

// MFAOption configures optional parameters for MFA verification.
type MFAOption func(*mfaOptions)

type mfaOptions struct {
	mfaChallengeToken string
	isBackupCode      bool
}

// WithMFAChallengeToken sets the MFA challenge token for verification.
func WithMFAChallengeToken(token string) MFAOption {
	return func(o *mfaOptions) {
		o.mfaChallengeToken = token
	}
}

// WithBackupCode indicates the code is a backup code, not a TOTP code.
func WithBackupCode(isBackup bool) MFAOption {
	return func(o *mfaOptions) {
		o.isBackupCode = isBackup
	}
}

// ChangePasswordRequest is the request body for changing a password.
type ChangePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

// MeResponse is the response from the /auth/me endpoint.
type MeResponse struct {
	User User `json:"user"`
}

// --- Keys types ---

// APIKey represents an API key (without the raw secret).
type APIKey struct {
	ID        string  `json:"id"`
	Prefix    string  `json:"prefix"`
	Label     string  `json:"label"`
	CreatedAt string  `json:"created_at"`
	RevokedAt *string `json:"revoked_at"`
}

// CreatedAPIKey is returned when a new API key is created.
// The Key field contains the raw secret and is only shown once.
type CreatedAPIKey struct {
	Key       string `json:"key"`
	ID        string `json:"id"`
	Prefix    string `json:"prefix"`
	Label     string `json:"label"`
	CreatedAt string `json:"created_at"`
}

// String returns a redacted string representation, hiding the raw key.
func (c CreatedAPIKey) String() string {
	return fmt.Sprintf("CreatedAPIKey{ID: %s, Prefix: %s, Label: %s, Key: <redacted>}", c.ID, c.Prefix, c.Label)
}

// GoString returns a redacted Go-syntax representation.
func (c CreatedAPIKey) GoString() string {
	return c.String()
}

// ListKeysResponse is the response from listing API keys.
type ListKeysResponse struct {
	Keys []APIKey `json:"keys"`
}

// --- Wallet types ---

// Wallet represents a user's wallet with balance information.
type Wallet struct {
	BalanceCents int     `json:"balanceCents"`
	BalanceUSD   float64 `json:"balanceUsd"`
	Currency     string  `json:"currency"`
	LastToppedUp *string `json:"lastToppedUp"`
}

// WalletTransaction represents a single wallet transaction.
type WalletTransaction struct {
	ID              string  `json:"id"`
	Type            string  `json:"type"`
	AmountCents     int     `json:"amountCents"`
	AmountUSD       float64 `json:"amountUsd"`
	Description     string  `json:"description"`
	PaymentProvider *string `json:"paymentProvider"`
	CreatedAt       string  `json:"createdAt"`
}

// TransactionsResponse is the response from listing wallet transactions.
type TransactionsResponse struct {
	Transactions []WalletTransaction `json:"transactions"`
}

// TransactionOptions configures optional parameters for listing transactions.
type TransactionOptions struct {
	Limit  *int
	Offset *int
}

// StripeCheckout is the response from creating a Stripe checkout session.
type StripeCheckout struct {
	SessionID string `json:"sessionId"`
	URL       string `json:"url"`
}

// CryptoInvoice is the response from creating a crypto payment invoice.
type CryptoInvoice struct {
	InvoiceID   string  `json:"invoiceId"`
	InvoiceURL  string  `json:"invoiceUrl"`
	PayCurrency string  `json:"payCurrency"`
	PriceAmount float64 `json:"priceAmount"`
}

// PaypalOrder is the response from creating a PayPal order for wallet top-up.
type PaypalOrder struct {
	OrderID     string `json:"orderId"`
	ApprovalURL string `json:"approvalUrl"`
	AmountCents int    `json:"amountCents"`
}

// WalletForecast contains spending forecast data.
type WalletForecast struct {
	DailyAvgCents int      `json:"dailyAvgCents"`
	DaysRemaining *float64 `json:"daysRemaining"`
	Trend         string   `json:"trend"`
	TrendPct      float64  `json:"trendPct"`
}

// --- Usage types ---

// UsageSummary contains aggregated usage statistics.
type UsageSummary struct {
	TotalBytes     int64   `json:"totalBytes"`
	TotalCostCents int     `json:"totalCostCents"`
	RequestCount   int     `json:"requestCount"`
	TotalGB        float64 `json:"totalGB"`
	TotalCostUSD   float64 `json:"totalCostUsd"`
}

// UsageRecord represents a single usage record.
type UsageRecord struct {
	ID         string `json:"id"`
	SessionID  string `json:"sessionId"`
	BytesIn    int64  `json:"bytesIn"`
	BytesOut   int64  `json:"bytesOut"`
	TotalBytes int64  `json:"totalBytes"`
	CostCents  int    `json:"costCents"`
	ProxyType  string `json:"proxyType"`
	TargetHost string `json:"targetHost"`
	CreatedAt  string `json:"createdAt"`
}

// UsagePagination contains pagination metadata for usage queries.
type UsagePagination struct {
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
	Total  int `json:"total"`
}

// UsagePeriod describes the time range of a usage query.
type UsagePeriod struct {
	Since string `json:"since"`
	Until string `json:"until"`
}

// UsageResponse is the full response from the usage endpoint.
type UsageResponse struct {
	Summary    UsageSummary    `json:"summary"`
	Records    []UsageRecord   `json:"records"`
	Pagination UsagePagination `json:"pagination"`
	Period     UsagePeriod     `json:"period"`
}

// UsageOptions configures optional parameters for usage queries.
type UsageOptions struct {
	From   string
	To     string
	Limit  *int
	Offset *int
}

// DailyUsage represents usage data for a single day.
type DailyUsage struct {
	Date           string  `json:"date"`
	TotalBytes     int64   `json:"totalBytes"`
	TotalGB        float64 `json:"totalGB"`
	TotalCostCents int     `json:"totalCostCents"`
	TotalCostUSD   float64 `json:"totalCostUsd"`
	RequestCount   int     `json:"requestCount"`
}

// DailyUsageResponse is the response from the daily usage endpoint.
type DailyUsageResponse struct {
	Days   []DailyUsage `json:"days"`
	Period UsagePeriod  `json:"period"`
}

// DateRangeOptions configures date range parameters for queries.
type DateRangeOptions struct {
	From string
	To   string
}

// TopHost represents a target host ranked by bandwidth usage.
type TopHost struct {
	TargetHost   string  `json:"targetHost"`
	TotalBytes   int64   `json:"totalBytes"`
	TotalGB      float64 `json:"totalGB"`
	RequestCount int     `json:"requestCount"`
}

// TopHostsResponse is the response from the top hosts endpoint.
type TopHostsResponse struct {
	Hosts  []TopHost   `json:"hosts"`
	Period UsagePeriod `json:"period"`
}

// TopHostsOptions configures optional parameters for top hosts queries.
type TopHostsOptions struct {
	From  string
	To    string
	Limit *int
}

// --- Plans types ---

// Plan represents a subscription plan.
type Plan struct {
	ID                    string   `json:"id"`
	Name                  string   `json:"name"`
	PricePerGBCents       int      `json:"pricePerGbCents"`
	PricePerGBUSD         float64  `json:"pricePerGbUsd"`
	MonthlyBandwidthBytes int64    `json:"monthlyBandwidthBytes"`
	MonthlyBandwidthGB    *float64 `json:"monthlyBandwidthGB"`
	IsDefault             bool     `json:"isDefault"`
}

// ListPlansResponse is the response from listing available plans.
type ListPlansResponse struct {
	Plans []Plan `json:"plans"`
}

// UserPlanUsage contains the user's current plan usage information.
type UserPlanUsage struct {
	MonthlyUsageBytes int64    `json:"monthlyUsageBytes"`
	MonthlyUsageGB    float64  `json:"monthlyUsageGB"`
	LimitBytes        int64    `json:"limitBytes"`
	LimitGB           *float64 `json:"limitGB"`
	PercentUsed       *float64 `json:"percentUsed"`
}

// UserPlanInfo is the response from getting the user's current plan.
type UserPlanInfo struct {
	Plan  Plan          `json:"plan"`
	Usage UserPlanUsage `json:"usage"`
}

// ChangePlanResult is the response from changing the user's plan.
type ChangePlanResult struct {
	Message string `json:"message"`
	Plan    Plan   `json:"plan"`
}

// --- Sessions types ---

// ActiveSession represents a currently active proxy session.
type ActiveSession struct {
	ID        string `json:"id"`
	StartedAt string `json:"startedAt"`
	Status    string `json:"status"`
}

// ActiveSessionsResponse is the response from listing active sessions.
type ActiveSessionsResponse struct {
	Sessions []ActiveSession `json:"sessions"`
}

// --- Proxy types ---

// ProxyURLOptions configures proxy URL building parameters.
type ProxyURLOptions struct {
	// Protocol selects the proxy protocol. Valid values: "http", "socks5".
	// Defaults to "http".
	Protocol string
	// Country is the ISO 3166-1 alpha-2 country code for geo-targeting.
	Country string
	// State is the state/province code for geo-targeting.
	State string
	// City is the city name for geo-targeting.
	City string
	// ASN is the autonomous system number for geo-targeting.
	ASN int
	// SessionID creates a sticky session with the given identifier.
	SessionID string
}

// ProxyHealth is the response from the proxy health endpoint.
type ProxyHealth struct {
	Status         string `json:"status"`
	ActiveSessions int    `json:"activeSessions"`
	UptimeSeconds  int64  `json:"uptimeSeconds"`
}

// ProviderStat contains statistics for a single upstream proxy provider.
type ProviderStat struct {
	Name                string  `json:"name"`
	State               string  `json:"state"`
	ConsecutiveFailures int     `json:"consecutiveFailures"`
	TotalRequests       int64   `json:"totalRequests"`
	TotalErrors         int64   `json:"totalErrors"`
	AvgLatencyMs        float64 `json:"avgLatencyMs"`
	FallbackOnly        bool    `json:"fallbackOnly"`
}

// ProxyEndpoints contains the proxy server endpoint addresses.
type ProxyEndpoints struct {
	HTTP   string `json:"http"`
	SOCKS5 string `json:"socks5"`
}

// ProxyStatus is the detailed response from the proxy status endpoint.
type ProxyStatus struct {
	Status             string         `json:"status"`
	ActiveSessions     int            `json:"activeSessions"`
	UserActiveSessions int            `json:"userActiveSessions"`
	AvgLatencyMs       float64        `json:"avgLatencyMs"`
	Providers          []ProviderStat `json:"providers"`
	Endpoints          ProxyEndpoints `json:"endpoints"`
	SupportedCountries []string       `json:"supportedCountries"`
	UptimeSeconds      int64          `json:"uptimeSeconds"`
}

// GeoTargeting describes the geo-targeting capabilities of the proxy.
type GeoTargeting struct {
	StateSupport bool `json:"stateSupport"`
	CitySupport  bool `json:"citySupport"`
	ASNSupport   bool `json:"asnSupport"`
}

// ProxyEndpointConfig describes a single proxy endpoint's host and port.
type ProxyEndpointConfig struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

// ProxyConfig is the response from the proxy config endpoint.
type ProxyConfig struct {
	HTTPProxy          ProxyEndpointConfig `json:"httpProxy"`
	SOCKS5Proxy        ProxyEndpointConfig `json:"socks5Proxy"`
	SupportedCountries []string            `json:"supportedCountries"`
	BlockedCountries   []string            `json:"blockedCountries"`
	GeoTargeting       *GeoTargeting       `json:"geoTargeting,omitempty"`
}

// --- Admin types ---

// AdminUser represents a user as seen by an admin.
type AdminUser struct {
	ID           string `json:"id"`
	Email        string `json:"email"`
	Status       string `json:"status"`
	IsAdmin      bool   `json:"is_admin"`
	CreatedAt    string `json:"created_at"`
	BalanceCents int    `json:"balance_cents"`
}

// AdminUserDetail is the response from getting a single user as admin.
type AdminUserDetail struct {
	User AdminUser `json:"user"`
}

// Pagination contains pagination metadata for admin list endpoints.
type Pagination struct {
	Page       int `json:"page"`
	Limit      int `json:"limit"`
	Total      int `json:"total"`
	TotalPages int `json:"totalPages"`
}

// AdminUsersResponse is the response from listing users as admin.
type AdminUsersResponse struct {
	Users      []AdminUser `json:"users"`
	Pagination Pagination  `json:"pagination"`
}

// AdminListOptions configures optional parameters for admin list queries.
type AdminListOptions struct {
	Page  *int
	Limit *int
}

// AdminDateRangeOptions configures date range parameters for admin queries.
type AdminDateRangeOptions struct {
	Since string
	Until string
}

// RevenueStats contains revenue statistics for a given period.
type RevenueStats struct {
	TotalRevenueCents   int         `json:"totalRevenueCents"`
	TotalRevenueUSD     float64     `json:"totalRevenueUsd"`
	AvgTransactionCents int         `json:"avgTransactionCents"`
	AvgTransactionUSD   float64     `json:"avgTransactionUsd"`
	TransactionCount    int         `json:"transactionCount"`
	TopupCount          int         `json:"topupCount"`
	Period              UsagePeriod `json:"period"`
}

// DailyRevenue represents revenue data for a single day.
type DailyRevenue struct {
	Date         string  `json:"date"`
	RevenueCents int     `json:"revenueCents"`
	RevenueUSD   float64 `json:"revenueUsd"`
}

// DailyRevenueResponse is the response from the daily revenue endpoint.
type DailyRevenueResponse struct {
	Days   []DailyRevenue `json:"days"`
	Period UsagePeriod    `json:"period"`
}

// SystemStats contains system-wide statistics.
type SystemStats struct {
	ActiveSessions      int   `json:"active_sessions"`
	TotalUsers          int   `json:"total_users"`
	TotalBandwidthBytes int64 `json:"total_bandwidth_bytes"`
}

// MessageResponse is a generic response containing just a message.
type MessageResponse struct {
	Message string `json:"message"`
}

// --- Slots & Waitlist types ---

// SlotsInfo contains registration slot availability information.
type SlotsInfo struct {
	Total     int  `json:"total"`
	Used      int  `json:"used"`
	Remaining int  `json:"remaining"`
	Unlimited bool `json:"unlimited"`
}

// WaitlistJoinResult is the response from joining the waitlist.
type WaitlistJoinResult struct {
	Message string `json:"message"`
}

// WaitlistCount contains the number of pending waitlist entries.
type WaitlistCount struct {
	Pending int `json:"pending"`
}
