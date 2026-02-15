package tests

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	dominusnode "github.com/dominusnode/dominusnode-go"
)

func TestAuth_Register(t *testing.T) {
	futureExp := int64(9999999999)
	token := newTestJWT(futureExp)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/register" || r.Method != "POST" {
			w.WriteHeader(404)
			return
		}

		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["email"] != "new@example.com" || body["password"] != "securepass123" {
			t.Errorf("unexpected body: %v", body)
		}

		resp := map[string]interface{}{
			"user":         map[string]interface{}{"id": "user-new", "email": "new@example.com", "is_admin": false},
			"token":        token,
			"refreshToken": "refresh_new",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{BaseURL: server.URL})
	ctx := context.Background()

	result, err := client.Auth.Register(ctx, "new@example.com", "securepass123")
	if err != nil {
		t.Fatalf("Register failed: %v", err)
	}
	if result.User == nil || result.User.Email != "new@example.com" {
		t.Errorf("unexpected register result: %v", result)
	}
}

func TestAuth_Login_Success(t *testing.T) {
	futureExp := int64(9999999999)
	token := newTestJWT(futureExp)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]interface{}{
			"user":         map[string]interface{}{"id": "user-1", "email": "user@example.com", "is_admin": false},
			"token":        token,
			"refreshToken": "refresh_abc",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{BaseURL: server.URL})
	ctx := context.Background()

	result, err := client.Auth.Login(ctx, "user@example.com", "password")
	if err != nil {
		t.Fatalf("Login failed: %v", err)
	}
	if result.User == nil {
		t.Fatal("expected user in result")
	}
	if result.User.ID != "user-1" {
		t.Errorf("expected user ID user-1, got %s", result.User.ID)
	}
}

