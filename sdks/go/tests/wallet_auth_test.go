package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	dominusnode "github.com/dominusnode/dominusnode-go"
)

func TestWalletAuth_Challenge(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/wallet/challenge" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Fatalf("unexpected method: %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"challenge": "Sign this message: abc123",
			"expiresAt": "2026-03-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{
		BaseURL: server.URL,
	})

	result, err := client.WalletAuth.Challenge(context.Background(), "0x1234567890abcdef1234567890abcdef12345678")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Challenge != "Sign this message: abc123" {
		t.Errorf("unexpected challenge: %s", result.Challenge)
	}
	if result.ExpiresAt != "2026-03-01T00:00:00Z" {
		t.Errorf("unexpected expiresAt: %s", result.ExpiresAt)
	}
}

func TestWalletAuth_Challenge_InvalidAddress(t *testing.T) {
	client := dominusnode.NewClient(dominusnode.Config{})

	_, err := client.WalletAuth.Challenge(context.Background(), "bad-address")
	if err == nil {
		t.Fatal("expected error for invalid address")
	}
}

func TestWalletAuth_Challenge_EmptyAddress(t *testing.T) {
	client := dominusnode.NewClient(dominusnode.Config{})

	_, err := client.WalletAuth.Challenge(context.Background(), "")
	if err == nil {
		t.Fatal("expected error for empty address")
	}
}

func TestWalletAuth_Verify(t *testing.T) {
	exp := time.Now().Add(15 * time.Minute).Unix()
	token := newTestJWT(exp)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/wallet/verify" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"token":        token,
			"refreshToken": "refresh-tok",
			"user": map[string]interface{}{
				"id":       "u1",
				"email":    "wallet@example.com",
				"is_admin": false,
			},
		})
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{
		BaseURL: server.URL,
	})

	result, err := client.WalletAuth.Verify(
		context.Background(),
		"0x1234567890abcdef1234567890abcdef12345678",
		"0xsignature",
		"challenge-str",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.User.ID != "u1" {
		t.Errorf("unexpected user id: %s", result.User.ID)
	}
}

func TestWalletAuth_Verify_EmptySignature(t *testing.T) {
	client := dominusnode.NewClient(dominusnode.Config{})

	_, err := client.WalletAuth.Verify(
		context.Background(),
		"0x1234567890abcdef1234567890abcdef12345678",
		"",
		"challenge-str",
	)
	if err == nil {
		t.Fatal("expected error for empty signature")
	}
}

func TestWalletAuth_VerifyResult_Redaction(t *testing.T) {
	result := dominusnode.WalletVerifyResult{
		Token:        "secret-token",
		RefreshToken: "secret-refresh",
	}
	str := result.String()
	if str == "" {
		t.Fatal("expected non-empty string")
	}
	if contains(str, "secret-token") || contains(str, "secret-refresh") {
		t.Error("expected tokens to be redacted")
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && searchSubstring(s, substr))
}

func searchSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
