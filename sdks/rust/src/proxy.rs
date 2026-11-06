//! Proxy gateway helpers: username/URL builder and the GET/HEAD fetch helper.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};

use crate::errors::{scrub_credentials, DominusNodeError, Result};
use crate::http::{AuthMode, Credentials, HttpClient};
use crate::ssrf::{assert_public_resolution, validate_target_url, Resolver};
use crate::types::ProxyHealth;
use crate::util::{encode_uri_component, is_uuid, validate_api_key, MAX_RESPONSE_BYTES};

/// OFAC-sanctioned countries that cannot be targeted.
pub const OFAC_BLOCKED: [&str; 5] = ["CU", "IR", "KP", "RU", "SY"];

/// Exit IP class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpClass {
    /// Residential.
    Residential,
    /// Datacenter.
    Dc,
    /// Mobile.
    Mobile,
}
impl IpClass {
    /// Wire name.
    pub fn as_str(&self) -> &'static str {
        match self {
            IpClass::Residential => "residential",
            IpClass::Dc => "dc",
            IpClass::Mobile => "mobile",
        }
    }
}

/// Gateway routing flags (encoded into the proxy username).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProxyRoutingOptions {
    /// ISO alpha-2 exit country -> `country-XX`.
    pub country: Option<String>,
    /// Exit IP class -> `class-<c>`.
    pub ip_class: Option<IpClass>,
    /// Sticky session (1-64 alphanumeric) -> `session-<id>`.
    pub session_id: Option<String>,
    /// Agentic wallet UUID -> `wallet-<uuid>`.
    pub agentic_wallet_id: Option<String>,
    /// Opt in to plaintext http:// -> `allowhttp-1`.
    pub allow_http: bool,
}

/// Build the gateway username (`relay` when no flags).
pub fn build_proxy_username(o: &ProxyRoutingOptions) -> Result<String> {
    let mut parts = Vec::new();
    if let Some(c) = &o.country {
        if c.len() != 2 || !c.bytes().all(|b| b.is_ascii_alphabetic()) {
            return Err(DominusNodeError::invalid_arg("country must be a 2-letter ISO code"));
        }
        let c = c.to_ascii_uppercase();
        if OFAC_BLOCKED.contains(&c.as_str()) {
            return Err(DominusNodeError::invalid_arg(format!("country {c} is sanctioned (OFAC) and cannot be targeted")));
        }
        parts.push(format!("country-{c}"));
    }
    if let Some(cl) = o.ip_class {
        parts.push(format!("class-{}", cl.as_str()));
    }
    if let Some(s) = &o.session_id {
        if s.is_empty() || s.len() > 64 || !s.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(DominusNodeError::invalid_arg("sessionId must be 1-64 alphanumeric characters"));
        }
        parts.push(format!("session-{s}"));
    }
    if let Some(w) = &o.agentic_wallet_id {
        if !is_uuid(w) {
            return Err(DominusNodeError::invalid_arg("agenticWalletId must be a UUID"));
        }
        parts.push(format!("wallet-{}", w.to_lowercase()));
    }
    if o.allow_http {
        parts.push("allowhttp-1".to_string());
    }
    Ok(if parts.is_empty() { "relay".to_string() } else { parts.join("-") })
}

/// Proxy protocol for [`ProxyResource::build_url`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ProxyProtocol {
    /// HTTP proxy (CONNECT for https targets).
    #[default]
    Http,
    /// SOCKS5.
    Socks5,
}

/// HTTP method for `fetch` (GET or HEAD only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FetchMethod {
    /// GET.
    #[default]
    Get,
    /// HEAD.
    Head,
}

/// Options for [`ProxyResource::fetch`].
#[derive(Clone, Default)]
pub struct ProxyFetchOptions {
    /// Routing flags.
    pub routing: ProxyRoutingOptions,
    /// GET (default) or HEAD.
    pub method: FetchMethod,
    /// Extra request headers.
    pub headers: Vec<(String, String)>,
    /// Default 30,000 ms, clamped to 1..120,000.
    pub timeout_ms: Option<u64>,
    /// Body cap; default and maximum 10 MB.
    pub max_bytes: Option<usize>,
    /// Override the connected API key.
    pub api_key: Option<String>,
}
impl fmt::Debug for ProxyFetchOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProxyFetchOptions")
            .field("routing", &self.routing)
            .field("method", &self.method)
            .field("timeout_ms", &self.timeout_ms)
            .field("max_bytes", &self.max_bytes)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

