package tests

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	dominode "github.com/dominode/dominode-go"
)

func TestWallet_GetBalance(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/wallet" || r.Method != "GET" {
			w.WriteHeader(404)
			return
		}
		resp := map[string]interface{}{
			"balanceCents": 5000,
			"balanceUsd":   50.00,
			"currency":     "USD",
			"lastToppedUp": "2025-01-15T10:30:00Z",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	wallet, err := client.Wallet.GetBalance(ctx)
	if err != nil {
		t.Fatalf("GetBalance failed: %v", err)
	}
	if wallet.BalanceCents != 5000 {
		t.Errorf("expected 5000 cents, got %d", wallet.BalanceCents)
	}
	if wallet.BalanceUSD != 50.00 {
		t.Errorf("expected $50.00, got %f", wallet.BalanceUSD)
	}
	if wallet.Currency != "USD" {
		t.Errorf("expected USD, got %s", wallet.Currency)
	}
}

func TestWallet_GetTransactions(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/wallet/transactions" || r.Method != "GET" {
			w.WriteHeader(404)
			return
		}
		// Verify query params
		if r.URL.Query().Get("limit") != "10" {
			t.Errorf("expected limit=10, got %s", r.URL.Query().Get("limit"))
		}
		if r.URL.Query().Get("offset") != "0" {
			t.Errorf("expected offset=0, got %s", r.URL.Query().Get("offset"))
		}

		resp := map[string]interface{}{
			"transactions": []interface{}{
				map[string]interface{}{
					"id": "tx-1", "type": "topup", "amountCents": 2000, "amountUsd": 20.00,
					"description": "Stripe top-up", "paymentProvider": "stripe", "createdAt": "2025-01-15T10:30:00Z",
				},
				map[string]interface{}{
					"id": "tx-2", "type": "debit", "amountCents": -50, "amountUsd": -0.50,
					"description": "Proxy usage", "paymentProvider": nil, "createdAt": "2025-01-15T11:00:00Z",
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	limit := 10
	offset := 0
	txns, err := client.Wallet.GetTransactions(ctx, &dominode.TransactionOptions{
		Limit:  &limit,
		Offset: &offset,
	})
	if err != nil {
		t.Fatalf("GetTransactions failed: %v", err)
	}
	if len(txns) != 2 {
		t.Fatalf("expected 2 transactions, got %d", len(txns))
	}
	if txns[0].Type != "topup" {
		t.Errorf("expected topup type, got %s", txns[0].Type)
	}
	if txns[1].AmountCents != -50 {
		t.Errorf("expected -50 cents, got %d", txns[1].AmountCents)
	}
}

func TestWallet_GetTransactions_NilOpts(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/wallet/transactions" {
			w.WriteHeader(404)
			return
		}
		resp := map[string]interface{}{"transactions": []interface{}{}}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	txns, err := client.Wallet.GetTransactions(ctx, nil)
	if err != nil {
		t.Fatalf("GetTransactions with nil opts failed: %v", err)
	}
	if txns == nil {
		t.Error("expected empty slice, not nil")
	}
}

func TestWallet_TopupStripe(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/wallet/topup/stripe" || r.Method != "POST" {
			w.WriteHeader(404)
			return
		}

		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["amountCents"] != float64(2000) {
			t.Errorf("expected amountCents 2000, got %v", body["amountCents"])
		}

		resp := map[string]interface{}{
			"sessionId": "cs_test_123",
			"url":       "https://checkout.stripe.com/pay/cs_test_123",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	checkout, err := client.Wallet.TopupStripe(ctx, 2000)
	if err != nil {
		t.Fatalf("TopupStripe failed: %v", err)
	}
	if checkout.SessionID != "cs_test_123" {
		t.Errorf("unexpected session ID: %s", checkout.SessionID)
	}
	if checkout.URL != "https://checkout.stripe.com/pay/cs_test_123" {
		t.Errorf("unexpected URL: %s", checkout.URL)
	}
}

func TestWallet_TopupCrypto(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/wallet/topup/crypto" || r.Method != "POST" {
			w.WriteHeader(404)
			return
		}

		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["amountUsd"] != float64(25.0) {
			t.Errorf("expected amountUsd 25, got %v", body["amountUsd"])
		}
		if body["currency"] != "btc" {
			t.Errorf("expected btc, got %v", body["currency"])
		}

		resp := map[string]interface{}{
			"invoiceId":   "inv_123",
			"invoiceUrl":  "https://nowpayments.io/payment/inv_123",
			"payCurrency": "btc",
			"priceAmount": 0.0004,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	invoice, err := client.Wallet.TopupCrypto(ctx, 25.0, "btc")
	if err != nil {
		t.Fatalf("TopupCrypto failed: %v", err)
	}
	if invoice.InvoiceID != "inv_123" {
		t.Errorf("unexpected invoice ID: %s", invoice.InvoiceID)
	}
	if invoice.PayCurrency != "btc" {
		t.Errorf("expected btc, got %s", invoice.PayCurrency)
	}
}

func TestWallet_GetForecast(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/wallet/forecast" {
			w.WriteHeader(404)
			return
		}
		resp := map[string]interface{}{
			"dailyAvgCents": 150,
			"daysRemaining": 33.3,
			"trend":         "down",
			"trendPct":      -5.2,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	defer server.Close()

	ctx := context.Background()
	forecast, err := client.Wallet.GetForecast(ctx)
	if err != nil {
		t.Fatalf("GetForecast failed: %v", err)
	}
	if forecast.DailyAvgCents != 150 {
		t.Errorf("expected 150, got %d", forecast.DailyAvgCents)
	}
	if forecast.Trend != "down" {
		t.Errorf("expected down, got %s", forecast.Trend)
	}
}

func TestWallet_InsufficientBalance(t *testing.T) {
	client, server := setupAuthenticatedClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(402)
		w.Write([]byte(`{"error":"Insufficient balance"}`))
	})
	defer server.Close()

	ctx := context.Background()
	_, err := client.Wallet.TopupStripe(ctx, 100)
	if err == nil {
		t.Fatal("expected error for insufficient balance")
	}
	var balanceErr *dominode.InsufficientBalanceError
	if !errors.As(err, &balanceErr) {
		t.Fatalf("expected InsufficientBalanceError, got %T: %v", err, err)
	}
}
