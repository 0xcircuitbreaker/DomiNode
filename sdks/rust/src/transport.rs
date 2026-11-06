//! Pluggable HTTP transport. The default uses `reqwest` with redirects disabled;
//! tests inject their own.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

/// Boxed future alias.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Outgoing request.
#[derive(Clone)]
pub struct TransportRequest {
    /// HTTP method.
    pub method: String,
    /// Absolute URL.
    pub url: String,
    /// Headers (name, value).
    pub headers: Vec<(String, String)>,
    /// JSON body bytes.
    pub body: Option<Vec<u8>>,
    /// Per-request timeout.
    pub timeout: Duration,
}

impl TransportRequest {
    /// Header lookup (case-insensitive).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

impl fmt::Debug for TransportRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let headers: Vec<(&str, &str)> = self
            .headers
            .iter()
            .map(|(k, v)| {
                if k.eq_ignore_ascii_case("authorization") {
                    (k.as_str(), "[REDACTED]")
                } else {
                    (k.as_str(), v.as_str())
                }
            })
            .collect();
        f.debug_struct("TransportRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("headers", &headers)
            .finish()
    }
}

/// Response body that can be read with a size cap or dropped (cancelled) unread.
pub trait ResponseBody: Send {
    /// Read at most `max` bytes. `Ok(None)` when the body is larger than `max`.
    fn read_capped(self: Box<Self>, max: usize) -> BoxFuture<'static, Result<Option<Vec<u8>>, String>>;
}

/// Incoming response.
pub struct TransportResponse {
    /// Status code.
    pub status: u16,
    /// Headers (lowercase names).
    pub headers: Vec<(String, String)>,
    /// Body.
    pub body: Box<dyn ResponseBody>,
}

impl TransportResponse {
    /// Header lookup (case-insensitive).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// HTTP transport. Implementations MUST NOT follow redirects.
pub trait Transport: Send + Sync {
    /// Send one request. `Err` is a transport failure message.
    fn send(&self, req: TransportRequest) -> BoxFuture<'_, Result<TransportResponse, String>>;
}

/// Default transport: `reqwest` with `redirect::Policy::none()`.
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    /// Build the default transport.
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { client })
    }
}

struct ReqwestBody(reqwest::Response);

impl ResponseBody for ReqwestBody {
    fn read_capped(self: Box<Self>, max: usize) -> BoxFuture<'static, Result<Option<Vec<u8>>, String>> {
        let mut res = self.0;
        Box::pin(async move {
            let mut buf = Vec::new();
            while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
                if buf.len() + chunk.len() > max {
                    return Ok(None);
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(Some(buf))
        })
    }
}

impl Transport for ReqwestTransport {
    fn send(&self, req: TransportRequest) -> BoxFuture<'_, Result<TransportResponse, String>> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|e| e.to_string())?;
            let mut rb = self.client.request(method, &req.url).timeout(req.timeout);
            for (k, v) in &req.headers {
                rb = rb.header(k.as_str(), v.as_str());
            }
            if let Some(b) = req.body {
                rb = rb.body(b);
            }
            let res = rb.send().await.map_err(|e| e.to_string())?;
            let headers = res
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
                .collect();
            Ok(TransportResponse { status: res.status().as_u16(), headers, body: Box::new(ReqwestBody(res)) })
        })
    }
}
