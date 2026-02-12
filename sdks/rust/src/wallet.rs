use std::sync::Arc;

use serde::Serialize;

use crate::errors::Result;
use crate::http_client::HttpClient;
use crate::types::{
    CryptoInvoice, ForecastResponse, StripeCheckout, TransactionsResponse, WalletBalanceResponse,
};

#[derive(Serialize)]
struct StripeTopUpBody {
    #[serde(rename = "amountCents")]
    amount_cents: i64,
}

#[derive(Serialize)]
struct CryptoTopUpBody<'a> {
    #[serde(rename = "amountUsd")]
    amount_usd: f64,
    currency: &'a str,
}

/// Options for fetching transaction history.
#[derive(Debug, Default)]
pub struct TransactionOptions {
    pub limit: Option<u64>,
    pub offset: Option<u64>,
}

/// Wallet balance and transaction resource.
pub struct WalletResource {
    http: Arc<HttpClient>,
}

impl WalletResource {
    pub(crate) fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// Get the current wallet balance.
    pub async fn get_balance(&self) -> Result<WalletBalanceResponse> {
        self.http.get("/api/wallet", true).await
    }

    /// Get wallet transaction history with optional pagination.
    pub async fn get_transactions(
        &self,
        opts: Option<&TransactionOptions>,
    ) -> Result<TransactionsResponse> {
        let mut qs = String::new();
        if let Some(o) = opts {
            let mut parts: Vec<String> = Vec::new();
            if let Some(limit) = o.limit {
                parts.push(format!("limit={}", limit));
            }
            if let Some(offset) = o.offset {
                parts.push(format!("offset={}", offset));
            }
            if !parts.is_empty() {
                qs = format!("?{}", parts.join("&"));
            }
        }
        let path = format!("/api/wallet/transactions{}", qs);
        self.http.get(&path, true).await
    }

    /// Create a Stripe checkout session for topping up the wallet.
    ///
    /// Returns a checkout URL the user should be redirected to.
    pub async fn top_up_stripe(&self, amount_cents: i64) -> Result<StripeCheckout> {
        self.http
            .post(
                "/api/wallet/topup/stripe",
                Some(&StripeTopUpBody { amount_cents }),
                true,
            )
            .await
    }

    /// Create a crypto invoice for topping up the wallet.
    ///
    /// `amount_cents` is the USD amount in cents. `currency` is the crypto
    /// ticker symbol (e.g. `"BTC"`, `"ETH"`, `"XMR"`, `"SOL"`, `"ZEC"`).
    pub async fn top_up_crypto(
        &self,
        amount_cents: i64,
        currency: &str,
    ) -> Result<CryptoInvoice> {
        let amount_usd = amount_cents as f64 / 100.0;
        self.http
            .post(
                "/api/wallet/topup/crypto",
                Some(&CryptoTopUpBody {
                    amount_usd,
                    currency,
                }),
                true,
            )
            .await
    }

    /// Get a spending forecast based on recent usage patterns.
    pub async fn get_forecast(&self) -> Result<ForecastResponse> {
        self.http.get("/api/wallet/forecast", true).await
    }
}
