//! # Dominus Node SDK for Rust (v2)
//!
//! Relay-network client for AI agents, implementing `sdks/SDK_SURFACE.md`:
//! 15 resources, 71 methods, plus `connect_with_key` / `disconnect` / `is_connected`.
//!
//! ```no_run
//! use dominusnode::{Config, DominusNodeClient, ProxyFetchOptions};
//!
//! # async fn example() -> dominusnode::Result<()> {
//! let dn = DominusNodeClient::new(Config::default())?;
//! dn.connect_with_key(&std::env::var("DOMINUSNODE_API_KEY").unwrap()).await?;
//! let mut opts = ProxyFetchOptions::default();
//! opts.routing.country = Some("US".into());
//! let res = dn.proxy.fetch("https://example.com", opts).await?;
//! println!("{} {}", res.status, res.text().len());
//! # Ok(())
//! # }
//! ```

pub mod client;
pub mod errors;
pub mod http;
pub mod proxy;
pub mod resources;
pub mod ssrf;
pub mod token_manager;
pub mod transport;
pub mod types;
pub mod util;

pub use client::{Config, DominusNodeClient};
pub use errors::{scrub_credentials, DominusNodeError, ErrorInfo, Result};
pub use proxy::{FetchMethod, IpClass, ProxyFetchOptions, ProxyFetchResponse, ProxyProtocol, ProxyRoutingOptions};
pub use resources::RegisterNodeOptions;
pub use util::{FnSigner, Musd, Secret, Signer};
