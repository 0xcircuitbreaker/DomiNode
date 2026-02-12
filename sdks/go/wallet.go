package dominode

import (
	"context"
	"fmt"
)

// WalletResource provides wallet and payment operations.
type WalletResource struct {
	http *httpClient
}

// newWalletResource creates a new WalletResource.
func newWalletResource(http *httpClient) *WalletResource {
	return &WalletResource{http: http}
}

// GetBalance returns the current wallet balance.
func (w *WalletResource) GetBalance(ctx context.Context) (*Wallet, error) {
	var result Wallet
	if err := w.http.get(ctx, "/api/wallet", &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetTransactions returns the wallet transaction history.
// Use TransactionOptions to control pagination.
func (w *WalletResource) GetTransactions(ctx context.Context, opts *TransactionOptions) ([]WalletTransaction, error) {
	params := map[string]string{}
	if opts != nil {
		if opts.Limit != nil {
			params["limit"] = fmt.Sprintf("%d", *opts.Limit)
		}
		if opts.Offset != nil {
			params["offset"] = fmt.Sprintf("%d", *opts.Offset)
		}
	}

	path := "/api/wallet/transactions" + buildQueryString(params)
	var result TransactionsResponse
	if err := w.http.get(ctx, path, &result); err != nil {
		return nil, err
	}
	return result.Transactions, nil
}

// TopupStripe creates a Stripe checkout session for wallet top-up.
// amountCents is the amount in cents (e.g., 1000 = $10.00).
func (w *WalletResource) TopupStripe(ctx context.Context, amountCents int) (*StripeCheckout, error) {
	body := map[string]int{"amountCents": amountCents}
	var result StripeCheckout
	if err := w.http.post(ctx, "/api/wallet/topup/stripe", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// TopupCrypto creates a crypto payment invoice for wallet top-up.
// amountUSD is the amount in US dollars. currency is the crypto currency code
// (e.g., "btc", "eth", "xmr", "sol", "zec").
func (w *WalletResource) TopupCrypto(ctx context.Context, amountUSD float64, currency string) (*CryptoInvoice, error) {
	body := map[string]interface{}{
		"amountUsd": amountUSD,
		"currency":  currency,
	}
	var result CryptoInvoice
	if err := w.http.post(ctx, "/api/wallet/topup/crypto", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetForecast returns spending forecast data based on recent usage patterns.
func (w *WalletResource) GetForecast(ctx context.Context) (*WalletForecast, error) {
	var result WalletForecast
	if err := w.http.get(ctx, "/api/wallet/forecast", &result); err != nil {
		return nil, err
	}
	return &result, nil
}
