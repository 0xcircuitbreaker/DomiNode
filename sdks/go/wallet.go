package dominusnode

import (
	"context"
	"fmt"
	"math"
)

// validateAmountCents validates that a financial amount is a positive integer within PostgreSQL int4 range.
func validateAmountCents(amountCents int) error {
	if amountCents <= 0 || amountCents > 2_147_483_647 {
		return fmt.Errorf("amountCents must be a positive integer <= 2,147,483,647")
	}
	return nil
}

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
	if err := validateAmountCents(amountCents); err != nil {
		return nil, err
	}
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
	if math.IsNaN(amountUSD) || math.IsInf(amountUSD, 0) {
		return nil, fmt.Errorf("amountUSD must be a finite number")
	}
	if amountUSD <= 0 || amountUSD > 21474836.47 {
		return nil, fmt.Errorf("amountUSD must be positive and <= 21,474,836.47")
	}
	if amountUSD < 10 {
		return nil, fmt.Errorf("minimum crypto top-up is $10.00")
	}
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

// TopupPaypal creates a PayPal order for wallet top-up.
// amountCents is the amount in cents (e.g., 1000 = $10.00). Minimum is $5.00 (500 cents).
func (w *WalletResource) TopupPaypal(ctx context.Context, amountCents int) (*PaypalOrder, error) {
	if err := validateAmountCents(amountCents); err != nil {
		return nil, err
	}
	if amountCents < 500 {
		return nil, fmt.Errorf("minimum PayPal top-up is $5.00 (500 cents)")
	}
	body := map[string]int{"amountCents": amountCents}
	var result PaypalOrder
	if err := w.http.post(ctx, "/api/wallet/topup/paypal", body, &result); err != nil {
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
