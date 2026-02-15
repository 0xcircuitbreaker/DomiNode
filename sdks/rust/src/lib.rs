//! # Dominus Node SDK for Rust
//!
//! Official Rust client for the [Dominus Node](https://dominusnode.io) rotating
//! proxy-as-a-service platform.
//!
//! ## Quick Start
//!
//! ```no_run
//! use dominusnode::{DominusNodeClient, Config};
//!
//! # async fn example() -> dominusnode::Result<()> {
//! // Create a client with default settings.
//! let client = DominusNodeClient::new(Config::default())?;
//!
//! // Authenticate with an API key.
//! client.connect_with_key("dn_live_abc123").await?;
//!
//! // Check wallet balance.
//! let balance = client.wallet.get_balance().await?;
//! println!("Balance: {} cents", balance.balance_cents);
//!
//! // Build a proxy URL for HTTP clients.
//! let proxy_url = client.proxy.build_url("dn_live_abc123", None);
//! println!("Proxy URL: {}", proxy_url);
//! # Ok(())
//! # }
//! ```
//!
//! ## Features
//!
//! - **`async`** (default) -- Async API backed by Tokio.
//! - **`blocking`** -- Marker feature for future synchronous wrapper.

pub mod client;
pub mod types;
pub mod errors;
pub mod constants;
pub(crate) mod http_client;
pub(crate) mod token_manager;
pub mod auth;
pub mod keys;
pub mod wallet;
pub mod usage;
pub mod plans;
pub mod sessions;
pub mod proxy;
pub mod admin;

pub use client::{Config, DominusNodeClient};
pub use errors::{DominusNodeError, Result};
