package tests

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	dominusnode "github.com/dominusnode/dominusnode-go"
)

func TestUsage_Get(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/usage") || r.URL.Path != "/api/usage" {
			w.WriteHeader(404)
			return
		}

		// Check query params
		if r.URL.Query().Get("since") != "2025-01-01" {
			t.Errorf("expected since=2025-01-01, got %s", r.URL.Query().Get("since"))
		}
		if r.URL.Query().Get("until") != "2025-01-31" {
			t.Errorf("expected until=2025-01-31, got %s", r.URL.Query().Get("until"))
		}

		resp := map[string]interface{}{
			"summary": map[string]interface{}{
				"totalBytes": 1073741824, "totalCostCents": 700, "requestCount": 500,
				"totalGB": 1.0, "totalCostUsd": 7.0,
			},
			"records": []interface{}{
				map[string]interface{}{
					"id": "r1", "sessionId": "s1", "bytesIn": 500000, "bytesOut": 500000,
					"totalBytes": 1000000, "costCents": 1, "proxyType": "http",
					"targetHost": "example.com", "createdAt": "2025-01-15T10:00:00Z",
				},
			},
			"pagination": map[string]interface{}{"limit": 50, "offset": 0, "total": 1},
			"period":     map[string]interface{}{"since": "2025-01-01", "until": "2025-01-31"},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	usage, err := client.Usage.Get(ctx, &dominusnode.UsageOptions{
		From: "2025-01-01",
		To:   "2025-01-31",
	})
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if usage.Summary.TotalGB != 1.0 {
		t.Errorf("expected 1.0 GB, got %f", usage.Summary.TotalGB)
	}
	if usage.Summary.TotalCostCents != 700 {
		t.Errorf("expected 700 cents, got %d", usage.Summary.TotalCostCents)
	}
	if len(usage.Records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(usage.Records))
	}
	if usage.Records[0].TargetHost != "example.com" {
		t.Errorf("expected example.com, got %s", usage.Records[0].TargetHost)
	}
}

func TestUsage_Get_NilOpts(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]interface{}{
			"summary":    map[string]interface{}{"totalBytes": 0, "totalCostCents": 0, "requestCount": 0, "totalGB": 0, "totalCostUsd": 0},
			"records":    []interface{}{},
			"pagination": map[string]interface{}{"limit": 50, "offset": 0, "total": 0},
			"period":     map[string]interface{}{"since": "2025-01-01", "until": "2025-02-01"},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	usage, err := client.Usage.Get(ctx, nil)
	if err != nil {
		t.Fatalf("Get with nil opts failed: %v", err)
	}
	if usage.Records == nil {
		t.Error("expected empty slice, not nil")
	}
}

func TestUsage_GetDaily(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/usage/daily" {
			w.WriteHeader(404)
			return
		}
		resp := map[string]interface{}{
			"days": []interface{}{
				map[string]interface{}{
					"date": "2025-01-15", "totalBytes": 500000000, "totalGB": 0.5,
					"totalCostCents": 350, "totalCostUsd": 3.50, "requestCount": 200,
				},
				map[string]interface{}{
					"date": "2025-01-16", "totalBytes": 750000000, "totalGB": 0.75,
					"totalCostCents": 525, "totalCostUsd": 5.25, "requestCount": 300,
				},
			},
			"period": map[string]interface{}{"since": "2025-01-15", "until": "2025-01-17"},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	daily, err := client.Usage.GetDaily(ctx, &dominusnode.DateRangeOptions{
		From: "2025-01-15",
		To:   "2025-01-17",
	})
	if err != nil {
		t.Fatalf("GetDaily failed: %v", err)
	}
	if len(daily.Days) != 2 {
		t.Fatalf("expected 2 days, got %d", len(daily.Days))
	}
	if daily.Days[0].Date != "2025-01-15" {
		t.Errorf("expected 2025-01-15, got %s", daily.Days[0].Date)
	}
	if daily.Days[1].RequestCount != 300 {
		t.Errorf("expected 300 requests, got %d", daily.Days[1].RequestCount)
	}
}

func TestUsage_GetTopHosts(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/usage/top-hosts" {
			w.WriteHeader(404)
			return
		}
		resp := map[string]interface{}{
			"hosts": []interface{}{
				map[string]interface{}{
					"targetHost": "api.example.com", "totalBytes": 2000000000,
					"totalGB": 2.0, "requestCount": 1500,
				},
				map[string]interface{}{
					"targetHost": "cdn.example.com", "totalBytes": 500000000,
					"totalGB": 0.5, "requestCount": 300,
				},
			},
			"period": map[string]interface{}{"since": "2025-01-01", "until": "2025-02-01"},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	limit := 5
	topHosts, err := client.Usage.GetTopHosts(ctx, &dominusnode.TopHostsOptions{
		From:  "2025-01-01",
		To:    "2025-02-01",
		Limit: &limit,
	})
	if err != nil {
		t.Fatalf("GetTopHosts failed: %v", err)
	}
	if len(topHosts.Hosts) != 2 {
		t.Fatalf("expected 2 hosts, got %d", len(topHosts.Hosts))
	}
	if topHosts.Hosts[0].TargetHost != "api.example.com" {
		t.Errorf("expected api.example.com, got %s", topHosts.Hosts[0].TargetHost)
	}
	if topHosts.Hosts[0].TotalGB != 2.0 {
		t.Errorf("expected 2.0 GB, got %f", topHosts.Hosts[0].TotalGB)
	}
}

func TestUsage_ExportCSV(t *testing.T) {
	csvContent := "date,bytes_in,bytes_out,total_bytes,cost_cents\n2025-01-15,500,500,1000,1\n"

	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/usage/export" {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", "text/csv")
		w.Write([]byte(csvContent))
	})
	defer server.Close()

	ctx := context.Background()
	csv, err := client.Usage.ExportCSV(ctx, nil)
	if err != nil {
		t.Fatalf("ExportCSV failed: %v", err)
	}
	if csv != csvContent {
		t.Errorf("unexpected CSV content: %s", csv)
	}
}

func TestUsage_ServerError(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"Internal server error"}`))
	})
	defer server.Close()

	ctx := context.Background()
	_, err := client.Usage.Get(ctx, nil)
	if err == nil {
		t.Fatal("expected error for server error")
	}
	var serverErr *dominusnode.ServerError
	if !errors.As(err, &serverErr) {
		t.Fatalf("expected ServerError, got %T: %v", err, err)
	}
	if serverErr.StatusCode != 500 {
		t.Errorf("expected status 500, got %d", serverErr.StatusCode)
	}
}

func TestUsage_RateLimitError(t *testing.T) {
	attempts := 0
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts <= 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(429)
			w.Write([]byte(`{"error":"Rate limit exceeded"}`))
			return
		}
		// Second attempt succeeds
		resp := map[string]interface{}{
			"summary":    map[string]interface{}{"totalBytes": 0, "totalCostCents": 0, "requestCount": 0, "totalGB": 0, "totalCostUsd": 0},
			"records":    []interface{}{},
			"pagination": map[string]interface{}{"limit": 50, "offset": 0, "total": 0},
			"period":     map[string]interface{}{"since": "2025-01-01", "until": "2025-02-01"},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	usage, err := client.Usage.Get(ctx, nil)
	if err != nil {
		t.Fatalf("Get failed after rate limit retry: %v", err)
	}
	if attempts != 2 {
		t.Errorf("expected 2 attempts, got %d", attempts)
	}
	if usage == nil {
		t.Fatal("expected non-nil usage response")
	}
}
