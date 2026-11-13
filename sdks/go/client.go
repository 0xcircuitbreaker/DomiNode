// Package dominusnode is the Go SDK for the DominusNode relay network (v2).
//
//	c, err := dominusnode.NewClient(dominusnode.Config{})
//	_, err = c.ConnectWithKey(ctx, os.Getenv("DOMINUSNODE_API_KEY"))
//	res, err := c.Proxy.Fetch(ctx, "https://example.com", dominusnode.FetchOptions{
//		Routing: dominusnode.RoutingOptions{Country: "US"},
//	})
//
// The API surface follows sdks/SDK_SURFACE.md (15 resources, 71 methods).
package dominusnode

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"sync"
)

const (
	// SDKVersion is the SDK version.
	SDKVersion = "2.3.0"
	// UserAgent is sent on every API request.
	UserAgent = "dominusnode-sdk-go/" + SDKVersion
	// DefaultBaseURL is the API server.
	DefaultBaseURL = "https://api.dominusnode.com"
	// DefaultProxyHost is the proxy gateway host.
	DefaultProxyHost = "proxy.dominusnode.com"
	// DefaultHTTPProxyPort is the HTTP(S) proxy port.
	DefaultHTTPProxyPort = 8080
	// DefaultSOCKS5ProxyPort is the SOCKS5 proxy port.
	DefaultSOCKS5ProxyPort = 1080
	// DefaultTLSProxyPort is the gateway's HTTPS proxy listener (PROXY_TLS_PORT), used with GatewayTLS.
	DefaultTLSProxyPort = 8443
)

// LookupFunc resolves a hostname to ALL of its addresses (A + AAAA).
type LookupFunc func(ctx context.Context, host string) ([]string, error)

// Config configures a Client. Zero values select the defaults.
type Config struct {
	BaseURL         string
	ProxyHost       string
	HTTPProxyPort   int
	SOCKS5ProxyPort int
	// AccessToken / RefreshToken: optional pre-existing JWT pair.
	AccessToken  string
	RefreshToken string
	// HTTPClient is copied; its CheckRedirect is always replaced so redirects are never followed.
	HTTPClient *http.Client
	// Lookup overrides the DNS resolver used by Proxy.Fetch's rebinding check.
	Lookup LookupFunc
	// GatewayTLS configures TLS to the gateway's HTTPS proxy listener so
	// Proxy-Authorization is encrypted. Since 2.2 TLS is the default: nil means
	// port 8443, system roots, SNI = ProxyHost, and BuildURL defaults to https://.
	// Self-hosted coordinators usually publish 8444 (&GatewayTLS{Port: 8444}).
	// &GatewayTLS{Disabled: true} selects plaintext 8080/1080 (local dev only:
	// production gateways refuse credentials there).
	GatewayTLS *GatewayTLS
}

// GatewayTLS configures TLS to the gateway. Certificate verification is always on.
type GatewayTLS struct {
	// Port defaults to DefaultTLSProxyPort.
	Port int
	// CA is an optional PEM root added to the system roots.
	CA []byte
	// ServerName overrides the TLS server name (default: ProxyHost), e.g. when ProxyHost is an IP.
	ServerName string
	// Disabled selects the plaintext HTTP proxy port instead (2.2).
	Disabled bool
}

// ConnectResult is returned by ConnectWithKey.
type ConnectResult struct {
	MfaRequired bool   `json:"mfaRequired"`
	UserID      string `json:"userId,omitempty"`
}

// Client is the DominusNode relay-network client.
type Client struct {
	Auth           *AuthResource
	WalletAuth     *WalletAuthResource
	Keys           *KeysResource
	Wallet         *WalletResource
	AgenticWallets *AgenticWalletResource
	Teams          *TeamsResource
	Usage          *UsageResource
	Sessions       *SessionsResource
	X402           *X402Resource
	Network        *NetworkResource
	Nodes          *NodesResource
	Credits        *CreditsResource
	PayoutWallet   *PayoutWalletResource
	Payouts        *PayoutsResource
	Proxy          *ProxyResource

	mu     sync.Mutex
	apiKey string
	tokens *tokenManager
	http   *httpClient
}