/// Result of [`ProxyResource::fetch`].
#[derive(Debug, Clone)]
pub struct ProxyFetchResponse {
    /// Status code (3xx returned as-is).
    pub status: u16,
    /// Reason phrase.
    pub status_text: String,
    /// Headers (lowercase names; repeated values joined with `, `).
    pub headers: BTreeMap<String, String>,
    /// Body bytes (at most `max_bytes`).
    pub body: Vec<u8>,
    /// True when the body was cut at `max_bytes`.
    pub truncated: bool,
}
impl ProxyFetchResponse {
    /// Body decoded as UTF-8 (lossy).
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

const FORBIDDEN_HEADERS: [&str; 12] = [
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "proxy-authorization",
    "proxy-connection",
    "authorization",
    "upgrade",
    "te",
    "trailer",
    "keep-alive",
    "",
];

fn is_token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&b)
}

fn clean_headers(h: &[(String, String)]) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    for (k, v) in h {
        let bad = |s: &str| s.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0);
        if k.is_empty() || bad(k) || bad(v) || !k.bytes().all(is_token_char) {
            let shown: String = k.chars().take(40).collect();
            return Err(DominusNodeError::invalid_arg(format!("header \"{shown}\" contains invalid characters")));
        }
        if !FORBIDDEN_HEADERS.contains(&k.to_ascii_lowercase().as_str()) {
            out.push((k.clone(), v.clone()));
        }
    }
    Ok(out)
}

/// Proxy gateway helpers. The API key goes in the PASSWORD; routing flags in the USERNAME.
#[derive(Clone)]
pub struct ProxyResource {
    http: Arc<HttpClient>,
    creds: Arc<Credentials>,
    host: String,
    http_port: u16,
    socks_port: u16,
    resolver: Resolver,
}

impl fmt::Debug for ProxyResource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ProxyResource({}:{})", self.host, self.http_port)
    }
}

/// Validate a proxy host: `[A-Za-z0-9.-]{1,253}` or bracketed IPv6.
pub(crate) fn validate_proxy_host(h: &str) -> Result<()> {
    let plain = (1..=253).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    let v6 = h.len() > 2
        && h.starts_with('[')
        && h.ends_with(']')
        && h[1..h.len() - 1].bytes().all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.');
    if plain || v6 {
        Ok(())
    } else {
        Err(DominusNodeError::invalid_arg("proxyHost contains invalid characters"))
    }
}

pub(crate) fn validate_port(p: u32, name: &str) -> Result<u16> {
    if (1..=65535).contains(&p) {
        Ok(p as u16)
    } else {
        Err(DominusNodeError::invalid_arg(format!("{name} must be a TCP port")))
    }
}

impl ProxyResource {
    pub(crate) fn new(
        http: Arc<HttpClient>,
        creds: Arc<Credentials>,
        host: String,
        http_port: u16,
        socks_port: u16,
        resolver: Resolver,
    ) -> Self {
        Self { http, creds, host, http_port, socks_port, resolver }
    }

    fn key(&self, over: Option<&str>) -> Result<String> {
        let k = match over {
            Some(k) => k.to_string(),
            None => self
                .creds
                .api_key()
                .ok_or_else(|| DominusNodeError::auth("proxy access needs an API key: call connect_with_key() or pass api_key"))?,
        };
        validate_api_key(&k)?;
        Ok(k)
    }

    /// Gateway username (`relay` when no flags).
    pub fn build_username(&self, opts: &ProxyRoutingOptions) -> Result<String> {
        build_proxy_username(opts)
    }

    /// `<protocol>://<user>:<key>@<proxyHost>:<port>`. The result CONTAINS the key: do not log it.
    pub fn build_url(&self, opts: &ProxyRoutingOptions, protocol: ProxyProtocol, api_key: Option<&str>) -> Result<String> {
        let user = build_proxy_username(opts)?;
        let key = self.key(api_key)?;
        let (scheme, port) = match protocol {
            ProxyProtocol::Http => ("http", self.http_port),
            ProxyProtocol::Socks5 => ("socks5", self.socks_port),
        };
        Ok(format!("{scheme}://{}:{}@{}:{port}", encode_uri_component(&user), encode_uri_component(&key), self.host))
    }

