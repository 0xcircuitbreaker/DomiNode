//! HTTP client: auth modes, 429 retry, 401 refresh, 10 MB cap, error mapping,
//! prototype-pollution key stripping.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::Value;
use zeroize::Zeroizing;

use crate::errors::{DominusNodeError, ErrorInfo, Result};
use crate::token_manager::TokenManager;
use crate::transport::{Transport, TransportRequest, TransportResponse};
use crate::util::{MAX_RESPONSE_BYTES, MAX_RETRY_WAIT_MS, MIN_RETRY_WAIT_MS, REQUEST_TIMEOUT_MS, USER_AGENT};

/// Auth mode per request (SDK_SURFACE 1.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    /// No Authorization header.
    None,
    /// Bearer access JWT (refreshed).
    Jwt,
    /// Bearer API key if held, else the wallet JWT.
    Agent,
}

/// Credentials shared by the client and its HTTP layer.
#[derive(Default)]
pub(crate) struct Credentials {
    pub tokens: Arc<TokenManager>,
    pub api_key: Mutex<Option<Zeroizing<String>>>,
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Credentials([REDACTED])")
    }
}

impl Credentials {
    pub fn api_key(&self) -> Option<String> {
        self.api_key.lock().unwrap().as_ref().map(|k| k.to_string())
    }
    pub fn set_api_key(&self, k: Option<&str>) {
        *self.api_key.lock().unwrap() = k.map(|k| Zeroizing::new(k.to_string()));
    }
}

/// Recursively delete `__proto__`, `constructor`, `prototype` keys (depth limit 50).
pub fn strip_dangerous_keys(v: &mut Value, depth: usize) {
    if depth > 50 {
        return;
    }
    match v {
        Value::Object(m) => {
            m.retain(|k, _| k != "__proto__" && k != "constructor" && k != "prototype");
            for (_, x) in m.iter_mut() {
                strip_dangerous_keys(x, depth + 1);
            }
        }
        Value::Array(a) => {
            for x in a {
                strip_dangerous_keys(x, depth + 1);
            }
        }
        _ => {}
    }
}

fn rand_unit() -> f64 {
    (uuid::Uuid::new_v4().as_u128() >> 75) as f64 / (1u64 << 53) as f64
}

/// `min(retry_after, 10 s)` ±10 % jitter, floor 100 ms.
pub fn retry_delay(retry_after_seconds: u64) -> Duration {
    retry_delay_with(retry_after_seconds, rand_unit())
}

/// Deterministic variant: `unit` in [0, 1).
pub fn retry_delay_with(retry_after_seconds: u64, unit: f64) -> Duration {
    let base = (retry_after_seconds.saturating_mul(1000)).min(MAX_RETRY_WAIT_MS) as f64;
    let jitter = base * 0.2 * (unit - 0.5);
    let ms = ((base + jitter).round() as u64).max(MIN_RETRY_WAIT_MS);
    Duration::from_millis(ms)
}

fn parse_retry_after(h: Option<&str>, fallback: u64) -> u64 {
    h.and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(fallback)
}

fn error_for_status(status: u16, body: &str, retry_after: Option<&str>) -> DominusNodeError {
    let mut message = body.to_string();
    let mut code = None;
    let mut details: Option<BTreeMap<String, Value>> = None;
    if let Ok(mut v) = serde_json::from_str::<Value>(body) {
        strip_dangerous_keys(&mut v, 0);
        if let Value::Object(m) = &v {
            if let Some(Value::String(s)) = m.get("error").or_else(|| m.get("message")) {
                message = s.clone();
            }
            if let Some(Value::String(c)) = m.get("code") {
                code = Some(c.clone());
            } else if m.get("mfaRequired") == Some(&Value::Bool(true)) {
                code = Some("MFA_REQUIRED".to_string());
            }
            for k in ["max", "cap", "limitPerDay"] {
                if let Some(x) = m.get(k) {
                    if x.is_number() || x.is_string() {
                        details.get_or_insert_with(BTreeMap::new).insert(k.to_string(), x.clone());
                    }
                }
            }
        }
    }
    if message.is_empty() {
        message = format!("HTTP {status}");
    }
    if message.chars().count() > 500 {
        message = message.chars().take(500).collect::<String>() + "... [truncated]";
    }
    let info = ErrorInfo::new(&message, Some(status)).with(code, details);
    match status {
        400 => DominusNodeError::Validation(info),
        401 => DominusNodeError::Authentication(info),
        402 => DominusNodeError::InsufficientBalance(info),
        403 => DominusNodeError::Authorization(info),
        404 => DominusNodeError::NotFound(info),
        409 => DominusNodeError::Conflict(info),
        429 => DominusNodeError::RateLimit { info, retry_after_seconds: parse_retry_after(retry_after, 60) },
        s if s >= 500 => DominusNodeError::Server(info),
        _ => DominusNodeError::Api(info),
    }
}

/// Low-level API client.
pub struct HttpClient {
    base_url: String,
    creds: Arc<Credentials>,
    transport: Arc<dyn Transport>,
}

impl fmt::Debug for HttpClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "HttpClient({})", self.base_url)
    }
}

/// Validate a base URL: http(s), no userinfo; trailing `/` stripped.
pub(crate) fn normalize_base_url(base: &str) -> Result<String> {
    let u = reqwest::Url::parse(base).map_err(|_| DominusNodeError::invalid_arg("baseUrl is not a valid URL"))?;
    if u.scheme() != "https" && u.scheme() != "http" {
        return Err(DominusNodeError::invalid_arg("baseUrl must be http(s)"));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(DominusNodeError::invalid_arg("baseUrl must not contain credentials"));
    }
    Ok(base.trim_end_matches('/').to_string())
}

