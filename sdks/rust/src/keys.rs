use std::sync::Arc;

use serde::Serialize;

use crate::errors::Result;
use crate::http_client::HttpClient;
use crate::types::{CreateKeyResponse, ListKeysResponse};

#[derive(Serialize)]
struct CreateKeyBody<'a> {
    label: &'a str,
}

/// Percent-encode a URI path segment (RFC 3986 unreserved characters pass through).
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

/// API key management resource.
pub struct KeysResource {
    http: Arc<HttpClient>,
}

impl KeysResource {
    pub(crate) fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// Create a new API key. The raw key value is returned only once in the
    /// response and must be stored by the caller.
    pub async fn create(&self, label: Option<&str>) -> Result<CreateKeyResponse> {
        let label = label.unwrap_or("Default");
        self.http
            .post("/api/keys", Some(&CreateKeyBody { label }), true)
            .await
    }

    /// List all API keys for the authenticated user. Revoked keys include a
    /// `revoked_at` timestamp.
    pub async fn list(&self) -> Result<ListKeysResponse> {
        self.http.get("/api/keys", true).await
    }

    /// Revoke an API key by its ID. The key becomes immediately unusable.
    pub async fn revoke(&self, id: &str) -> Result<()> {
        let path = format!("/api/keys/{}", encode_uri_component(id));
        let _: serde_json::Value = self.http.delete(&path).await?;
        Ok(())
    }
}