// NewClient validates cfg and builds a client.
func NewClient(cfg Config) (*Client, error) {
	c := &Client{tokens: newTokenManager()}
	base := cfg.BaseURL
	if base == "" {
		base = DefaultBaseURL
	}
	h, err := newHTTPClient(base, cfg.HTTPClient, c.tokens, c.key)
	if err != nil {
		return nil, err
	}
	c.http = h
	c.Auth = &AuthResource{h}
	c.WalletAuth = &WalletAuthResource{h, c.tokens}
	c.Keys = &KeysResource{h}
	c.Wallet = &WalletResource{h}
	c.AgenticWallets = &AgenticWalletResource{h}
	c.Teams = &TeamsResource{h}
	c.Usage = &UsageResource{h}
	c.Sessions = &SessionsResource{h}
	c.X402 = &X402Resource{h}
	c.Network = &NetworkResource{h}
	c.Nodes = &NodesResource{h}
	c.Credits = &CreditsResource{h}
	c.PayoutWallet = &PayoutWalletResource{h}
	c.Payouts = &PayoutsResource{h}
	if c.Proxy, err = newProxyResource(h, cfg, c.key); err != nil {
		return nil, err
	}
	// Never cleared: tokenManager.clear() keeps it so reconnecting works.
	c.tokens.setRefreshFunc(func(ctx context.Context, rt string) (string, string, error) {
		r, err := c.Auth.Refresh(ctx, rt)
		if err != nil {
			return "", "", err
		}
		return r.Token, r.RefreshToken, nil
	})
	if cfg.AccessToken != "" || cfg.RefreshToken != "" {
		c.tokens.setTokens(cfg.AccessToken, cfg.RefreshToken)
	}
	return c, nil
}

func (c *Client) key() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.apiKey
}

// ConnectWithKey authenticates with a dn_live_/dn_test_ key. The key is kept for
// /v1 agent routes and the proxy; the JWT pair from verify-key is kept for /api
// routes. If the account has MFA on, only the key is stored and MfaRequired is true.
func (c *Client) ConnectWithKey(ctx context.Context, apiKey string) (*ConnectResult, error) {
	if err := ValidateAPIKey(apiKey); err != nil {
		return nil, err
	}
	r, err := c.Auth.VerifyKey(ctx, apiKey)
	if err != nil {
		var de *DominusNodeError
		if errors.As(err, &de) && de.Code == CodeMFARequired {
			c.mu.Lock()
			c.apiKey = apiKey
			c.mu.Unlock()
			return &ConnectResult{MfaRequired: true}, nil
		}
		return nil, err
	}
	c.mu.Lock()
	c.apiKey = apiKey
	c.mu.Unlock()
	c.tokens.setTokens(r.Token, r.RefreshToken)
	return &ConnectResult{MfaRequired: false, UserID: r.UserID}, nil
}

// IsConnected reports whether an API key or any token is held.
func (c *Client) IsConnected() bool {
	return c.key() != "" || c.tokens.hasTokens()
}

// Disconnect revokes the refresh token family (best effort) and clears every
// credential: API key, access token and refresh token.
func (c *Client) Disconnect(ctx context.Context) {
	if c.tokens.hasTokens() {
		_ = c.Auth.Logout(ctx)
	}
	c.mu.Lock()
	c.apiKey = ""
	c.mu.Unlock()
	c.tokens.clear()
}

// String never includes credentials.
func (c *Client) String() string {
	return "DominusNodeClient(connected=" + strconv.FormatBool(c.IsConnected()) + ")"
}

// GoString never includes credentials.
func (c *Client) GoString() string { return c.String() }

// MarshalJSON never includes credentials.
func (c *Client) MarshalJSON() ([]byte, error) {
	return []byte(`{"connected":` + strconv.FormatBool(c.IsConnected()) + `}`), nil
}