    /// GET/HEAD `url` through the relay. Ports 80/443 only; private/local targets and names
    /// resolving to private addresses are refused; redirects are returned, not followed;
    /// body capped at `max_bytes` (<= 10 MB); `http://` needs `allow_http`.
    pub async fn fetch(&self, url: &str, opts: ProxyFetchOptions) -> Result<ProxyFetchResponse> {
        let key = self.key(opts.api_key.as_deref())?;
        let target = validate_target_url(url)?;
        if !target.https && !opts.routing.allow_http {
            return Err(DominusNodeError::invalid_arg(
                "plaintext http:// requires allow_http (the exit node can read and modify it); prefer https://",
            ));
        }
        let username = build_proxy_username(&opts.routing)?;
        let headers = clean_headers(&opts.headers)?;
        let timeout_ms = opts.timeout_ms.unwrap_or(30_000).clamp(1, 120_000);
        let max_bytes = opts.max_bytes.unwrap_or(MAX_RESPONSE_BYTES).clamp(1, MAX_RESPONSE_BYTES);
        assert_public_resolution(&target.host, &self.resolver).await?;

        let fail = |e: reqwest::Error| -> DominusNodeError {
            if e.is_timeout() {
                return DominusNodeError::proxy(format!("Proxy request timed out after {timeout_ms}ms"), None);
            }
            let mut msg = e.to_string();
            let mut src: Option<&dyn std::error::Error> = std::error::Error::source(&e);
            while let Some(s) = src {
                msg.push_str(": ");
                msg.push_str(&s.to_string());
                src = s.source();
            }
            if msg.contains("tunnel") {
                return DominusNodeError::proxy(scrub_credentials(&format!("Proxy refused CONNECT: {msg}")), None);
            }
            DominusNodeError::proxy(scrub_credentials(&format!("Proxy request failed: {msg}")), None)
        };

        let proxy = reqwest::Proxy::all(format!("http://{}:{}", self.host, self.http_port))
            .map_err(fail)?
            .basic_auth(&username, &key);
        let client = reqwest::Client::builder()
            .proxy(proxy)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_millis(timeout_ms))
            .min_tls_version(reqwest::tls::Version::TLS_1_2)
            .http1_only()
            .build()
            .map_err(fail)?;
        let method = match opts.method {
            FetchMethod::Get => reqwest::Method::GET,
            FetchMethod::Head => reqwest::Method::HEAD,
        };
        let mut rb = client.request(method, target.url.clone()).header("Connection", "close");
        for (k, v) in &headers {
            rb = rb.header(k.as_str(), v.as_str());
        }
        let mut res = rb.send().await.map_err(fail)?;
        let status = res.status();
        let mut out_headers: BTreeMap<String, String> = BTreeMap::new();
        for (k, v) in res.headers() {
            let v = String::from_utf8_lossy(v.as_bytes()).into_owned();
            out_headers.entry(k.as_str().to_string()).and_modify(|e| {
                e.push_str(", ");
                e.push_str(&v);
            }).or_insert(v);
        }
        let mut body = Vec::new();
        let mut truncated = false;
        if opts.method == FetchMethod::Get {
            while let Some(chunk) = res.chunk().await.map_err(fail)? {
                if body.len() + chunk.len() > max_bytes {
                    body.extend_from_slice(&chunk[..max_bytes - body.len()]);
                    truncated = true;
                    break;
                }
                body.extend_from_slice(&chunk);
            }
        }
        drop(res);
        Ok(ProxyFetchResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_string(),
            headers: out_headers,
            body,
            truncated,
        })
    }

    /// `GET /api/proxy/health` [none].
    pub async fn get_health(&self) -> Result<ProxyHealth> {
        self.http.get("/api/proxy/health", AuthMode::None).await
    }

    /// `GET /api/proxy/config` [jwt].
    pub async fn get_config(&self) -> Result<Map<String, Value>> {
        self.http.get("/api/proxy/config", AuthMode::Jwt).await
    }
}
