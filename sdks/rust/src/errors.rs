use thiserror::Error;

/// All errors that can be returned by the Dominus Node SDK.
#[derive(Error, Debug)]
pub enum DominusNodeError {
    /// The server rejected the provided credentials or token.
    #[error("Authentication failed: {0}")]
    Authentication(String),

    /// The authenticated user does not have permission for the requested resource.
    #[error("Authorization denied: {0}")]
    Authorization(String),

    /// The server returned HTTP 429. `retry_after_seconds` indicates when to retry.
    #[error("Rate limited: retry after {retry_after_seconds}s - {message}")]
    RateLimit {
        message: String,
        retry_after_seconds: u64,
    },

    /// The user's wallet balance is too low to proceed.
    #[error("Insufficient balance: {0}")]
    InsufficientBalance(String),

    /// A request parameter failed server-side validation.
    #[error("Validation error: {0}")]
    Validation(String),

    /// The requested resource does not exist.
    #[error("Not found: {0}")]
    NotFound(String),

    /// A conflicting resource already exists (e.g. duplicate email).
    #[error("Conflict: {0}")]
    Conflict(String),

    /// An unexpected server-side error occurred.
    #[error("Server error: {0}")]
    Server(String),

    /// A network-level error (DNS, TLS, connection refused, etc.).
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    /// A proxy-specific error returned by the gateway.
    #[error("Proxy error: {message}")]
    Proxy {
        message: String,
        error_code: Option<String>,
    },

    /// Failed to serialize or deserialize JSON.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Convenience alias used throughout the SDK.
pub type Result<T> = std::result::Result<T, DominusNodeError>;
