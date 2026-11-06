//! Proxy gateway helpers: username/URL builder and the GET/HEAD fetch helper.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};

use crate::errors::{scrub_credentials, DominusNodeError, Result};
use crate::http::{AuthMode, Credentials, HttpClient};
use crate::ssrf::{assert_public_resolution, validate_target_url, Resolver, Target};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
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
    /// `https` when gateway TLS is configured, else `http`.
    #[default]
    Auto,
    /// HTTP proxy (CONNECT for https targets).
    Http,
    /// HTTPS proxy: TLS to the gateway (needs [`GatewayTls`]).
    Https,
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
    tls: Option<Arc<GatewayTlsInner>>,
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
        tls: Option<GatewayTls>,
    ) -> Result<Self> {
        let tls = match tls {
            None => None,
            Some(g) => Some(Arc::new(GatewayTlsInner::new(g)?)),
        };
        Ok(Self { http, creds, host, http_port, socks_port, resolver, tls })
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
        let (scheme, port) = match (protocol, &self.tls) {
            (ProxyProtocol::Auto, Some(t)) | (ProxyProtocol::Https, Some(t)) => ("https", t.port),
            (ProxyProtocol::Https, None) => {
                return Err(DominusNodeError::invalid_arg("protocol https needs the gateway_tls config"))
            }
            (ProxyProtocol::Auto, None) | (ProxyProtocol::Http, _) => ("http", self.http_port),
            (ProxyProtocol::Socks5, _) => ("socks5", self.socks_port),
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

        let method = match opts.method {
            FetchMethod::Get => "GET",
            FetchMethod::Head => "HEAD",
        };
        let auth = {
            use base64::Engine;
            format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{username}:{key}")))
        };
        let run = self.round_trip(&target, method, &headers, &auth, max_bytes);
        match tokio::time::timeout(Duration::from_millis(timeout_ms), run).await {
            Err(_) => Err(DominusNodeError::proxy(format!("Proxy request timed out after {timeout_ms}ms"), None)),
            Ok(Err(FetchFail::Proxy(e))) => Err(e),
            Ok(Err(FetchFail::Other(msg))) => {
                Err(DominusNodeError::proxy(scrub_credentials(&format!("Proxy request failed: {msg}")), None))
            }
            Ok(Ok(r)) => Ok(r),
        }
    }

    /// One request through the gateway on a fresh connection. https targets: `CONNECT`, then
    /// TLS to the target over THAT socket (never a direct dial). With gateway TLS the whole
    /// exchange runs inside a verified TLS session to the gateway (TLS-in-TLS for https).
    async fn round_trip(
        &self,
        target: &Target,
        method: &str,
        headers: &[(String, String)],
        auth: &str,
        max_bytes: usize,
    ) -> std::result::Result<ProxyFetchResponse, FetchFail> {
        let gw_host = self.host.trim_start_matches('[').trim_end_matches(']').to_string();
        let port = self.tls.as_ref().map(|t| t.port).unwrap_or(self.http_port);
        let tcp = TcpStream::connect((gw_host.as_str(), port)).await.map_err(FetchFail::other)?;
        let mut stream: Stream = Box::new(tcp);
        if let Some(t) = &self.tls {
            let name = t.servername.clone().unwrap_or_else(|| gw_host.clone());
            stream = Box::new(t.connector.connect(&name, stream).await.map_err(FetchFail::other)?);
        }
        let url = &target.url;
        let host_str = url.host_str().unwrap_or("").to_string();
        let host_header = match url.port() {
            Some(p) => format!("{host_str}:{p}"),
            None => host_str.clone(),
        };
        let mut req = String::new();
        if target.https {
            let authority = format!("{host_str}:{}", url.port().unwrap_or(443));
            let connect = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Authorization: {auth}\r\n\r\n");
            stream.write_all(connect.as_bytes()).await.map_err(FetchFail::other)?;
            let head = read_head_raw(&mut stream).await?;
            let status = parse_status(&head).map(|x| x.0).unwrap_or(0);
            if status != 200 {
                return Err(FetchFail::Proxy(DominusNodeError::proxy(
                    format!("Proxy refused CONNECT (HTTP {status})"),
                    if status == 0 { None } else { Some(status) },
                )));
            }
            let sni = host_str.trim_start_matches('[').trim_end_matches(']').to_string();
            let tc = target_connector().map_err(FetchFail::other)?;
            stream = Box::new(tc.connect(&sni, stream).await.map_err(FetchFail::other)?);
            let mut path = url.path().to_string();
            if let Some(q) = url.query() {
                path.push('?');
                path.push_str(q);
            }
            req.push_str(&format!("{method} {path} HTTP/1.1\r\nHost: {host_header}\r\n"));
        } else {
            let mut u = url.clone();
            u.set_fragment(None);
            req.push_str(&format!("{method} {u} HTTP/1.1\r\nHost: {host_header}\r\nProxy-Authorization: {auth}\r\n"));
        }
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("Connection: close\r\n\r\n");
        stream.write_all(req.as_bytes()).await.map_err(FetchFail::other)?;
        stream.flush().await.map_err(FetchFail::other)?;
        read_response(stream, method == "HEAD", max_bytes).await
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

/// TLS to the gateway's HTTPS proxy listener (`PROXY_TLS_PORT`), so `Proxy-Authorization`
/// is encrypted. Certificate verification is always on.
#[derive(Clone, Default)]
pub struct GatewayTls {
    /// Listener port (default 8443).
    pub port: Option<u32>,
    /// Extra PEM root certificate (added to the system roots) for the gateway only.
    pub ca_pem: Option<Vec<u8>>,
    /// TLS server name / verified name (default: `proxy_host`), e.g. when the host is an IP.
    pub servername: Option<String>,
}
impl fmt::Debug for GatewayTls {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GatewayTls")
            .field("port", &self.port)
            .field("ca_pem", &self.ca_pem.as_ref().map(|_| "<pem>"))
            .field("servername", &self.servername)
            .finish()
    }
}

/// Default gateway HTTPS proxy port.
pub const DEFAULT_TLS_PROXY_PORT: u32 = 8443;

struct GatewayTlsInner {
    port: u16,
    servername: Option<String>,
    connector: tokio_native_tls::TlsConnector,
}

impl GatewayTlsInner {
    fn new(g: GatewayTls) -> Result<Self> {
        let port = validate_port(g.port.unwrap_or(DEFAULT_TLS_PROXY_PORT), "gatewayTls.port")?;
        if let Some(sn) = &g.servername {
            let ok = (1..=253).contains(&sn.len()) && sn.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
            if !ok {
                return Err(DominusNodeError::invalid_arg("gatewayTls.servername is invalid"));
            }
        }
        let mut b = native_tls::TlsConnector::builder();
        b.min_protocol_version(Some(native_tls::Protocol::Tlsv12));
        if let Some(pem) = &g.ca_pem {
            let cert = native_tls::Certificate::from_pem(pem)
                .map_err(|_| DominusNodeError::invalid_arg("gatewayTls.ca must be a PEM certificate"))?;
            b.add_root_certificate(cert);
        }
        let c = b.build().map_err(|e| DominusNodeError::invalid_arg(format!("gatewayTls: {e}")))?;
        Ok(Self { port, servername: g.servername, connector: c.into() })
    }
}

fn target_connector() -> std::result::Result<tokio_native_tls::TlsConnector, native_tls::Error> {
    let mut b = native_tls::TlsConnector::builder();
    b.min_protocol_version(Some(native_tls::Protocol::Tlsv12));
    Ok(b.build()?.into())
}

trait AsyncIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncIo for T {}
type Stream = Box<dyn AsyncIo>;

enum FetchFail {
    Proxy(DominusNodeError),
    Other(String),
}
impl FetchFail {
    fn other(e: impl fmt::Display) -> Self {
        FetchFail::Other(e.to_string())
    }
}

const MAX_HEAD: usize = 64 * 1024;

/// Read a response head byte-by-byte (so nothing after it is consumed: the tunnel starts there).
async fn read_head_raw(s: &mut Stream) -> std::result::Result<Vec<u8>, FetchFail> {
    let mut buf = Vec::new();
    let mut b = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        let n = s.read(&mut b).await.map_err(FetchFail::other)?;
        if n == 0 {
            break;
        }
        buf.push(b[0]);
        if buf.len() > MAX_HEAD {
            return Err(FetchFail::Proxy(DominusNodeError::proxy("Proxy response header too large", None)));
        }
    }
    Ok(buf)
}

