package dominusnode

import (
	"context"
	"net/http"
	"sync"
	"time"
)

const (
	// SDKVersion is the current version of the Dominus Node Go SDK.
	SDKVersion = "1.0.0"

	// UserAgent is the User-Agent header sent with all HTTP requests.
	UserAgent = "dominusnode-sdk-go/" + SDKVersion

	// DefaultBaseURL is the default Dominus Node API server URL.
	DefaultBaseURL = "https://api.dominusnode.com"

	// DefaultProxyHost is the default hostname of the Dominus Node proxy server.
	DefaultProxyHost = "proxy.dominusnode.com"

	// DefaultHTTPProxyPort is the default port for the HTTP proxy.
	DefaultHTTPProxyPort = 8080

	// DefaultSOCKS5ProxyPort is the default port for the SOCKS5 proxy.
	DefaultSOCKS5ProxyPort = 1080

	// TokenRefreshBuffer is the time before token expiry at which
	// the token manager will proactively refresh.
	TokenRefreshBuffer = 60 * time.Second

	// MaxRetryWaitSeconds is the maximum number of seconds to wait
	// when retrying after a 429 rate limit response. Caps the
	// Retry-After header to prevent client-side DoS.
	MaxRetryWaitSeconds = 10
)

// Client is the main Dominus Node SDK client.
// It provides access to all API resources through public fields.
//
// Create a new client with NewClient, then authenticate using
// ConnectWithKey or ConnectWithCredentials before making API calls.
type Client struct {
	// Auth provides authentication and account management operations.
	Auth *AuthResource

	// Keys provides API key management operations.
	Keys *KeysResource

	// Wallet provides wallet and payment operations.
	Wallet *WalletResource

	// Usage provides usage statistics and data export operations.
	Usage *UsageResource

	// Plans provides plan management operations.
	Plans *PlansResource

	// Sessions provides proxy session operations.
	Sessions *SessionsResource

	// Proxy provides proxy URL building and status operations.
	Proxy *ProxyResource

	// Admin provides administrative operations (requires admin privileges).
	Admin *AdminResource

	httpClient   *httpClient
	tokenManager *tokenManager
	config       Config
	apiKey       string
	apiKeyMu     sync.RWMutex
}

// NewClient creates a new Dominus Node client with the given configuration.
//
// Example:
//
//	client := dominusnode.NewClient(dominusnode.Config{
//	    BaseURL: "http://localhost:3000",
//	})
//	err := client.ConnectWithKey(ctx, "dn_live_YOUR_KEY")
func NewClient(cfg Config) *Client {
	cfg = cfg.withDefaults()

	// Create HTTP client
	var httpCl *http.Client
	if cfg.HTTPClient != nil {
		httpCl = cfg.HTTPClient
	} else {
		httpCl = &http.Client{
			Timeout: cfg.Timeout,
			// R16 G-2: Disable auto-redirects to prevent credential leakage via protocol downgrade
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}

	tm := newTokenManager()
	hc := newHTTPClient(cfg.BaseURL, tm, httpCl)

	c := &Client{
		httpClient:   hc,
		tokenManager: tm,
		config:       cfg,
		apiKey:       cfg.APIKey,
	}

	// Set the refresh function to use the Auth resource
	tm.setRefreshFn(func(ctx context.Context, refreshToken string) (string, string, error) {
		result, err := c.Auth.Refresh(ctx, refreshToken)
		if err != nil {
			return "", "", err
		}
		return result.AccessToken, result.RefreshToken, nil
	})

	// Initialize all resources
	c.Auth = newAuthResource(hc, tm)
	c.Keys = newKeysResource(hc)
	c.Wallet = newWalletResource(hc)
	c.Usage = newUsageResource(hc)
	c.Plans = newPlansResource(hc)
	c.Sessions = newSessionsResource(hc)
	c.Proxy = newProxyResource(hc, cfg.ProxyHost, cfg.HTTPProxyPort, cfg.SOCKS5ProxyPort, func() string {
		c.apiKeyMu.RLock()
		defer c.apiKeyMu.RUnlock()
		return c.apiKey
	})
	c.Admin = newAdminResource(hc)

	// Pre-set tokens if provided in config
	if cfg.AccessToken != "" {
		tm.setTokens(cfg.AccessToken, cfg.RefreshToken)
	}

	return c
}

// ConnectWithKey authenticates the client using an API key.
// The key is verified against the server and the resulting JWT tokens
// are stored for subsequent authenticated requests.
func (c *Client) ConnectWithKey(ctx context.Context, apiKey string) error {
	c.apiKeyMu.Lock()
	c.apiKey = apiKey
	c.apiKeyMu.Unlock()
	_, err := c.Auth.VerifyKey(ctx, apiKey)
	return err
}

// ConnectWithCredentials authenticates the client using email and password.
// If the returned LoginResult has MFARequired set to true, call CompleteMFA
// to finish the authentication flow.
func (c *Client) ConnectWithCredentials(ctx context.Context, email, password string) (*LoginResult, error) {
	result, err := c.Auth.Login(ctx, email, password)
	if err != nil {
		return nil, err
	}
	return result, nil
}

// CompleteMFA completes MFA verification after a login that returned MFARequired.
// Pass the TOTP code (or backup code with WithBackupCode option).
// Use WithMFAChallengeToken if the server provided a challenge token.
func (c *Client) CompleteMFA(ctx context.Context, code string, opts ...MFAOption) error {
	_, err := c.Auth.VerifyMFA(ctx, code, opts...)
	return err
}

// Disconnect logs out the current session and clears all stored tokens.
// It attempts to call the server-side logout endpoint to revoke refresh tokens,
// but clears local state regardless of whether the server call succeeds.
func (c *Client) Disconnect() {
	ctx := context.Background()
	// Best-effort server-side logout
	_ = c.Auth.Logout(ctx)
	c.tokenManager.clear()
	c.apiKeyMu.Lock()
	c.apiKey = ""
	c.apiKeyMu.Unlock()
}
