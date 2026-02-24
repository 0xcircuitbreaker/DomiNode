use std::sync::Arc;

use serde::Deserialize;

use crate::errors::Result;
use crate::http_client::HttpClient;

/// A facilitator for x402 payments.
#[derive(Debug, Clone, Deserialize)]
pub struct X402Facilitator {
    pub address: String,
    pub chain: String,
    pub network: String,
}

/// Pricing information for x402 payments.
#[derive(Debug, Clone, Deserialize)]
pub struct X402Pricing {
    #[serde(rename = "perRequestCents")]
    pub per_request_cents: i64,
    #[serde(rename = "perGbCents")]
    pub per_gb_cents: i64,
    pub currency: String,
}

/// x402 protocol information response.
#[derive(Debug, Clone, Deserialize)]
pub struct X402Info {
    pub supported: bool,
    pub enabled: bool,
    pub protocol: String,
    pub version: String,
    pub facilitators: Vec<X402Facilitator>,
    pub pricing: X402Pricing,
    pub currencies: Vec<String>,
    #[serde(rename = "walletType")]
    pub wallet_type: String,
    #[serde(rename = "agenticWallets")]
    pub agentic_wallets: bool,
}

/// x402 (HTTP 402 Payment Required) protocol information resource.
///
/// Provides details about x402 micropayment support, facilitator addresses,
/// pricing, and supported chains/currencies for AI agent payments.
pub struct X402Resource {
    http: Arc<HttpClient>,
}

impl X402Resource {
    pub(crate) fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// Get x402 protocol information including facilitator details,
    /// pricing, supported chains, and currencies.
    ///
    /// This endpoint does not require authentication.
    pub async fn get_info(&self) -> Result<X402Info> {
        self.http.get("/api/x402/info", false).await
    }
}
