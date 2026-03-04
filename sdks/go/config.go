// Package dominusnode provides a Go SDK for the Dominus Node rotating proxy-as-a-service API.
//
// Dominus Node is a proxy SaaS platform that provides rotating residential, datacenter,
// and mobile proxies. This SDK supports authentication (API key and JWT), wallet
// management, usage tracking, plan management, proxy URL building with geo-targeting,
// and admin operations.
//
// Quick start with API key:
//
//	client := dominusnode.NewClient(dominusnode.Config{
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
//	client := dominusnode.NewClient(dominusnode.Config{
//	    BaseURL: "http://localhost:3000",
//	})
//	result, err := client.ConnectWithCredentials(ctx, "user@example.com", "password123")
//	if err != nil {
//	    log.Fatal(err)
//	}
//	if result.MFARequired {
//	    err = client.CompleteMFA(ctx, "123456")
//	}
package dominusnode

import (
	"fmt"
	"net/http"
	"time"
)

// Config holds configuration options for the Dominus Node client.
type Config struct {
	// BaseURL is the base URL of the Dominus Node API server.
	// Defaults to DefaultBaseURL if empty.
	BaseURL string `json:"baseUrl,omitempty"`

	// APIKey is an API key for immediate authentication.
	// If set, the client will verify this key on first use.
	// json:"-" prevents accidental serialization of credentials.
	APIKey string `json:"-"`

	// Email is the user email for credential-based authentication.
	// json:"-" prevents accidental serialization of credentials.
	Email string `json:"-"`

	// Password is the user password for credential-based authentication.
	// json:"-" prevents accidental serialization of credentials.
	Password string `json:"-"`

	// AccessToken is a pre-existing JWT access token.
	// json:"-" prevents accidental serialization of credentials.
	AccessToken string `json:"-"`

	// RefreshToken is a pre-existing JWT refresh token.
	// json:"-" prevents accidental serialization of credentials.
	RefreshToken string `json:"-"`

	// ProxyHost is the hostname of the proxy server.
	// Defaults to DefaultProxyHost if empty.
	ProxyHost string `json:"proxyHost,omitempty"`

	// HTTPProxyPort is the HTTP proxy port.
	// Defaults to DefaultHTTPProxyPort if zero.
	HTTPProxyPort int `json:"httpProxyPort,omitempty"`

	// SOCKS5ProxyPort is the SOCKS5 proxy port.
	// Defaults to DefaultSOCKS5ProxyPort if zero.
	SOCKS5ProxyPort int `json:"socks5ProxyPort,omitempty"`

	// Timeout is the HTTP request timeout.
	// Defaults to 30 seconds if zero.
	Timeout time.Duration `json:"timeout,omitempty"`

	// AgentSecret is an optional secret for captcha bypass.
	// When set, injects X-DominusNode-Agent and X-DominusNode-Agent-Secret headers.
	// json:"-" prevents accidental serialization of credentials.
	AgentSecret string `json:"-"`

	// HTTPClient is an optional custom HTTP client.
	// If nil, a default client with the configured timeout is used.
	HTTPClient *http.Client `json:"-"`
}

// redact returns "<redacted>" if the string is non-empty, "<not set>" otherwise.
func redact(s string) string {
	if s == "" {
		return "<not set>"
	}
	return "<redacted>"
}

// String returns a safe representation of Config that redacts credentials.
// This prevents accidental credential leakage in log statements.
func (c Config) String() string {
	return fmt.Sprintf("Config{BaseURL:%q, APIKey:%s, Email:%s, Password:%s, AccessToken:%s, RefreshToken:%s, AgentSecret:%s, ProxyHost:%q, HTTPProxyPort:%d, SOCKS5ProxyPort:%d}",
		c.BaseURL, redact(c.APIKey), redact(c.Email), redact(c.Password),
		redact(c.AccessToken), redact(c.RefreshToken), redact(c.AgentSecret),
		c.ProxyHost, c.HTTPProxyPort, c.SOCKS5ProxyPort)
}

// GoString implements fmt.GoStringer to redact credentials in %#v format.
func (c Config) GoString() string {
	return c.String()
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
