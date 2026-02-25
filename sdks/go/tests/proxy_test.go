package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	dominusnode "github.com/dominusnode/dominusnode-go"
)

func setupAuthenticatedClient(t *testing.T, handler http.HandlerFunc) (*dominusnode.Client, *httptest.Server) {
	t.Helper()
	futureExp := int64(9999999999)
	token := newTestJWT(futureExp)

	wrappedHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/verify-key" {
			resp := map[string]interface{}{
				"valid": true, "token": token, "refreshToken": "refresh", "userId": "u1", "email": "e@x.com",
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
			return
		}
		handler(w, r)
	})

	server := httptest.NewServer(wrappedHandler)
	client := dominusnode.NewClient(dominusnode.Config{
		BaseURL:   server.URL,
		ProxyHost: "proxy.test.io",
	})
	_ = client.ConnectWithKey(context.Background(), "dn_live_testkey123")
	return client, server
}

func TestProxy_BuildURL_Default(t *testing.T) {
	client, server := setupAuthenticatedClient(t, nil)
	defer server.Close()

	url, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{})
	if err != nil {
		t.Fatalf("BuildURL failed: %v", err)
	}
	if !strings.HasPrefix(url, "http://user:") {
		t.Errorf("expected http prefix with user username, got %s", url)
	}
	if !strings.Contains(url, "proxy.test.io:8080") {
		t.Errorf("expected proxy.test.io:8080, got %s", url)
	}
	if !strings.Contains(url, "dn_live_testkey123") {
		t.Errorf("expected API key in URL, got %s", url)
	}
}

func TestProxy_BuildURL_SOCKS5(t *testing.T) {
	client, server := setupAuthenticatedClient(t, nil)
	defer server.Close()

	url, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{
		Protocol: "socks5",
	})
	if err != nil {
		t.Fatalf("BuildURL failed: %v", err)
	}
	if !strings.HasPrefix(url, "socks5://") {
		t.Errorf("expected socks5 prefix, got %s", url)
	}
	if !strings.Contains(url, ":1080") {
		t.Errorf("expected port 1080, got %s", url)
	}
}

func TestProxy_BuildURL_GeoTargeting(t *testing.T) {
	client, server := setupAuthenticatedClient(t, nil)
	defer server.Close()

	url, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{
		Country:   "US",
		State:     "CA",
		City:      "Los Angeles",
		ASN:       12345,
		SessionID: "sticky-1",
	})
	if err != nil {
		t.Fatalf("BuildURL failed: %v", err)
	}
	if !strings.Contains(url, "country-US") {
		t.Errorf("expected country-US in URL, got %s", url)
	}
	if !strings.Contains(url, "state-CA") {
		t.Errorf("expected state-CA in URL, got %s", url)
	}
	if !strings.Contains(url, "city-Los") {
		t.Errorf("expected city-Los%%20Angeles (URL encoded) in URL, got %s", url)
	}
	if !strings.Contains(url, "asn-12345") {
		t.Errorf("expected asn-12345 in URL, got %s", url)
	}
	if !strings.Contains(url, "session-sticky-1") {
		t.Errorf("expected session-sticky-1 in URL, got %s", url)
	}
}

func TestProxy_BuildURL_URLEncoding(t *testing.T) {
	client, server := setupAuthenticatedClient(t, nil)
	defer server.Close()

	// Test with special characters that need URL encoding
	url, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{
		Country: "US",
		City:    "New York",
	})
	if err != nil {
		t.Fatalf("BuildURL failed: %v", err)
	}
	// City should be URL-encoded
	if strings.Contains(url, " ") {
		t.Errorf("URL should not contain unencoded spaces: %s", url)
	}
	if !strings.Contains(url, "city-New") {
		t.Errorf("expected city in URL, got %s", url)
	}
}

func TestProxy_BuildURL_NoAPIKey(t *testing.T) {
	client := dominusnode.NewClient(dominusnode.Config{
		BaseURL: "http://localhost:3000",
	})

	_, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{})
	if err == nil {
		t.Fatal("expected error when no API key is set")
	}
}

func TestProxy_GetHealth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/proxy/health" {
			w.WriteHeader(404)
			return
		}
		resp := map[string]interface{}{
			"status":         "healthy",
			"activeSessions": 42,
			"uptimeSeconds":  3600,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{BaseURL: server.URL})
	ctx := context.Background()

	health, err := client.Proxy.GetHealth(ctx)
	if err != nil {
		t.Fatalf("GetHealth failed: %v", err)
	}
	if health.Status != "healthy" {
		t.Errorf("expected healthy status, got %s", health.Status)
	}
	if health.ActiveSessions != 42 {
		t.Errorf("expected 42 active sessions, got %d", health.ActiveSessions)
	}
}

func TestProxy_GetStatus(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/proxy/status" {
			w.WriteHeader(404)
			return
		}
		resp := map[string]interface{}{
			"status":             "healthy",
			"activeSessions":     10,
			"userActiveSessions": 2,
			"avgLatencyMs":       45.5,
			"providers": []interface{}{
				map[string]interface{}{
					"name":                "webshare-dc",
					"state":               "open",
					"consecutiveFailures": 0,
					"totalRequests":       1000,
					"totalErrors":         5,
					"avgLatencyMs":        45.5,
					"fallbackOnly":        false,
				},
			},
			"endpoints": map[string]interface{}{
				"http":   "proxy.test.io:8080",
				"socks5": "proxy.test.io:1080",
			},
			"supportedCountries": []string{"US", "GB", "DE"},
			"uptimeSeconds":      7200,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	status, err := client.Proxy.GetStatus(ctx)
	if err != nil {
		t.Fatalf("GetStatus failed: %v", err)
	}
	if status.Status != "healthy" {
		t.Errorf("expected healthy, got %s", status.Status)
	}
	if len(status.Providers) != 1 {
		t.Fatalf("expected 1 provider, got %d", len(status.Providers))
	}
	if status.Providers[0].Name != "webshare-dc" {
		t.Errorf("expected webshare-dc, got %s", status.Providers[0].Name)
	}
	if len(status.SupportedCountries) != 3 {
		t.Errorf("expected 3 supported countries, got %d", len(status.SupportedCountries))
	}
}

func TestProxy_CustomPorts(t *testing.T) {
	futureExp := int64(9999999999)
	token := newTestJWT(futureExp)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]interface{}{
			"valid": true, "token": token, "refreshToken": "refresh", "userId": "u1", "email": "e@x.com",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{
		BaseURL:         server.URL,
		ProxyHost:       "custom.proxy.io",
		HTTPProxyPort:   9999,
		SOCKS5ProxyPort: 2222,
	})
	_ = client.ConnectWithKey(context.Background(), "dn_live_test")

	httpURL, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{Protocol: "http"})
	if err != nil {
		t.Fatalf("BuildURL http failed: %v", err)
	}
	if !strings.Contains(httpURL, ":9999") {
		t.Errorf("expected port 9999, got %s", httpURL)
	}

	socks5URL, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{Protocol: "socks5"})
	if err != nil {
		t.Fatalf("BuildURL socks5 failed: %v", err)
	}
	if !strings.Contains(socks5URL, ":2222") {
		t.Errorf("expected port 2222, got %s", socks5URL)
	}
}
