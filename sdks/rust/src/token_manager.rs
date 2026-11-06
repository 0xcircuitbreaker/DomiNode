//! JWT access/refresh pair with singleton refresh. `clear()` drops tokens but
//! keeps the refresh callback so the client can reconnect.

use std::fmt;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Serialize, Serializer};
use zeroize::Zeroizing;

use crate::errors::{DominusNodeError, Result};
use crate::transport::BoxFuture;
use crate::util::TOKEN_REFRESH_BUFFER_SECS;

/// Refresh callback: refresh token -> (access token, rotated refresh token).
pub type RefreshFn = Arc<dyn Fn(String) -> BoxFuture<'static, Result<(String, Option<String>)>> + Send + Sync>;

#[derive(Default)]
struct Tokens {
    access: Option<Zeroizing<String>>,
    refresh: Option<Zeroizing<String>>,
    generation: u64,
}

/// Holds the JWT pair.
#[derive(Default)]
pub struct TokenManager {
    tokens: Mutex<Tokens>,
    refresh_fn: RwLock<Option<RefreshFn>>,
    refresh_lock: tokio::sync::Mutex<()>,
}

impl TokenManager {
    /// Empty manager.
    pub fn new() -> Self {
        Self::default()
    }

    /// Store a token pair (refresh kept when `None`).
    pub fn set_tokens(&self, access: &str, refresh: Option<&str>) {
        let mut t = self.tokens.lock().unwrap();
        t.access = Some(Zeroizing::new(access.to_string()));
        if let Some(r) = refresh.filter(|r| !r.is_empty()) {
            t.refresh = Some(Zeroizing::new(r.to_string()));
        }
        t.generation += 1;
    }

    /// Install the refresh callback.
    pub fn set_refresh_function(&self, f: RefreshFn) {
        *self.refresh_fn.write().unwrap() = Some(f);
    }

    /// Whether a refresh callback is installed.
    pub fn has_refresh_function(&self) -> bool {
        self.refresh_fn.read().unwrap().is_some()
    }

    /// Current access token.
    pub fn access_token(&self) -> Option<String> {
        self.tokens.lock().unwrap().access.as_ref().map(|s| s.to_string())
    }

    /// Current refresh token.
    pub fn refresh_token(&self) -> Option<String> {
        self.tokens.lock().unwrap().refresh.as_ref().map(|s| s.to_string())
    }

    /// Any token held.
    pub fn has_tokens(&self) -> bool {
        let t = self.tokens.lock().unwrap();
        t.access.is_some() || t.refresh.is_some()
    }

    /// True when the JWT has no readable `exp` or expires within the buffer.
    pub fn is_expired(token: &str) -> bool {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 {
            return true;
        }
        let Ok(raw) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[1].trim_end_matches('=')) else {
            return true;
        };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw) else { return true };
        let Some(exp) = v.get("exp").and_then(|e| e.as_f64()) else { return true };
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
        exp < now + TOKEN_REFRESH_BUFFER_SECS as f64
    }

    /// A non-expired access token, refreshing if needed.
    pub async fn get_valid_token(&self) -> Result<String> {
        if let Some(a) = self.access_token() {
            if !Self::is_expired(&a) {
                return Ok(a);
            }
        }
        self.force_refresh().await
    }

    /// Refresh regardless of expiry. Concurrent callers share one refresh.
    /// On failure both tokens are cleared.
    pub async fn force_refresh(&self) -> Result<String> {
        let gen_before = self.tokens.lock().unwrap().generation;
        let _guard = self.refresh_lock.lock().await;
        {
            let t = self.tokens.lock().unwrap();
            if t.generation != gen_before {
                if let Some(a) = t.access.as_ref() {
                    return Ok(a.to_string());
                }
            }
        }
        let rt = self.refresh_token();
        let f = self.refresh_fn.read().unwrap().clone();
        let (Some(rt), Some(f)) = (rt, f) else {
            return Err(DominusNodeError::auth("No valid token and cannot refresh"));
        };
        match f(rt).await {
            Ok((access, refresh)) => {
                self.set_tokens(&access, refresh.as_deref());
                Ok(access)
            }
            Err(e) => {
                self.clear();
                Err(e)
            }
        }
    }

    /// Drop (and zeroize) both tokens. Does NOT remove the refresh callback.
    pub fn clear(&self) {
        let mut t = self.tokens.lock().unwrap();
        t.access = None;
        t.refresh = None;
        t.generation += 1;
    }
}

impl fmt::Debug for TokenManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TokenManager([REDACTED])")
    }
}
impl fmt::Display for TokenManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TokenManager([REDACTED])")
    }
}
impl Serialize for TokenManager {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str("[REDACTED]")
    }
}
