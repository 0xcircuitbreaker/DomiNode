//! `DominusNodeClient`: 15 resources + `connect_with_key` / `disconnect` / `is_connected`.

use std::fmt;
use std::sync::{Arc, Weak};

use serde::{Serialize, Serializer};

use crate::errors::{DominusNodeError, Result};
use crate::http::{normalize_base_url, Credentials, HttpClient};
use crate::proxy::{validate_port, validate_proxy_host, GatewayTls, ProxyResource};
use crate::resources::*;
use crate::ssrf::{default_resolver, Resolver};
use crate::token_manager::{RefreshFn, TokenManager};
use crate::transport::{ReqwestTransport, Transport};
use crate::types::ConnectResult;
use crate::util::*;

/// Client configuration (SDK_SURFACE 1.1).
#[derive(Clone)]
pub struct Config {
    /// API base URL (http/https, no userinfo).
    pub base_url: String,
    /// Proxy gateway host.
    pub proxy_host: String,
    /// HTTP proxy port (1..65535).
    pub http_proxy_port: u32,
    /// SOCKS5 proxy port (1..65535).
    pub socks5_proxy_port: u32,
    /// Pre-existing access JWT.
    pub access_token: Option<String>,
    /// Pre-existing refresh JWT.
    pub refresh_token: Option<String>,
    /// Custom HTTP transport (must not follow redirects). Default: reqwest.
    pub transport: Option<Arc<dyn Transport>>,
    /// Custom DNS resolver for `proxy.fetch` (tests).
    pub resolver: Option<Resolver>,
    /// TLS to the gateway (`PROXY_TLS_PORT`); `build_url` then defaults to `https://`.
    /// Since 3.1 the default is `Some(GatewayTls::default())` (port 8443): production
    /// gateways refuse credentials on plaintext 8080/1080. Self-hosted coordinators
    /// use 8443 too. `None` selects plaintext (local dev only).
    pub gateway_tls: Option<GatewayTls>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            proxy_host: DEFAULT_PROXY_HOST.to_string(),
            http_proxy_port: DEFAULT_HTTP_PROXY_PORT,
            socks5_proxy_port: DEFAULT_SOCKS5_PROXY_PORT,
            access_token: None,
            refresh_token: None,
            transport: None,
            resolver: None,
            gateway_tls: Some(GatewayTls::default()),
        }
    }
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("base_url", &self.base_url)
            .field("proxy_host", &self.proxy_host)
            .field("http_proxy_port", &self.http_proxy_port)
            .field("socks5_proxy_port", &self.socks5_proxy_port)
            .field("access_token", &self.access_token.as_ref().map(|_| "[REDACTED]"))
            .field("refresh_token", &self.refresh_token.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

/// DominusNode relay-network client.
pub struct DominusNodeClient {
    /// Token plumbing (4).
    pub auth: AuthResource,
    /// Wallet sign-in (4).
    pub wallet_auth: WalletAuthResource,
    /// API keys (3).
    pub keys: KeysResource,
    /// Requester wallet (5).
    pub wallet: WalletResource,
    /// Agentic wallets (9).
    pub agentic_wallets: AgenticWalletResource,
    /// Teams (18).
    pub teams: TeamsResource,
    /// Usage (4).
    pub usage: UsageResource,
    /// Sessions (2).
    pub sessions: SessionsResource,
    /// x402 (1).
    pub x402: X402Resource,
    /// Network info (3).
    pub network: NetworkResource,
    /// Nodes (6).
    pub nodes: NodesResource,
    /// Credits (4).
    pub credits: CreditsResource,
    /// Payout wallet (2).
    pub payout_wallet: PayoutWalletResource,
    /// Payouts (1).
    pub payouts: PayoutsResource,
    /// Proxy (5).
    pub proxy: ProxyResource,
    creds: Arc<Credentials>,
    _http: Arc<HttpClient>,
}

impl DominusNodeClient {
    /// Build a client. Validates base URL, proxy host and ports.
    pub fn new(config: Config) -> Result<Self> {
        let base = normalize_base_url(&config.base_url)?;
        validate_proxy_host(&config.proxy_host)?;
        let http_port = validate_port(config.http_proxy_port, "httpProxyPort")?;
        let socks_port = validate_port(config.socks5_proxy_port, "socks5ProxyPort")?;
        let transport: Arc<dyn Transport> = match config.transport {
            Some(t) => t,
            None => Arc::new(ReqwestTransport::new().map_err(DominusNodeError::network)?),
        };
        let creds = Arc::new(Credentials::default());
        let http = Arc::new(HttpClient::new(base, creds.clone(), transport));

        let auth = AuthResource::new(http.clone());
        // Refresh callback; never removed (TokenManager::clear keeps it). Weak avoids a cycle.
        let weak: Weak<HttpClient> = Arc::downgrade(&http);
        let refresh: RefreshFn = Arc::new(move |rt: String| {
            let weak = weak.clone();
            Box::pin(async move {
                let http = weak.upgrade().ok_or_else(|| DominusNodeError::auth("client dropped"))?;
                let r = AuthResource::new(http).refresh(&rt).await?;
                Ok((r.token, r.refresh_token))
            })
        });
        creds.tokens.set_refresh_function(refresh);
        if let Some(a) = &config.access_token {
            creds.tokens.set_tokens(a, config.refresh_token.as_deref());
        }

        Ok(Self {
            auth,
            wallet_auth: WalletAuthResource::new(http.clone(), creds.clone()),
            keys: KeysResource::new(http.clone()),
            wallet: WalletResource::new(http.clone()),
            agentic_wallets: AgenticWalletResource::new(http.clone()),
            teams: TeamsResource::new(http.clone()),
            usage: UsageResource::new(http.clone()),
            sessions: SessionsResource::new(http.clone()),
            x402: X402Resource::new(http.clone()),
            network: NetworkResource::new(http.clone()),
            nodes: NodesResource::new(http.clone()),
            credits: CreditsResource::new(http.clone()),
            payout_wallet: PayoutWalletResource::new(http.clone()),
            payouts: PayoutsResource::new(http.clone()),
            proxy: ProxyResource::new(
                http.clone(),
                creds.clone(),
                config.proxy_host.clone(),
                http_port,
                socks_port,
                config.resolver.unwrap_or_else(default_resolver),
                config.gateway_tls,
            )?,
            creds,
            _http: http,
        })
    }

    /// Authenticate with a `dn_live_`/`dn_test_` key. On `MFA_REQUIRED` only the key is
    /// stored and `mfa_required: true` is returned (agent routes and the proxy still work).
    pub async fn connect_with_key(&self, api_key: &str) -> Result<ConnectResult> {
        validate_api_key(api_key)?;
        match self.auth.verify_key(api_key).await {
            Ok(r) => {
                self.creds.set_api_key(Some(api_key));
                self.creds.tokens.set_tokens(&r.token, Some(&r.refresh_token));
                Ok(ConnectResult { mfa_required: false, user_id: Some(r.user_id) })
            }
            Err(e) if e.code() == Some("MFA_REQUIRED") => {
                self.creds.set_api_key(Some(api_key));
                Ok(ConnectResult { mfa_required: true, user_id: None })
            }
            Err(e) => Err(e),
        }
    }

    /// Logout (best effort, BEFORE clearing tokens), then zeroize the API key and both tokens.
    pub async fn disconnect(&self) {
        if self.creds.tokens.has_tokens() {
            let _ = self.auth.logout().await;
        }
        self.creds.set_api_key(None);
        self.creds.tokens.clear();
    }

    /// True when an API key or any token is held.
    pub fn is_connected(&self) -> bool {
        self.creds.api_key().is_some() || self.creds.tokens.has_tokens()
    }

    /// Token manager (tests, advanced use).
    pub fn token_manager(&self) -> &TokenManager {
        &self.creds.tokens
    }
}

impl fmt::Debug for DominusNodeClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DominusNodeClient(connected={})", self.is_connected())
    }
}
impl fmt::Display for DominusNodeClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}
impl Serialize for DominusNodeClient {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("DominusNodeClient", 1)?;
        st.serialize_field("connected", &self.is_connected())?;
        st.end()
    }
}
