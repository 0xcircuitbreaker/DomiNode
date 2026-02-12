use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine;
use tokio::sync::Mutex;
use tracing::debug;

use crate::constants::TOKEN_REFRESH_BUFFER_SECS;
use crate::errors::{DomiNodeError, Result};
use crate::types::TokenPair;

/// A refresh callback that takes a refresh token string and returns a future
/// resolving to a new [`TokenPair`].
pub type RefreshFn = Box<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<TokenPair>> + Send>> + Send + Sync,
>;

/// Thread-safe, async-aware JWT token manager.
///
/// Stores access and refresh tokens in memory only (never persisted). When the
/// access token is expired (or about to expire within [`TOKEN_REFRESH_BUFFER_SECS`]),
/// the manager automatically invokes the registered refresh callback and
/// de-duplicates concurrent refresh attempts.
pub struct TokenManager {
    access_token: Mutex<Option<String>>,
    refresh_token: Mutex<Option<String>>,
    refresh_fn: Mutex<Option<Arc<RefreshFn>>>,
    /// Guards concurrent refreshes so only one proceeds at a time.
    refresh_lock: Mutex<()>,
}

impl TokenManager {
    /// Create a new empty token manager.
    pub fn new() -> Self {
        Self {
            access_token: Mutex::new(None),
            refresh_token: Mutex::new(None),
            refresh_fn: Mutex::new(None),
            refresh_lock: Mutex::new(()),
        }
    }

    /// Store an access token and optionally a refresh token.
    pub async fn set_tokens(&self, access: &str, refresh: Option<&str>) {
        *self.access_token.lock().await = Some(access.to_string());
        if let Some(rt) = refresh {
            *self.refresh_token.lock().await = Some(rt.to_string());
        }
    }

    /// Register the callback used to exchange a refresh token for a new pair.
    pub async fn set_refresh_fn(&self, f: RefreshFn) {
        *self.refresh_fn.lock().await = Some(Arc::new(f));
    }

    /// Return a valid access token, refreshing if necessary.
    ///
    /// If the current access token is still valid it is returned immediately.
    /// Otherwise, the refresh callback is invoked (only one concurrent caller
    /// will perform the actual refresh; others wait).
    pub async fn get_valid_token(&self) -> Result<String> {
        // Fast path: token exists and is not expired.
        {
            let guard = self.access_token.lock().await;
            if let Some(ref token) = *guard {
                if !Self::is_expired(token) {
                    return Ok(token.clone());
                }
            }
        }

        // Slow path: need to refresh. Acquire the refresh lock so only one
        // caller performs the network call.
        // R16 R-4: Timeout on lock acquisition to prevent indefinite hang if refresh callback stalls
        let _lock = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.refresh_lock.lock(),
        )
        .await
        .map_err(|_| DomiNodeError::Authentication("Token refresh lock timed out".into()))?;

        // Re-check after acquiring lock (another caller may have refreshed).
        {
            let guard = self.access_token.lock().await;
            if let Some(ref token) = *guard {
                if !Self::is_expired(token) {
                    return Ok(token.clone());
                }
            }
        }

        let rt = {
            let guard = self.refresh_token.lock().await;
            guard.clone()
        };
        let refresh_fn = {
            let guard = self.refresh_fn.lock().await;
            guard.clone()
        };

        match (rt, refresh_fn) {
            (Some(rt), Some(f)) => {
                debug!("Refreshing expired access token");
                let pair = f(rt).await?;
                *self.access_token.lock().await = Some(pair.access_token.clone());
                *self.refresh_token.lock().await = Some(pair.refresh_token);
                Ok(pair.access_token)
            }
            _ => Err(DomiNodeError::Authentication(
                "No valid token and cannot refresh".to_string(),
            )),
        }
    }

    /// Returns `true` if the given JWT is expired or will expire within
    /// [`TOKEN_REFRESH_BUFFER_SECS`].
    ///
    /// This performs a best-effort decode of the JWT payload without
    /// verifying the signature, which is sufficient for local expiry checks.
    pub fn is_expired(token: &str) -> bool {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 {
            return true;
        }

        // JWT base64url -> standard base64 alphabet (no padding needed
        // by STANDARD_NO_PAD).
        let b64 = parts[1].replace('-', "+").replace('_', "/");

        let decoded = match STANDARD_NO_PAD.decode(&b64) {
            Ok(bytes) => bytes,
            Err(_) => return true,
        };

        let payload: serde_json::Value = match serde_json::from_slice(&decoded) {
            Ok(v) => v,
            Err(_) => return true,
        };

        let exp = match payload.get("exp").and_then(|v| v.as_u64()) {
            Some(e) => e,
            None => return true,
        };

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        exp < now + TOKEN_REFRESH_BUFFER_SECS
    }

    /// Force a token refresh regardless of expiry state.
    /// Used after a 401 response to avoid re-using a rejected token.
    pub async fn force_refresh(&self) -> Result<String> {
        // R16 R-4: Timeout on lock acquisition to prevent indefinite hang
        let _lock = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.refresh_lock.lock(),
        )
        .await
        .map_err(|_| DomiNodeError::Authentication("Token refresh lock timed out".into()))?;

        let rt = {
            let guard = self.refresh_token.lock().await;
            guard.clone()
        };
        let refresh_fn = {
            let guard = self.refresh_fn.lock().await;
            guard.clone()
        };

        match (rt, refresh_fn) {
            (Some(rt), Some(f)) => {
                debug!("Force-refreshing access token after 401");
                let pair = f(rt).await?;
                *self.access_token.lock().await = Some(pair.access_token.clone());
                *self.refresh_token.lock().await = Some(pair.refresh_token);
                Ok(pair.access_token)
            }
            _ => Err(DomiNodeError::Authentication(
                "No valid token and cannot refresh".to_string(),
            )),
        }
    }

    /// Discard all stored tokens, securely zeroing memory before dropping.
    pub async fn clear(&self) {
        {
            let mut at = self.access_token.lock().await;
            if let Some(ref mut token) = *at {
                zeroize::Zeroize::zeroize(token);
            }
            *at = None;
        }
        {
            let mut rt = self.refresh_token.lock().await;
            if let Some(ref mut token) = *rt {
                zeroize::Zeroize::zeroize(token);
            }
            *rt = None;
        }
    }

    // ------------------------------------------------------------------
    // Synchronous try_lock accessors used during client construction,
    // when no other task can possibly hold these locks.
    // ------------------------------------------------------------------

    /// Try to lock the access-token mutex without blocking.
    pub(crate) fn access_token_try_lock(
        &self,
    ) -> std::result::Result<tokio::sync::MutexGuard<'_, Option<String>>, ()> {
        self.access_token.try_lock().map_err(|_| ())
    }

    /// Try to lock the refresh-token mutex without blocking.
    pub(crate) fn refresh_token_try_lock(
        &self,
    ) -> std::result::Result<tokio::sync::MutexGuard<'_, Option<String>>, ()> {
        self.refresh_token.try_lock().map_err(|_| ())
    }

    /// Try to lock the refresh-fn mutex without blocking.
    pub(crate) fn refresh_fn_try_lock(
        &self,
    ) -> std::result::Result<tokio::sync::MutexGuard<'_, Option<Arc<RefreshFn>>>, ()> {
        self.refresh_fn.try_lock().map_err(|_| ())
    }
}

impl Default for TokenManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_expired_garbage_input() {
        assert!(TokenManager::is_expired("not.a.jwt"));
        assert!(TokenManager::is_expired(""));
        assert!(TokenManager::is_expired("only-one-part"));
    }
}
