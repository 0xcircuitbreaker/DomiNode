package tests

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	dominode "github.com/dominode/dominode-go"
)

func TestKeys_Create(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/keys" || r.Method != "POST" {
			w.WriteHeader(404)
			return
		}

		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["label"] != "My Key" {
			t.Errorf("unexpected label: %s", body["label"])
		}

		resp := map[string]interface{}{
			"key":        "dn_live_new_key_123",
			"id":         "key-1",
			"prefix":     "dn_live_new",
			"label":      "My Key",
			"created_at": "2025-01-01T00:00:00Z",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	key, err := client.Keys.Create(ctx, "My Key")
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if key.Key != "dn_live_new_key_123" {
		t.Errorf("unexpected key: %s", key.Key)
	}
	if key.ID != "key-1" {
		t.Errorf("unexpected ID: %s", key.ID)
	}
	if key.Label != "My Key" {
		t.Errorf("unexpected label: %s", key.Label)
	}

	// Test credential redaction
	str := key.String()
	if strings.Contains(str, "dn_live_new_key_123") {
		t.Error("String() should redact the raw key")
	}
	if !strings.Contains(str, "<redacted>") {
		t.Error("String() should contain <redacted>")
	}
}

func TestKeys_Create_DefaultLabel(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["label"] != "Default" {
			t.Errorf("expected Default label, got: %s", body["label"])
		}

		resp := map[string]interface{}{
			"key": "dn_live_x", "id": "k1", "prefix": "dn_live", "label": "Default", "created_at": "2025-01-01T00:00:00Z",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	_, err := client.Keys.Create(ctx, "")
	if err != nil {
		t.Fatalf("Create with empty label failed: %v", err)
	}
}

func TestKeys_List(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/keys" || r.Method != "GET" {
			w.WriteHeader(404)
			return
		}

		resp := map[string]interface{}{
			"keys": []interface{}{
				map[string]interface{}{
					"id": "key-1", "prefix": "dn_live_abc", "label": "Key 1",
					"created_at": "2025-01-01T00:00:00Z", "revoked_at": nil,
				},
				map[string]interface{}{
					"id": "key-2", "prefix": "dn_live_def", "label": "Key 2",
					"created_at": "2025-01-02T00:00:00Z", "revoked_at": "2025-01-03T00:00:00Z",
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	keys, err := client.Keys.List(ctx)
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(keys) != 2 {
		t.Fatalf("expected 2 keys, got %d", len(keys))
	}
	if keys[0].ID != "key-1" {
		t.Errorf("expected key-1, got %s", keys[0].ID)
	}
	if keys[1].RevokedAt == nil {
		t.Error("expected key-2 to have revoked_at")
	}
}

func TestKeys_Revoke(t *testing.T) {
	revokeCalled := false
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" || !strings.HasPrefix(r.URL.Path, "/api/keys/") {
			w.WriteHeader(404)
			return
		}
		revokeCalled = true
		keyID := strings.TrimPrefix(r.URL.Path, "/api/keys/")
		if keyID != "key-to-revoke" {
			t.Errorf("unexpected key ID: %s", keyID)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"message":"Key revoked"}`))
	})
	defer server.Close()

	ctx := context.Background()
	err := client.Keys.Revoke(ctx, "key-to-revoke")
	if err != nil {
		t.Fatalf("Revoke failed: %v", err)
	}
	if !revokeCalled {
		t.Error("expected revoke endpoint to be called")
	}
}

func TestKeys_Revoke_NotFound(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		w.Write([]byte(`{"error":"Key not found"}`))
	})
	defer server.Close()

	ctx := context.Background()
	err := client.Keys.Revoke(ctx, "nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent key")
	}
	var notFound *dominode.NotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("expected NotFoundError, got %T: %v", err, err)
	}
}

func TestKeys_UserAgentHeader(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		ua := r.Header.Get("User-Agent")
		if ua != dominode.UserAgent {
			t.Errorf("expected User-Agent %s, got %s", dominode.UserAgent, ua)
		}
		resp := map[string]interface{}{"keys": []interface{}{}}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	_, _ = client.Keys.List(ctx)
}
