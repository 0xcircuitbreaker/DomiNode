package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	dominusnode "github.com/dominusnode/dominusnode-go"
)

// newTestJWT creates a fake JWT token with a given expiry timestamp.
// The token has a valid 3-part structure with a base64-encoded payload.
func newTestJWT(exp int64) string {
	// Header: {"alg":"HS256","typ":"JWT"}
	header := "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
	// Build payload
	payload := map[string]interface{}{"exp": exp, "sub": "test-user-id"}
	payloadBytes, _ := json.Marshal(payload)
	// Base64url encode
	encoded := base64URLEncode(payloadBytes)
	return header + "." + encoded + ".fakesignature"
}

func base64URLEncode(data []byte) string {
	const encodeStd = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	const encodeURL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	encoded := make([]byte, 0, ((len(data)+2)/3)*4)
	for i := 0; i < len(data); i += 3 {
		var b0, b1, b2 byte
		b0 = data[i]
		if i+1 < len(data) {
			b1 = data[i+1]
		}
		if i+2 < len(data) {
			b2 = data[i+2]
		}
		encoded = append(encoded, encodeURL[b0>>2])
		encoded = append(encoded, encodeURL[((b0&0x03)<<4)|(b1>>4)])
		if i+1 < len(data) {
			encoded = append(encoded, encodeURL[((b1&0x0f)<<2)|(b2>>6)])
		}
		if i+2 < len(data) {
			encoded = append(encoded, encodeURL[b2&0x3f])
		}
	}
	return string(encoded)
}

func TestNewClient_Defaults(t *testing.T) {
	client := dominusnode.NewClient(dominusnode.Config{})
	if client.Auth == nil {
		t.Fatal("Auth resource should not be nil")
	}
	if client.Keys == nil {
		t.Fatal("Keys resource should not be nil")
	}
	if client.Wallet == nil {
		t.Fatal("Wallet resource should not be nil")
	}
	if client.Usage == nil {
		t.Fatal("Usage resource should not be nil")
	}
	if client.Plans == nil {
		t.Fatal("Plans resource should not be nil")
	}
	if client.Sessions == nil {
		t.Fatal("Sessions resource should not be nil")
	}
	if client.Proxy == nil {
		t.Fatal("Proxy resource should not be nil")
	}
	if client.Admin == nil {
		t.Fatal("Admin resource should not be nil")
	}
}

func TestNewClient_CustomConfig(t *testing.T) {
	customClient := &http.Client{}
	client := dominusnode.NewClient(dominusnode.Config{
		BaseURL:         "http://custom.example.com",
		ProxyHost:       "custom-proxy.example.com",
		HTTPProxyPort:   9090,
		SOCKS5ProxyPort: 2080,
		HTTPClient:      customClient,
	})
	if client.Auth == nil {
		t.Fatal("Auth resource should not be nil with custom config")
	}
}

func TestConnectWithKey(t *testing.T) {
	futureExp := int64(9999999999) // far future
	token := newTestJWT(futureExp)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/verify-key" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}

		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["apiKey"] != "dn_live_testkey123" {
			t.Errorf("unexpected apiKey: %s", body["apiKey"])
		}

		resp := map[string]interface{}{
			"valid":        true,
			"token":        token,
			"refreshToken": "refresh_abc",
			"userId":       "user-1",
			"email":        "test@example.com",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{
		BaseURL: server.URL,
	})

	ctx := context.Background()
	err := client.ConnectWithKey(ctx, "dn_live_testkey123")
	if err != nil {
		t.Fatalf("ConnectWithKey failed: %v", err)
	}
}

func TestConnectWithCredentials(t *testing.T) {
	futureExp := int64(9999999999)
	token := newTestJWT(futureExp)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/login" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}

		resp := map[string]interface{}{
			"user":         map[string]interface{}{"id": "user-1", "email": "test@example.com", "is_admin": false},
			"token":        token,
			"refreshToken": "refresh_abc",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{
		BaseURL: server.URL,
	})

	ctx := context.Background()
	result, err := client.ConnectWithCredentials(ctx, "test@example.com", "password123")
	if err != nil {
		t.Fatalf("ConnectWithCredentials failed: %v", err)
	}
	if result.User == nil {
		t.Fatal("expected user in login result")
	}
	if result.User.Email != "test@example.com" {
		t.Errorf("expected email test@example.com, got %s", result.User.Email)
	}
}

func TestConnectWithCredentials_MFARequired(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/login" {
			resp := map[string]interface{}{
				"mfaRequired":       true,
				"mfaChallengeToken": "challenge_token_123",
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
			return
		}

		if r.URL.Path == "/api/auth/mfa/verify" {
			futureExp := int64(9999999999)
			token := newTestJWT(futureExp)
			resp := map[string]interface{}{
				"user":         map[string]interface{}{"id": "user-1", "email": "test@example.com", "is_admin": false},
				"token":        token,
				"refreshToken": "refresh_mfa",
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
			return
		}

		w.WriteHeader(404)
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{
		BaseURL: server.URL,
	})

	ctx := context.Background()
	result, err := client.ConnectWithCredentials(ctx, "test@example.com", "password123")
	if err != nil {
		t.Fatalf("ConnectWithCredentials failed: %v", err)
	}
	if !result.MFARequired {
		t.Fatal("expected MFARequired to be true")
	}

	err = client.CompleteMFA(ctx, "123456", dominusnode.WithMFAChallengeToken("challenge_token_123"))
	if err != nil {
		t.Fatalf("CompleteMFA failed: %v", err)
	}
}

func TestDisconnect(t *testing.T) {
	futureExp := int64(9999999999)
	token := newTestJWT(futureExp)
	logoutCalled := false

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/verify-key":
			resp := map[string]interface{}{
				"valid":        true,
				"token":        token,
				"refreshToken": "refresh_abc",
				"userId":       "user-1",
				"email":        "test@example.com",
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
		case "/api/auth/logout":
			logoutCalled = true
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{
		BaseURL: server.URL,
	})

	ctx := context.Background()
	err := client.ConnectWithKey(ctx, "dn_live_testkey123")
	if err != nil {
		t.Fatalf("ConnectWithKey failed: %v", err)
	}

	client.Disconnect()
	if !logoutCalled {
		t.Error("expected server-side logout to be called")
	}
}

func TestSDKConstants(t *testing.T) {
	if dominusnode.SDKVersion != "1.0.0" {
		t.Errorf("unexpected SDK version: %s", dominusnode.SDKVersion)
	}
	if dominusnode.UserAgent != "dominusnode-sdk-go/1.0.0" {
		t.Errorf("unexpected user agent: %s", dominusnode.UserAgent)
	}
	if dominusnode.DefaultBaseURL != "https://api.dominusnode.io" {
		t.Errorf("unexpected default base URL: %s", dominusnode.DefaultBaseURL)
	}
	if dominusnode.DefaultHTTPProxyPort != 8080 {
		t.Errorf("unexpected default HTTP proxy port: %d", dominusnode.DefaultHTTPProxyPort)
	}
	if dominusnode.DefaultSOCKS5ProxyPort != 1080 {
		t.Errorf("unexpected default SOCKS5 proxy port: %d", dominusnode.DefaultSOCKS5ProxyPort)
	}
}
