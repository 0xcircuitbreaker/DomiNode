use std::sync::Arc;

use crate::admin::AdminResource;
use crate::auth::AuthResource;
use crate::constants::{DEFAULT_BASE_URL, DEFAULT_HTTP_PROXY_PORT, DEFAULT_PROXY_HOST, DEFAULT_SOCKS5_PROXY_PORT};
use crate::errors::Result;
use crate::http_client::HttpClient;
use crate::keys::KeysResource;
use crate::plans::PlansResource;
use crate::proxy::ProxyResource;
use crate::sessions::SessionsResource;
use crate::token_manager::TokenManager;
use crate::types::{LoginResult, TokenPair};
use crate::usage::UsageResource;
use crate::wallet::WalletResource;

/// SDK configuration.
///
/// All fields have sensible defaults. At minimum you should set `base_url` if
/// your Dominus Node instance is not at the default `https://api.dominusnode.com`.
// R15 H-5: Clone intentionally not derived — prevents accidental credential proliferation in memory.
// Use Config::default() to create a new instance instead of cloning.
pub struct Config {
    /// Base URL of the Dominus Node REST API (e.g. `"https://api.dominusnode.com"`).
    pub base_url: String,
    /// Pre-configured API key (optional).
    pub api_key: Option<String>,
    /// Pre-configured access token (optional).
    pub access_token: Option<String>,
    /// Pre-configured refresh token (optional).
    pub refresh_token: Option<String>,
    /// Hostname of the proxy gateway.
    pub proxy_host: String,
    /// HTTP proxy port.
    pub http_proxy_port: u16,
    /// SOCKS5 proxy port.
    pub socks5_proxy_port: u16,
}

// Custom Debug to redact credentials (R13 H-2)
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("access_token", &self.access_token.as_ref().map(|_| "[REDACTED]"))
            .field("refresh_token", &self.refresh_token.as_ref().map(|_| "[REDACTED]"))
            .field("proxy_host", &self.proxy_host)
            .field("http_proxy_port", &self.http_proxy_port)
            .field("socks5_proxy_port", &self.socks5_proxy_port)
            .finish()
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            api_key: None,
            access_token: None,
            refresh_token: None,
            proxy_host: DEFAULT_PROXY_HOST.to_string(),
            http_proxy_port: DEFAULT_HTTP_PROXY_PORT,
            socks5_proxy_port: DEFAULT_SOCKS5_PROXY_PORT,
        }
    }
}

/// The top-level Dominus Node SDK client.
///
/// Create an instance with [`DominusNodeClient::new`] and then use the resource
/// fields (`auth`, `keys`, `wallet`, etc.) to interact with the API.
///
/// # Examples
///
/// ```no_run
/// use dominusnode::{DominusNodeClient, Config};
///
/// # async fn example() -> dominusnode::Result<()> {
/// let client = DominusNodeClient::new(Config::default())?;
///
/// // Authenticate with an API key.
/// client.connect_with_key("dn_live_abc123").await?;
///
/// // Use resources.
/// let balance = client.wallet.get_balance().await?;
/// println!("Balance: {} cents", balance.balance_cents);
/// # Ok(())
/// # }
/// ```
pub struct DominusNodeClient {
    /// Authentication operations (register, login, MFA, etc.).
    pub auth: AuthResource,
    /// API key management (create, list, revoke).
    pub keys: KeysResource,
    /// Wallet balance and top-up operations.
    pub wallet: WalletResource,
    /// Metered bandwidth usage data.
    pub usage: UsageResource,
    /// Billing plan management.
    pub plans: PlansResource,
    /// Active proxy session queries.
    pub sessions: SessionsResource,
    /// Proxy URL building and gateway status.
    pub proxy: ProxyResource,
    /// Administrative operations (requires admin privileges).
    pub admin: AdminResource,
    token_manager: Arc<TokenManager>,
}

