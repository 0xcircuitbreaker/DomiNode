use std::sync::Arc;

use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE, RETRY_AFTER, USER_AGENT};
use reqwest::{Client, Method, StatusCode};
use serde::de::DeserializeOwned;
use tracing::{debug, warn};

use crate::constants;
use crate::errors::{DomiNodeError, Result};
use crate::token_manager::TokenManager;

/// Low-level HTTP client that wraps [`reqwest::Client`] with DomiNode-specific
/// error mapping, automatic 429 retry, and automatic 401 token-refresh retry.
pub struct HttpClient {
    client: Client,
    base_url: String,
    token_manager: Arc<TokenManager>,
}

impl HttpClient {
    /// Create a new HTTP client.
    pub fn new(base_url: &str, token_manager: Arc<TokenManager>) -> Result<Self> {
        let mut default_headers = HeaderMap::new();
        default_headers.insert(
            USER_AGENT,
            HeaderValue::from_static(constants::USER_AGENT),
        );
        default_headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );

        let client = Client::builder()
            .default_headers(default_headers)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(DomiNodeError::Network)?;

        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            token_manager,
        })
    }

    // --------------------------------------------------------------------
    // Convenience wrappers
    // --------------------------------------------------------------------

    /// Perform an authenticated `GET` request and deserialize the response.
    pub async fn get<T: DeserializeOwned>(&self, path: &str, requires_auth: bool) -> Result<T> {
        self.request(Method::GET, path, Option::<&()>::None, requires_auth)
            .await
    }

    /// Perform an authenticated `POST` request and deserialize the response.
    pub async fn post<T: DeserializeOwned, B: serde::Serialize>(
        &self,
        path: &str,
        body: Option<&B>,
        requires_auth: bool,
    ) -> Result<T> {
        self.request(Method::POST, path, body, requires_auth).await
    }

    /// Perform an authenticated `PUT` request and deserialize the response.
    pub async fn put<T: DeserializeOwned, B: serde::Serialize>(
        &self,
        path: &str,
        body: Option<&B>,
    ) -> Result<T> {
        self.request(Method::PUT, path, body, true).await
    }

    /// Perform an authenticated `DELETE` request and deserialize the response.
    pub async fn delete<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.request::<T, ()>(Method::DELETE, path, None, true)
            .await
    }

    /// Return a raw `GET` response body as a `String` (used by CSV export).
    pub async fn get_text(&self, path: &str, requires_auth: bool) -> Result<String> {
        let url = format!("{}{}", self.base_url, path);

        let mut builder = self.client.request(Method::GET, &url);
        if requires_auth {
            let token = self.token_manager.get_valid_token().await?;
            builder = builder.bearer_auth(&token);
        }

        let response = builder.send().await.map_err(DomiNodeError::Network)?;

        if !response.status().is_success() {
            let status = response.status();
            let headers = response.headers().clone();
            let body = response.text().await.unwrap_or_default();
            return Err(map_error(status, &body, &headers));
        }

        // R17: Enforce response body size limit
        let bytes = response.bytes().await.map_err(DomiNodeError::Network)?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(DomiNodeError::Server("Response body too large".into()));
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    // --------------------------------------------------------------------
    // Core request method
    // --------------------------------------------------------------------

    async fn request<T: DeserializeOwned, B: serde::Serialize>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        requires_auth: bool,
    ) -> Result<T> {
        let url = format!("{}{}", self.base_url, path);

        // First attempt.
        let response = self.send(&method, &url, body, requires_auth).await?;
        let status = response.status();
        let headers = response.headers().clone();

        // ----- 429: auto-retry once -----
        if status == StatusCode::TOO_MANY_REQUESTS {
            let retry_after = parse_retry_after(&headers);
            let _body_text = response.text().await.unwrap_or_default();
            warn!(
                retry_after_seconds = retry_after,
                "Rate limited, retrying once"
            );

            let sleep_ms = std::cmp::max(100, std::cmp::min(retry_after * 1000, 10_000));
            tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;

            let retry = self.send(&method, &url, body, requires_auth).await?;
            let retry_status = retry.status();
            let retry_headers = retry.headers().clone();

            if retry_status.is_success() {
                return parse_body(retry).await;
            }

            let retry_body = retry.text().await.unwrap_or_default();
            return Err(map_error(retry_status, &retry_body, &retry_headers));
        }

        // ----- 401: force refresh token + retry once -----
        if status == StatusCode::UNAUTHORIZED && requires_auth {
            debug!("Got 401, forcing token refresh and retry");
            // Force a refresh unconditionally to avoid re-using a rejected token.
            match self.token_manager.force_refresh().await {
                Ok(_new_token) => {
                    let retry = self.send(&method, &url, body, true).await?;
                    let retry_status = retry.status();
                    let retry_headers = retry.headers().clone();

                    if retry_status.is_success() {
                        return parse_body(retry).await;
                    }

                    let retry_body = retry.text().await.unwrap_or_default();
                    return Err(map_error(retry_status, &retry_body, &retry_headers));
                }
                Err(_) => {
                    // Refresh failed; return the original 401.
                    let body_text = response.text().await.unwrap_or_default();
                    return Err(map_error(status, &body_text, &headers));
                }
            }
        }

        // ----- Success -----
        if status.is_success() {
            return parse_body(response).await;
        }

        // ----- Other errors -----
        let body_text = response.text().await.unwrap_or_default();
        Err(map_error(status, &body_text, &headers))
    }

    /// Build and send a single request.
    async fn send<B: serde::Serialize>(
        &self,
        method: &Method,
        url: &str,
        body: Option<&B>,
        requires_auth: bool,
    ) -> Result<reqwest::Response> {
        let mut builder = self.client.request(method.clone(), url);

        if requires_auth {
            let token = self.token_manager.get_valid_token().await?;
            builder = builder.bearer_auth(&token);
        }

        if let Some(b) = body {
            builder = builder.json(b);
        }

        builder.send().await.map_err(DomiNodeError::Network)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Maximum response body size (10 MB) to prevent OOM from malicious/large responses.
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

/// Parse a response body as JSON, treating empty bodies as `{}`.
async fn parse_body<T: DeserializeOwned>(response: reqwest::Response) -> Result<T> {
    // R17: Enforce response body size limit to prevent OOM
    let bytes = response.bytes().await.map_err(DomiNodeError::Network)?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(DomiNodeError::Server("Response body too large".into()));
    }
    if bytes.is_empty() {
        // Deserialize `{}` — works for structs with all-optional/default fields.
        return serde_json::from_str("{}").map_err(DomiNodeError::Json);
    }
    let text = String::from_utf8_lossy(&bytes);
    serde_json::from_str(&text).map_err(DomiNodeError::Json)
}

