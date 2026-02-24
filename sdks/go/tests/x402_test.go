package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	dominusnode "github.com/dominusnode/dominusnode-go"
)

func TestX402_GetInfo(t *testing.T) {
	mockInfo := map[string]interface{}{
		"supported": true,
		"enabled":   true,
		"protocol":  "x402",
		"version":   "1.0",
		"facilitators": []map[string]string{
			{"address": "0xabc", "chain": "base", "network": "mainnet"},
		},
		"pricing": map[string]interface{}{
			"perRequestCents": 1,
			"perGbCents":      300,
			"currency":        "USDC",
		},
		"currencies":     []string{"USDC", "USDT"},
		"walletType":     "evm",
		"agenticWallets": true,
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/x402/info" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Fatalf("unexpected method: %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(mockInfo)
	}))
	defer server.Close()

	client := dominusnode.NewClient(dominusnode.Config{
		BaseURL: server.URL,
	})

	info, err := client.X402.GetInfo(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !info.Supported {
		t.Error("expected supported to be true")
	}
	if !info.Enabled {
		t.Error("expected enabled to be true")
	}
	if info.Protocol != "x402" {
		t.Errorf("expected protocol 'x402', got '%s'", info.Protocol)
	}
	if len(info.Facilitators) != 1 {
		t.Errorf("expected 1 facilitator, got %d", len(info.Facilitators))
	}
	if info.Pricing.PerGbCents != 300 {
		t.Errorf("expected perGbCents 300, got %d", info.Pricing.PerGbCents)
	}
}