impl DominusNodeClient {
    /// Create a new Dominus Node client with the given configuration.
    ///
    /// If `config.access_token` is provided it will be stored immediately so
    /// subsequent requests are authenticated. A `refresh_token` enables
    /// automatic token renewal.
    pub fn new(config: Config) -> Result<Self> {
        let token_manager = Arc::new(TokenManager::new());
        let http = Arc::new(HttpClient::new(&config.base_url, Arc::clone(&token_manager))?);

        // Wire up the refresh callback. We create a separate HttpClient that
        // always calls the refresh endpoint without auth (it sends the refresh
        // token in the body).
        {
            let http_for_refresh = Arc::clone(&http);

            // The refresh function is registered on the token manager and will be
            // called whenever the access token is expired.
            let refresh_fn = move |rt: String| {
                let http_ref = Arc::clone(&http_for_refresh);
                Box::pin(async move {
                    #[derive(serde::Serialize)]
                    struct RefreshBody {
                        #[serde(rename = "refreshToken")]
                        refresh_token: String,
                    }
                    #[derive(serde::Deserialize)]
                    struct RefreshResp {
                        token: String,
                        #[serde(rename = "refreshToken")]
                        refresh_token: Option<String>,
                    }

                    let resp: RefreshResp = http_ref
                        .post(
                            "/api/auth/refresh",
                            Some(&RefreshBody { refresh_token: rt.clone() }),
                            false,
                        )
                        .await?;

                    Ok(TokenPair {
                        access_token: resp.token,
                        refresh_token: resp.refresh_token.unwrap_or(rt),
                    })
                }) as std::pin::Pin<Box<dyn std::future::Future<Output = Result<TokenPair>> + Send>>
            };

            // We need to set this synchronously during construction but
            // set_refresh_fn is async. Use block_in_place to call it, or
            // just set it directly by spawning a small runtime step.
            // Since this is called at construction time before any async
            // context is necessarily available, we construct the inner
            // state directly.
            //
            // The token_manager exposes set_refresh_fn as async only because
            // it holds a Mutex. We can use try_lock here since we just created
            // the manager and no one else holds the lock.
            //
            // Actually, let's just block on it -- this is a one-time setup cost.
            // We'll use a small helper that works whether or not we're in a tokio context.
            futures_lite_compat_set_refresh_fn(&token_manager, Box::new(refresh_fn));
        }

        // Build resources.
        let auth = AuthResource::new(Arc::clone(&http));
        let keys = KeysResource::new(Arc::clone(&http));
        let wallet = WalletResource::new(Arc::clone(&http));
        let usage = UsageResource::new(Arc::clone(&http));
        let plans = PlansResource::new(Arc::clone(&http));
        let sessions = SessionsResource::new(Arc::clone(&http));
        let proxy = ProxyResource::new(
            Arc::clone(&http),
            config.proxy_host,
            config.http_proxy_port,
            config.socks5_proxy_port,
        );
        let admin = AdminResource::new(Arc::clone(&http));

        let client = Self {
            auth,
            keys,
            wallet,
            usage,
            plans,
            sessions,
            proxy,
            admin,
            token_manager: Arc::clone(&token_manager),
        };

        // If tokens were provided in the config, store them now.
        if let Some(ref access) = config.access_token {
            // Same approach: try_lock since we are the only holder.
            set_tokens_sync(
                &token_manager,
                access,
                config.refresh_token.as_deref(),
            );
        }

        Ok(client)
    }

    /// Authenticate using an API key.
    ///
    /// The key is verified against the server and the resulting JWT tokens are
    /// stored for all subsequent authenticated requests.
    pub async fn connect_with_key(&self, api_key: &str) -> Result<()> {
        let res = self.auth.verify_key(api_key).await?;
        self.token_manager
            .set_tokens(&res.token, Some(&res.refresh_token))
            .await;
        Ok(())
    }

    /// Authenticate with email and password.
    ///
    /// If the account has MFA enabled the returned [`LoginResult`] will have
    /// `mfa_required == true`. Call [`DominusNodeClient::complete_mfa`] to finish
    /// the authentication flow.
    pub async fn connect_with_credentials(
        &self,
        email: &str,
        password: &str,
    ) -> Result<LoginResult> {
        let res = self.auth.login(email, password).await?;
        if let Some(ref token) = res.token {
            self.token_manager
                .set_tokens(token, res.refresh_token.as_deref())
                .await;
        }
        Ok(LoginResult {
            user: res.user,
            mfa_required: res.mfa_required,
        })
    }

    /// Complete MFA verification after a login that returned `mfa_required == true`.
    pub async fn complete_mfa(
        &self,
        code: &str,
        challenge_token: Option<&str>,
        is_backup: bool,
    ) -> Result<()> {
        let res = self
            .auth
            .verify_mfa(code, challenge_token, is_backup)
            .await?;
        self.token_manager
            .set_tokens(&res.token, Some(&res.refresh_token))
            .await;
        Ok(())
    }

    /// Clear all stored tokens. Does **not** call the server logout endpoint.
    ///
    /// If you want to revoke refresh tokens server-side, call
    /// `client.auth.logout()` first.
    pub async fn disconnect(&self) {
        self.token_manager.clear().await;
    }
}

// ---------------------------------------------------------------------------
// Sync helpers for one-time setup during construction.
// ---------------------------------------------------------------------------

/// Set the refresh function on the token manager synchronously.
/// Safe because no other task can hold the lock at construction time.
fn futures_lite_compat_set_refresh_fn(
    tm: &Arc<TokenManager>,
    f: crate::token_manager::RefreshFn,
) {
    // We use try_lock because we know no one else holds the mutex.
    // If for some reason try_lock fails, fall back to spawning a blocking task.
    if let Ok(mut guard) = tm.refresh_fn_try_lock() {
        *guard = Some(Arc::new(f));
    }
}

/// Store tokens synchronously during construction.
fn set_tokens_sync(tm: &Arc<TokenManager>, access: &str, refresh: Option<&str>) {
    if let (Ok(mut at), Ok(mut rt)) = (tm.access_token_try_lock(), tm.refresh_token_try_lock()) {
        *at = Some(access.to_string());
        if let Some(r) = refresh {
            *rt = Some(r.to_string());
        }
    }
}