/// Extract the `Retry-After` header value in seconds, defaulting to 5, capped at 10.
fn parse_retry_after(headers: &HeaderMap) -> u64 {
    let raw = headers
        .get(RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(5);
    std::cmp::min(raw, 10)
}

/// Extract an error message from a JSON body, falling back to the raw body.
fn extract_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .or_else(|| v.get("message"))
                .and_then(|m| m.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| body.to_string())
}

/// Map an HTTP status code + body into the appropriate [`DomiNodeError`] variant.
fn map_error(status: StatusCode, body: &str, headers: &HeaderMap) -> DomiNodeError {
    let message = extract_message(body);
    match status.as_u16() {
        400 => DomiNodeError::Validation(message),
        401 => DomiNodeError::Authentication(message),
        402 => DomiNodeError::InsufficientBalance(message),
        403 => DomiNodeError::Authorization(message),
        404 => DomiNodeError::NotFound(message),
        409 => DomiNodeError::Conflict(message),
        429 => {
            let retry_after = parse_retry_after(headers);
            DomiNodeError::RateLimit {
                message,
                retry_after_seconds: retry_after,
            }
        }
        s if s >= 500 => DomiNodeError::Server(message),
        _ => DomiNodeError::Server(format!("HTTP {}: {}", status.as_u16(), message)),
    }
}
