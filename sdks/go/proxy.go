package dominusnode

import (
	"context"
	"fmt"
	"net/url"
	"strings"
)

// ProxyResource provides proxy URL building and proxy server status operations.
type ProxyResource struct {
	http       *httpClient
	proxyHost  string
	httpPort   int
	socks5Port int
	getAPIKey  func() string
}

// newProxyResource creates a new ProxyResource.
func newProxyResource(http *httpClient, proxyHost string, httpPort, socks5Port int, getAPIKey func() string) *ProxyResource {
	return &ProxyResource{
		http:       http,
		proxyHost:  proxyHost,
		httpPort:   httpPort,
		socks5Port: socks5Port,
		getAPIKey:  getAPIKey,
	}
}

// BuildURL constructs a proxy URL string for use with HTTP clients.
//
// The returned URL includes authentication via the username field.
// Geo-targeting and sticky sessions are encoded in the username portion
// following PacketStream conventions.
//
// Username format: user-country_XX-state_YY-city_ZZ-asn_N-session_S
//
// All user-controlled values are URL-encoded to prevent injection.
// The API key is URL-encoded in the password position.
//
// Protocol selects the port: "http" uses HTTPProxyPort, "socks5" uses SOCKS5ProxyPort.
//
// This method does not make any network calls.
//
// Example:
//
//	url, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{})
//	// => "http://user:dn_live_abc123@proxy.dominusnode.com:8080"
//
//	url, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{
//	    Protocol: "socks5",
//	    Country: "US",
//	    State: "CA",
//	})
//	// => "socks5://user-country_US-state_CA:dn_live_abc123@proxy.dominusnode.com:1080"
func (p *ProxyResource) BuildURL(opts ProxyURLOptions) (string, error) {
	apiKey := p.getAPIKey()
	if apiKey == "" {
		return "", &ProxyError{DominusNodeError{Message: "No API key set. Call ConnectWithKey first."}}
	}

	protocol := opts.Protocol
	if protocol == "" {
		protocol = "http"
	}

	port := p.httpPort
	if protocol == "socks5" {
		port = p.socks5Port
	}

	// Build username with geo-targeting parameters
	parts := []string{"user"}
	if opts.Country != "" {
		parts = append(parts, "country_"+url.QueryEscape(opts.Country))
	}
	if opts.State != "" {
		parts = append(parts, "state_"+url.QueryEscape(opts.State))
	}
	if opts.City != "" {
		parts = append(parts, "city_"+url.QueryEscape(opts.City))
	}
	if opts.ASN != 0 {
		parts = append(parts, fmt.Sprintf("asn_%d", opts.ASN))
	}
	if opts.SessionID != "" {
		parts = append(parts, "session_"+url.QueryEscape(opts.SessionID))
	}

	username := strings.Join(parts, "-")
	encodedKey := url.QueryEscape(apiKey)

	return fmt.Sprintf("%s://%s:%s@%s:%d", protocol, username, encodedKey, p.proxyHost, port), nil
}

// GetHealth returns the proxy server's public health status.
// This endpoint does not require authentication.
func (p *ProxyResource) GetHealth(ctx context.Context) (*ProxyHealth, error) {
	var result ProxyHealth
	if err := p.http.getPublic(ctx, "/api/proxy/health", &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetStatus returns detailed proxy status including provider information.
// Requires authentication.
func (p *ProxyResource) GetStatus(ctx context.Context) (*ProxyStatus, error) {
	var result ProxyStatus
	if err := p.http.get(ctx, "/api/proxy/status", &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetConfig returns the proxy server's configuration.
// Requires authentication.
func (p *ProxyResource) GetConfig(ctx context.Context) (*ProxyConfig, error) {
	var result ProxyConfig
	if err := p.http.get(ctx, "/api/proxy/config", &result); err != nil {
		return nil, err
	}
	return &result, nil
}