func TestAuth_Login_InvalidCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"Invalid credentials"}`))
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{BaseURL: server.URL})
	ctx := context.Background()

	_, err := client.Auth.Login(ctx, "bad@example.com", "wrong")
	if err == nil {
		t.Fatal("expected error for invalid credentials")
	}

	var authErr *dominusnode.AuthenticationError
	if !errors.As(err, &authErr) {
		t.Fatalf("expected AuthenticationError, got %T: %v", err, err)
	}
	if authErr.StatusCode != 401 {
		t.Errorf("expected status 401, got %d", authErr.StatusCode)
	}
}

func TestAuth_MFAFlow(t *testing.T) {
	futureExp := int64(9999999999)
	token := newTestJWT(futureExp)
	calls := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/login":
			resp := map[string]interface{}{
				"mfaRequired":       true,
				"mfaChallengeToken": "challenge_abc",
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)

		case "/api/auth/mfa/verify":
			calls++
			var body map[string]interface{}
			json.NewDecoder(r.Body).Decode(&body)
			if body["code"] != "654321" {
				t.Errorf("unexpected MFA code: %v", body["code"])
			}
			if body["mfaChallengeToken"] != "challenge_abc" {
				t.Errorf("unexpected challenge token: %v", body["mfaChallengeToken"])
			}

			resp := map[string]interface{}{
				"user":         map[string]interface{}{"id": "user-1", "email": "user@example.com", "is_admin": false},
				"token":        token,
				"refreshToken": "refresh_mfa",
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)

		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{BaseURL: server.URL})
	ctx := context.Background()

	result, err := client.Auth.Login(ctx, "user@example.com", "password")
	if err != nil {
		t.Fatalf("Login failed: %v", err)
	}
	if !result.MFARequired {
		t.Fatal("expected MFA required")
	}

	mfaResult, err := client.Auth.VerifyMFA(ctx, "654321", dominusnode.WithMFAChallengeToken("challenge_abc"))
	if err != nil {
		t.Fatalf("VerifyMFA failed: %v", err)
	}
	if mfaResult.User == nil {
		t.Fatal("expected user after MFA")
	}
	if calls != 1 {
		t.Errorf("expected 1 MFA verify call, got %d", calls)
	}
}

func TestAuth_Me(t *testing.T) {
	futureExp := int64(9999999999)
	token := newTestJWT(futureExp)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/verify-key" {
			resp := map[string]interface{}{
				"valid": true, "token": token, "refreshToken": "refresh", "userId": "u1", "email": "e@x.com",
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
			return
		}
		if r.URL.Path == "/api/auth/me" {
			// Check auth header
			auth := r.Header.Get("Authorization")
			if auth == "" {
				w.WriteHeader(401)
				w.Write([]byte(`{"error":"No auth"}`))
				return
			}
			resp := map[string]interface{}{
				"user": map[string]interface{}{"id": "user-1", "email": "user@example.com", "is_admin": true},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
			return
		}
		w.WriteHeader(404)
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{BaseURL: server.URL})
	ctx := context.Background()

	_ = client.ConnectWithKey(ctx, "dn_live_test")

	user, err := client.Auth.Me(ctx)
	if err != nil {
		t.Fatalf("Me failed: %v", err)
	}
	if user.Email != "user@example.com" {
		t.Errorf("expected user@example.com, got %s", user.Email)
	}
	if !user.IsAdmin {
		t.Error("expected IsAdmin to be true")
	}
}

func TestAuth_TokenRefreshOn401(t *testing.T) {
	futureExp := int64(9999999999)
	token := newTestJWT(futureExp)
	newToken := newTestJWT(futureExp)
	meAttempts := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/verify-key":
			resp := map[string]interface{}{
				"valid": true, "token": token, "refreshToken": "refresh_old", "userId": "u1", "email": "e@x.com",
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)

		case "/api/auth/refresh":
			resp := map[string]interface{}{
				"token":        newToken,
				"refreshToken": "refresh_new",
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)

		case "/api/auth/me":
			meAttempts++
			if meAttempts == 1 {
				// First attempt: return 401 to trigger refresh
				w.WriteHeader(401)
				w.Write([]byte(`{"error":"Token expired"}`))
				return
			}
			// Second attempt after refresh: succeed
			resp := map[string]interface{}{
				"user": map[string]interface{}{"id": "user-1", "email": "user@example.com", "is_admin": false},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)

		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{BaseURL: server.URL})
	ctx := context.Background()

	_ = client.ConnectWithKey(ctx, "dn_live_test")

	user, err := client.Auth.Me(ctx)
	if err != nil {
		t.Fatalf("Me failed after token refresh: %v", err)
	}
	if user.Email != "user@example.com" {
		t.Errorf("unexpected email: %s", user.Email)
	}
	if meAttempts != 2 {
		t.Errorf("expected 2 /me attempts, got %d", meAttempts)
	}
}

func TestAuth_MFASetupAndStatus(t *testing.T) {
	futureExp := int64(9999999999)
	token := newTestJWT(futureExp)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/verify-key":
			resp := map[string]interface{}{
				"valid": true, "token": token, "refreshToken": "refresh", "userId": "u1", "email": "e@x.com",
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)

		case "/api/auth/mfa/setup":
			resp := map[string]interface{}{
				"secret":      "JBSWY3DPEHPK3PXP",
				"otpauthUri":  "otpauth://totp/Dominus Node:user@example.com?secret=JBSWY3DPEHPK3PXP",
				"backupCodes": []string{"12345678", "87654321"},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)

		case "/api/auth/mfa/status":
			resp := map[string]interface{}{
				"enabled":              true,
				"backupCodesRemaining": 8,
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)

		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{BaseURL: server.URL})
	ctx := context.Background()
	_ = client.ConnectWithKey(ctx, "dn_live_test")

	setup, err := client.Auth.MFASetup(ctx)
	if err != nil {
		t.Fatalf("MFASetup failed: %v", err)
	}
	if setup.Secret != "JBSWY3DPEHPK3PXP" {
		t.Errorf("unexpected secret: %s", setup.Secret)
	}
	if len(setup.BackupCodes) != 2 {
		t.Errorf("expected 2 backup codes, got %d", len(setup.BackupCodes))
	}
	// Verify credential redaction
	str := setup.String()
	if str == "" || str == setup.Secret {
		t.Error("String() should redact sensitive fields")
	}

	status, err := client.Auth.MFAStatus(ctx)
	if err != nil {
		t.Fatalf("MFAStatus failed: %v", err)
	}
	if !status.Enabled {
		t.Error("expected MFA to be enabled")
	}
	if status.BackupCodesRemaining != 8 {
		t.Errorf("expected 8 backup codes remaining, got %d", status.BackupCodesRemaining)
	}
}
