//! Error type. Every message passes through [`scrub_credentials`] so API keys
//! (`dn_live_`/`dn_test_`/`dn_node_`/`dn_proxy_`) and JWTs never reach logs or
//! callers through error strings.

use std::collections::BTreeMap;
use std::fmt;

/// Result alias used by the whole crate.
pub type Result<T> = std::result::Result<T, DominusNodeError>;

/// Replace credentials in `message` with `[REDACTED]`.
pub fn scrub_credentials(message: &str) -> String {
    let s = scrub_keys(message);
    scrub_jwts(&s)
}

fn is_tok(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

fn scrub_keys(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut last = 0;
    while i < b.len() {
        let mut matched = None;
        for p in ["dn_live_", "dn_test_", "dn_node_", "dn_proxy_"] {
            if b[i..].starts_with(p.as_bytes()) {
                let mut j = i + p.len();
                while j < b.len() && is_tok(b[j]) {
                    j += 1;
                }
                if j > i + p.len() {
                    matched = Some(j);
                }
                break;
            }
        }
        if let Some(j) = matched {
            out.push_str(&s[last..i]);
            out.push_str("[REDACTED]");
            i = j;
            last = j;
        } else {
            i += 1;
        }
    }
    out.push_str(&s[last..]);
    out
}

/// `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*`
fn scrub_jwts(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut last = 0;
    while i < b.len() {
        if b[i..].starts_with(b"eyJ") {
            let seg = |mut j: usize| {
                let st = j;
                while j < b.len() && is_tok(b[j]) {
                    j += 1;
                }
                (st, j)
            };
            let (_, e1) = seg(i + 3);
            if e1 > i + 3 && e1 < b.len() && b[e1] == b'.' {
                let (s2, e2) = seg(e1 + 1);
                if e2 > s2 && e2 < b.len() && b[e2] == b'.' {
                    let (_, e3) = seg(e2 + 1);
                    out.push_str(&s[last..i]);
                    out.push_str("[REDACTED]");
                    i = e3;
                    last = e3;
                    continue;
                }
            }
        }
        i += 1;
    }
    out.push_str(&s[last..]);
    out
}

/// Common payload of every error variant.
#[derive(Debug, Clone, PartialEq)]
pub struct ErrorInfo {
    /// Credential-scrubbed message (server `error`/`message`, max 500 chars).
    pub message: String,
    /// HTTP status, or `None` for client-side failures.
    pub status_code: Option<u16>,
    /// Server error code (`code` in the body), or `INVALID_ARGUMENT` / `MFA_REQUIRED`.
    pub code: Option<String>,
    /// `max`, `cap`, `limitPerDay` when the server sent them.
    pub details: Option<BTreeMap<String, serde_json::Value>>,
}

impl ErrorInfo {
    /// Build a scrubbed error payload.
    pub fn new(message: impl AsRef<str>, status_code: Option<u16>) -> Self {
        Self { message: scrub_credentials(message.as_ref()), status_code, code: None, details: None }
    }
    pub(crate) fn with(mut self, code: Option<String>, details: Option<BTreeMap<String, serde_json::Value>>) -> Self {
        self.code = code;
        self.details = details;
        self
    }
}

impl fmt::Display for ErrorInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// Error enum (SDK_SURFACE 1.8).
#[derive(Debug, Clone, thiserror::Error)]
pub enum DominusNodeError {
    /// HTTP 400, or a client-side argument check (status `None`, code `INVALID_ARGUMENT`).
    #[error("validation error: {0}")]
    Validation(ErrorInfo),
    /// HTTP 401, or no credential held.
    #[error("authentication error: {0}")]
    Authentication(ErrorInfo),
    /// HTTP 402.
    #[error("insufficient balance: {0}")]
    InsufficientBalance(ErrorInfo),
    /// HTTP 403.
    #[error("authorization error: {0}")]
    Authorization(ErrorInfo),
    /// HTTP 404.
    #[error("not found: {0}")]
    NotFound(ErrorInfo),
    /// HTTP 409.
    #[error("conflict: {0}")]
    Conflict(ErrorInfo),
    /// HTTP 429 after the single retry.
    #[error("rate limited: {info} (retry after {retry_after_seconds}s)")]
    RateLimit {
        /// Error payload.
        info: ErrorInfo,
        /// `Retry-After` seconds (default 60).
        retry_after_seconds: u64,
    },
    /// HTTP >= 500, oversize body, invalid JSON.
    #[error("server error: {0}")]
    Server(ErrorInfo),
    /// Transport failure.
    #[error("network error: {0}")]
    Network(ErrorInfo),
    /// Server data the SDK refuses to act on, or a signer failure.
    #[error("protocol error: {0}")]
    Protocol(ErrorInfo),
    /// `proxy.fetch` failure.
    #[error("proxy error: {0}")]
    Proxy(ErrorInfo),
    /// Any other HTTP status (e.g. a 3xx, which is never followed).
    #[error("api error: {0}")]
    Api(ErrorInfo),
}

impl DominusNodeError {
    /// The shared payload.
    pub fn info(&self) -> &ErrorInfo {
        match self {
            Self::Validation(i)
            | Self::Authentication(i)
            | Self::InsufficientBalance(i)
            | Self::Authorization(i)
            | Self::NotFound(i)
            | Self::Conflict(i)
            | Self::Server(i)
            | Self::Network(i)
            | Self::Protocol(i)
            | Self::Proxy(i)
            | Self::Api(i) => i,
            Self::RateLimit { info, .. } => info,
        }
    }
    /// Scrubbed message.
    pub fn message(&self) -> &str {
        &self.info().message
    }
    /// HTTP status code, if any.
    pub fn status_code(&self) -> Option<u16> {
        self.info().status_code
    }
    /// Error code, if any.
    pub fn code(&self) -> Option<&str> {
        self.info().code.as_deref()
    }
    /// Extra details (`max`, `cap`, `limitPerDay`).
    pub fn details(&self) -> Option<&BTreeMap<String, serde_json::Value>> {
        self.info().details.as_ref()
    }

    pub(crate) fn invalid_arg(message: impl AsRef<str>) -> Self {
        Self::Validation(ErrorInfo::new(message, None).with(Some("INVALID_ARGUMENT".into()), None))
    }
    pub(crate) fn auth(message: impl AsRef<str>) -> Self {
        Self::Authentication(ErrorInfo::new(message, Some(401)))
    }
    pub(crate) fn protocol(message: impl AsRef<str>) -> Self {
        Self::Protocol(ErrorInfo::new(message, None))
    }
    pub(crate) fn proxy(message: impl AsRef<str>, status: Option<u16>) -> Self {
        Self::Proxy(ErrorInfo::new(message, status))
    }
    pub(crate) fn network(message: impl AsRef<str>) -> Self {
        Self::Network(ErrorInfo::new(message, None))
    }
    pub(crate) fn server(message: impl AsRef<str>, status: u16) -> Self {
        Self::Server(ErrorInfo::new(message, Some(status)))
    }
}
