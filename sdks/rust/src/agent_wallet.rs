use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::errors::Result;
use crate::http_client::{encode_uri_component, HttpClient};

#[derive(Debug, Deserialize)]
pub struct AgenticWallet {
    pub id: String,
    pub label: String,
    #[serde(rename = "balanceCents")]
    pub balance_cents: i64,
    #[serde(rename = "spendingLimitCents")]
    pub spending_limit_cents: i64,
    pub status: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct AgenticWalletTransaction {
    pub id: String,
    #[serde(rename = "walletId")]
    pub wallet_id: String,
    #[serde(rename = "type")]
    pub tx_type: String,
    #[serde(rename = "amountCents")]
    pub amount_cents: i64,
    pub description: String,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct AgenticWalletListResponse {
    pub wallets: Vec<AgenticWallet>,
}

#[derive(Debug, Deserialize)]
pub struct AgenticWalletFundResponse {
    pub transaction: AgenticWalletTransaction,
}

#[derive(Debug, Deserialize)]
pub struct AgenticWalletTransactionsResponse {
    pub transactions: Vec<AgenticWalletTransaction>,
}

#[derive(Debug, Deserialize)]
pub struct AgenticWalletDeleteResponse {
    pub deleted: bool,
    #[serde(rename = "refundedCents")]
    pub refunded_cents: i64,
}

#[derive(Serialize)]
struct CreateBody<'a> {
    label: &'a str,
    #[serde(rename = "spendingLimitCents")]
    spending_limit_cents: i64,
}

#[derive(Serialize)]
struct FundBody {
    #[serde(rename = "amountCents")]
    amount_cents: i64,
}

/// Agentic wallet operations — server-side custodial sub-wallets with spending limits.
pub struct AgenticWalletResource {
    http: Arc<HttpClient>,
}

impl AgenticWalletResource {
    pub(crate) fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// Create a new agentic wallet.
    pub async fn create(&self, label: &str, spending_limit_cents: i64) -> Result<AgenticWallet> {
        self.http
            .post(
                "/api/agent-wallet",
                Some(&CreateBody { label, spending_limit_cents }),
                true,
            )
            .await
    }

    /// List all agentic wallets.
    pub async fn list(&self) -> Result<AgenticWalletListResponse> {
        self.http.get("/api/agent-wallet", true).await
    }

    /// Get a single agentic wallet by ID.
    pub async fn get(&self, wallet_id: &str) -> Result<AgenticWallet> {
        self.http
            .get(&format!("/api/agent-wallet/{}", encode_uri_component(wallet_id)), true)
            .await
    }

    /// Fund an agentic wallet from the main wallet.
    pub async fn fund(&self, wallet_id: &str, amount_cents: i64) -> Result<AgenticWalletFundResponse> {
        self.http
            .post(
                &format!("/api/agent-wallet/{}/fund", encode_uri_component(wallet_id)),
                Some(&FundBody { amount_cents }),
                true,
            )
            .await
    }

    /// Get transaction history for an agentic wallet.
    pub async fn transactions(
        &self,
        wallet_id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<AgenticWalletTransactionsResponse> {
        self.http
            .get(
                &format!(
                    "/api/agent-wallet/{}/transactions?limit={}&offset={}",
                    encode_uri_component(wallet_id), limit, offset
                ),
                true,
            )
            .await
    }

    /// Freeze an agentic wallet.
    pub async fn freeze(&self, wallet_id: &str) -> Result<AgenticWallet> {
        let empty: Option<&()> = None;
        self.http
            .post(
                &format!("/api/agent-wallet/{}/freeze", encode_uri_component(wallet_id)),
                empty,
                true,
            )
            .await
    }

    /// Unfreeze an agentic wallet.
    pub async fn unfreeze(&self, wallet_id: &str) -> Result<AgenticWallet> {
        let empty: Option<&()> = None;
        self.http
            .post(
                &format!("/api/agent-wallet/{}/unfreeze", encode_uri_component(wallet_id)),
                empty,
                true,
            )
            .await
    }

    /// Delete an agentic wallet and refund remaining balance.
    pub async fn delete(&self, wallet_id: &str) -> Result<AgenticWalletDeleteResponse> {
        self.http
            .delete(&format!("/api/agent-wallet/{}", encode_uri_component(wallet_id)))
            .await
    }
}
