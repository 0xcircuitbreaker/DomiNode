use std::sync::Arc;

use crate::errors::Result;
use crate::http_client::HttpClient;
use crate::types::{ProxyConfig, ProxyHealthResponse, ProxyStatusResponse, ProxyUrlOptions};

/// Percent-encode a URI component (RFC 3986 unreserved characters pass through).
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

/// Proxy gateway resource -- URL building, health checks, configuration.
pub struct ProxyResource {
    http: Arc<HttpClient>,
    proxy_host: String,
    http_port: u16,
    socks5_port: u16,
}

impl ProxyResource {
    pub(crate) fn new(
        http: Arc<HttpClient>,
        proxy_host: String,
        http_port: u16,
        socks5_port: u16,
    ) -> Self {
        Self {
            http,
            proxy_host,
            http_port,
            socks5_port,
        }
    }

    /// Build a fully-formed proxy URL string for use with HTTP clients.
    ///
    /// The returned URL includes authentication via the username/password fields.
    /// Geo-targeting and sticky sessions are encoded in the username portion
    /// following PacketStream conventions.
    ///
    /// This is a pure computation -- no network call is made.
    ///
    /// # Examples
    ///
    /// ```
    /// use dominode::types::ProxyUrlOptions;
    ///
    /// // These examples show the format; in practice you'd use the client's
    /// // proxy resource which is pre-configured with host/port.
    /// let opts_default = ProxyUrlOptions::default();
    /// let opts_socks = ProxyUrlOptions {
    ///     protocol: Some("socks5".to_string()),
    ///     country: Some("US".to_string()),
    ///     ..Default::default()
    /// };
    /// ```
    pub fn build_url(&self, api_key: &str, opts: Option<&ProxyUrlOptions>) -> String {
        let protocol = opts
            .and_then(|o| o.protocol.as_deref())
            .unwrap_or("http");
        let port = if protocol == "socks5" {
            self.socks5_port
        } else {
            self.http_port
        };

        let mut user_parts: Vec<String> = vec!["user".to_string()];

        if let Some(ref o) = opts {
            if let Some(ref country) = o.country {
                user_parts.push(format!("country_{}", encode_uri_component(country)));
            }
            if let Some(ref state) = o.state {
                user_parts.push(format!("state_{}", encode_uri_component(state)));
            }
            if let Some(ref city) = o.city {
                user_parts.push(format!("city_{}", encode_uri_component(city)));
            }
            if let Some(asn) = o.asn {
                user_parts.push(format!("asn_{}", asn));
            }
            if let Some(ref session_id) = o.session_id {
                user_parts.push(format!("session_{}", encode_uri_component(session_id)));
            }
        }

        let username = user_parts.join("-");
        format!(
            "{}://{}:{}@{}:{}",
            protocol, username, encode_uri_component(api_key), self.proxy_host, port
        )
    }

    /// Get public proxy health status. Does **not** require authentication.
    pub async fn get_health(&self) -> Result<ProxyHealthResponse> {
        self.http.get("/api/proxy/health", false).await
    }

    /// Get detailed proxy status including provider information.
    /// Requires authentication.
    pub async fn get_status(&self) -> Result<ProxyStatusResponse> {
        self.http.get("/api/proxy/status", true).await
    }

    /// Get proxy server configuration. Requires authentication.
    pub async fn get_config(&self) -> Result<ProxyConfig> {
        self.http.get("/api/proxy/config", true).await
    }
}