impl HttpClient {
    pub(crate) fn new(base_url: String, creds: Arc<Credentials>, transport: Arc<dyn Transport>) -> Self {
        Self { base_url, creds, transport }
    }

    async fn bearer(&self, mode: AuthMode, force: bool) -> Result<Option<String>> {
        match mode {
            AuthMode::None => return Ok(None),
            AuthMode::Agent => {
                if let Some(k) = self.creds.api_key() {
                    return Ok(Some(k));
                }
            }
            AuthMode::Jwt => {}
        }
        if !self.creds.tokens.has_tokens() {
            return Err(DominusNodeError::auth(
                "Not authenticated. Call connect_with_key() or wallet_auth.verify() first.",
            ));
        }
        let t = if force { self.creds.tokens.force_refresh().await? } else { self.creds.tokens.get_valid_token().await? };
        Ok(Some(t))
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        body: &Option<Vec<u8>>,
        headers: &[(String, String)],
        bearer: &Option<String>,
    ) -> Result<TransportResponse> {
        let mut h = vec![
            ("User-Agent".to_string(), USER_AGENT.to_string()),
            ("Accept".to_string(), "application/json".to_string()),
        ];
        h.extend(headers.iter().cloned());
        if body.is_some() {
            h.push(("Content-Type".to_string(), "application/json".to_string()));
        }
        if let Some(b) = bearer {
            h.push(("Authorization".to_string(), format!("Bearer {b}")));
        }
        let req = TransportRequest {
            method: method.to_string(),
            url: format!("{}{}", self.base_url, path),
            headers: h,
            body: body.clone(),
            timeout: Duration::from_millis(REQUEST_TIMEOUT_MS),
        };
        self.transport.send(req).await.map_err(DominusNodeError::network)
    }

    /// Perform a request and return the status and body text.
    pub(crate) async fn request_text(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        auth: AuthMode,
        headers: &[(String, String)],
    ) -> Result<String> {
        let body = body.map(|b| serde_json::to_vec(&b).expect("JSON value serializes"));
        let mut bearer = self.bearer(auth, false).await?;
        let mut res = self.send(method, path, &body, headers, &bearer).await?;

        if res.status == 429 {
            let wait = retry_delay(parse_retry_after(res.header("retry-after"), 5));
            drop(res.body); // cancel the 429 body unread
            tokio::time::sleep(wait).await;
            bearer = self.bearer(auth, false).await?;
            res = self.send(method, path, &body, headers, &bearer).await?;
        }

        let used_jwt = bearer.as_deref().is_some_and(|b| !b.starts_with("dn_"));
        if res.status == 401 && used_jwt && self.creds.tokens.refresh_token().is_some() {
            drop(res.body);
            let refreshed = self.bearer(auth, true).await.ok().flatten();
            match refreshed {
                Some(t) => res = self.send(method, path, &body, headers, &Some(t)).await?,
                None => return Err(DominusNodeError::auth("Session expired and token refresh failed")),
            }
        }

        let status = res.status;
        let cl = res.header("content-length").and_then(|v| v.trim().parse::<u64>().ok());
        if cl.is_some_and(|n| n > MAX_RESPONSE_BYTES as u64) {
            drop(res.body);
            return Err(DominusNodeError::server("Response body too large", status));
        }
        let retry_after = res.header("retry-after").map(str::to_string);
        let bytes = res
            .body
            .read_capped(MAX_RESPONSE_BYTES)
            .await
            .map_err(DominusNodeError::network)?
            .ok_or_else(|| DominusNodeError::server("Response body exceeds size limit", status))?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if !(200..300).contains(&status) {
            return Err(error_for_status(status, &text, retry_after.as_deref()));
        }
        Ok(text)
    }

    /// JSON request -> typed result.
    pub(crate) async fn request<T: DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        auth: AuthMode,
        headers: &[(String, String)],
    ) -> Result<T> {
        let text = self.request_text(method, path, body, auth, headers).await?;
        let mut v: Value = if text.trim().is_empty() {
            Value::Object(Default::default())
        } else {
            serde_json::from_str(&text).map_err(|_| DominusNodeError::server("Invalid JSON in response", 200))?
        };
        strip_dangerous_keys(&mut v, 0);
        serde_json::from_value(v).map_err(|e| DominusNodeError::server(format!("Unexpected response shape: {e}"), 200))
    }

    pub(crate) async fn get<T: DeserializeOwned>(&self, path: &str, auth: AuthMode) -> Result<T> {
        self.request("GET", path, None, auth, &[]).await
    }
    pub(crate) async fn post<T: DeserializeOwned>(&self, path: &str, body: Value, auth: AuthMode) -> Result<T> {
        self.request("POST", path, Some(body), auth, &[]).await
    }
    pub(crate) async fn put<T: DeserializeOwned>(&self, path: &str, body: Value, auth: AuthMode) -> Result<T> {
        self.request("PUT", path, Some(body), auth, &[]).await
    }
    pub(crate) async fn patch<T: DeserializeOwned>(&self, path: &str, body: Value, auth: AuthMode) -> Result<T> {
        self.request("PATCH", path, Some(body), auth, &[]).await
    }
    pub(crate) async fn delete<T: DeserializeOwned>(&self, path: &str, auth: AuthMode) -> Result<T> {
        self.request("DELETE", path, None, auth, &[]).await
    }
}