fn parse_status(head: &[u8]) -> Option<(u16, String)> {
    let line = head.split(|&b| b == b'\n').next()?;
    let line = String::from_utf8_lossy(line).trim_end().to_string();
    let mut it = line.splitn(3, ' ');
    let ver = it.next()?;
    if !ver.starts_with("HTTP/1.") {
        return None;
    }
    let code: u16 = it.next()?.parse().ok()?;
    Some((code, it.next().unwrap_or("").to_string()))
}

async fn read_response(stream: Stream, head_only: bool, max_bytes: usize) -> std::result::Result<ProxyFetchResponse, FetchFail> {
    let mut r = BufReader::new(stream);
    let mut head = Vec::new();
    loop {
        let mut line = Vec::new();
        let n = r.read_until(b'\n', &mut line).await.map_err(FetchFail::other)?;
        if n == 0 {
            return Err(FetchFail::Other("connection closed before the response head".into()));
        }
        head.extend_from_slice(&line);
        if head.len() > MAX_HEAD {
            return Err(FetchFail::Proxy(DominusNodeError::proxy("Proxy response header too large", None)));
        }
        if line == b"\r\n" || line == b"\n" {
            break;
        }
    }
    let (status, reason) = parse_status(&head).ok_or_else(|| FetchFail::Other("malformed HTTP response".into()))?;
    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    for l in String::from_utf8_lossy(&head).split("\r\n").skip(1) {
        if let Some((k, v)) = l.split_once(':') {
            let k = k.trim().to_ascii_lowercase();
            let v = v.trim().to_string();
            headers
                .entry(k)
                .and_modify(|e| {
                    e.push_str(", ");
                    e.push_str(&v);
                })
                .or_insert(v);
        }
    }
    let mut body = Vec::new();
    let mut truncated = false;
    let no_body = head_only || (100..200).contains(&status) || status == 204 || status == 304;
    if !no_body {
        let chunked = headers.get("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
        let length = headers.get("content-length").and_then(|v| v.parse::<u64>().ok());
        if chunked {
            loop {
                let mut line = String::new();
                if r.read_line(&mut line).await.map_err(FetchFail::other)? == 0 {
                    break;
                }
                let size = usize::from_str_radix(line.split(';').next().unwrap_or("").trim(), 16)
                    .map_err(|_| FetchFail::Other("malformed chunked body".into()))?;
                if size == 0 {
                    break;
                }
                if !take(&mut r, size as u64, &mut body, max_bytes, &mut truncated).await? || truncated {
                    break;
                }
                let mut crlf = String::new();
                let _ = r.read_line(&mut crlf).await;
            }
        } else if let Some(len) = length {
            take(&mut r, len, &mut body, max_bytes, &mut truncated).await?;
        } else {
            take(&mut r, u64::MAX, &mut body, max_bytes, &mut truncated).await?;
        }
    }
    Ok(ProxyFetchResponse { status, status_text: reason, headers, body, truncated })
}

/// Append up to `n` bytes (stopping at `max` total, setting `truncated` when more remain).
/// Returns false at EOF. A read error after some body (e.g. TLS without close_notify) ends it.
async fn take<R: AsyncRead + Unpin>(
    r: &mut R,
    n: u64,
    body: &mut Vec<u8>,
    max: usize,
    truncated: &mut bool,
) -> std::result::Result<bool, FetchFail> {
    let mut left = n;
    let mut buf = [0u8; 16 * 1024];
    while left > 0 {
        let want = buf.len().min(usize::try_from(left).unwrap_or(usize::MAX));
        let got = match r.read(&mut buf[..want]).await {
            Ok(0) => return Ok(false),
            Ok(g) => g,
            Err(e) if body.is_empty() && n != u64::MAX => return Err(FetchFail::other(e)),
            Err(_) => return Ok(false),
        };
        left -= got as u64;
        let room = max - body.len();
        if got > room {
            body.extend_from_slice(&buf[..room]);
            *truncated = true;
            return Ok(true);
        }
        body.extend_from_slice(&buf[..got]);
        if body.len() == max && left > 0 {
            let mut one = [0u8; 1];
            if let Ok(1) = r.read(&mut one).await {
                *truncated = true;
            }
            return Ok(true);
        }
    }
    Ok(true)
}
