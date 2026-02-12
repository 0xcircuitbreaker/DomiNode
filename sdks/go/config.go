// Package dominode provides a Go SDK for the DomiNode rotating proxy-as-a-service API.
//
// DomiNode is a proxy SaaS platform that provides rotating residential, datacenter,
// and mobile proxies. This SDK supports authentication (API key and JWT), wallet
// management, usage tracking, plan management, proxy URL building with geo-targeting,
// and admin operations.
//
// Quick start with API key:
//
//	client := dominode.NewClient(dominode.Config{
//	    BaseURL: "http://localhost:3000",
//	})
//	err := client.ConnectWithKey(ctx, "dn_live_YOUR_KEY")
//	if err != nil {
//	    log.Fatal(err)
//	}
//	balance, err := client.Wallet.GetBalance(ctx)
//
// Quick start with credentials:
//
//	client := dominode.NewClient(dominode.Config{
//	    BaseURL: "http://localhost:3000",
//	})
//	result, err := client.ConnectWithCredentials(ctx, "user@example.com", "password123")
//	if err != nil {
//	    log.Fatal(err)
//	}
//	if result.MFARequired {
//	    err = client.CompleteMFA(ctx, "123456")
//	}
package dominode

import (
	"net/http"
	"time"
)

// Config holds configuration options for the DomiNode client.
type Config struct {
	// BaseURL is the base URL of the DomiNode API server.
	// Defaults to DefaultBaseURL if empty.
	BaseURL string

	// APIKey is an API key for immediate authentication.
	// If set, the client will verify this key on first use.
	APIKey string

	// Email is the user email for credential-based authentication.
	Email string

	// Password is the user password for credential-based authentication.
	Password string

	// AccessToken is a pre-existing JWT access token.
	AccessToken string

	// RefreshToken is a pre-existing JWT refresh token.
	RefreshToken string

	// ProxyHost is the hostname of the proxy server.
	// Defaults to DefaultProxyHost if empty.
	ProxyHost string

	// HTTPProxyPort is the HTTP proxy port.
	// Defaults to DefaultHTTPProxyPort if zero.
	HTTPProxyPort int

	// SOCKS5ProxyPort is the SOCKS5 proxy port.
	// Defaults to DefaultSOCKS5ProxyPort if zero.
	SOCKS5ProxyPort int

	// Timeout is the HTTP request timeout.
	// Defaults to 30 seconds if zero.
	Timeout time.Duration

	// HTTPClient is an optional custom HTTP client.
	// If nil, a default client with the configured timeout is used.
	HTTPClient *http.Client
}

// withDefaults returns a copy of the config with default values applied
// for any fields that were left at their zero value.
func (c Config) withDefaults() Config {
	if c.BaseURL == "" {
		c.BaseURL = DefaultBaseURL
	}
	if c.ProxyHost == "" {
		c.ProxyHost = DefaultProxyHost
	}
	if c.HTTPProxyPort == 0 {
		c.HTTPProxyPort = DefaultHTTPProxyPort
	}
	if c.SOCKS5ProxyPort == 0 {
		c.SOCKS5ProxyPort = DefaultSOCKS5ProxyPort
	}
	if c.Timeout == 0 {
		c.Timeout = 30 * time.Second
	}
	return c
}
