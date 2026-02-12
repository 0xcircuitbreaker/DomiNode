use std::sync::Arc;

use crate::errors::Result;
use crate::http_client::HttpClient;
use crate::types::{
    DailyRevenueResponse, GetUserResponse, ListUsersResponse, MessageResponse, RevenueResponse,
    SystemStats,
};

/// Options for date-range filtering on admin endpoints.
#[derive(Debug, Default)]
pub struct DateRangeOptions {
    /// Start date (ISO 8601).
    pub since: Option<String>,
    /// End date (ISO 8601).
    pub until: Option<String>,
}

/// Options for the list-users endpoint.
#[derive(Debug, Default)]
pub struct ListUsersOptions {
    pub page: Option<u64>,
    pub limit: Option<u64>,
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

/// URL-encode a query parameter value (RFC 3986 unreserved characters pass through).
fn url_encode_qs(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
                String::from(b as char)
            } else {
                format!("%{:02X}", b)
            }
        })
        .collect()
}

/// Build a query-string from key-value pairs, skipping `None` values.
fn build_qs(pairs: &[(&str, Option<String>)]) -> String {
    let parts: Vec<String> = pairs
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|val| format!("{}={}", k, url_encode_qs(val))))
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

/// Administrative resource -- user management, revenue, system statistics.
///
/// All methods in this resource require admin-level authentication.
pub struct AdminResource {
    http: Arc<HttpClient>,
}

impl AdminResource {
    pub(crate) fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// List all users with pagination.
    pub async fn list_users(
        &self,
        opts: Option<&ListUsersOptions>,
    ) -> Result<ListUsersResponse> {
        let qs = match opts {
            Some(o) => build_qs(&[
                ("page", o.page.map(|v| v.to_string())),
                ("limit", o.limit.map(|v| v.to_string())),
            ]),
            None => String::new(),
        };
        let path = format!("/api/admin/users{}", qs);
        self.http.get(&path, true).await
    }

    /// Get detailed information for a specific user.
    pub async fn get_user(&self, id: &str) -> Result<GetUserResponse> {
        let path = format!("/api/admin/users/{}", encode_uri_component(id));
        self.http.get(&path, true).await
    }

    /// Suspend a user account.
    pub async fn suspend_user(&self, id: &str) -> Result<MessageResponse> {
        let path = format!(
            "/api/admin/users/{}/suspend",
            encode_uri_component(id)
        );
        self.http.put::<MessageResponse, ()>(&path, None).await
    }

    /// Reactivate a suspended user account.
    pub async fn activate_user(&self, id: &str) -> Result<MessageResponse> {
        let path = format!(
            "/api/admin/users/{}/activate",
            encode_uri_component(id)
        );
        self.http.put::<MessageResponse, ()>(&path, None).await
    }

    /// Soft-delete a user account.
    pub async fn delete_user(&self, id: &str) -> Result<MessageResponse> {
        let path = format!("/api/admin/users/{}", encode_uri_component(id));
        self.http.delete(&path).await
    }

    /// Get revenue statistics for a date range.
    pub async fn get_revenue(
        &self,
        opts: Option<&DateRangeOptions>,
    ) -> Result<RevenueResponse> {
        let qs = match opts {
            Some(o) => build_qs(&[
                ("since", o.since.clone()),
                ("until", o.until.clone()),
            ]),
            None => String::new(),
        };
        let path = format!("/api/admin/revenue{}", qs);
        self.http.get(&path, true).await
    }

    /// Get daily revenue breakdown for a date range.
    pub async fn get_daily_revenue(
        &self,
        opts: Option<&DateRangeOptions>,
    ) -> Result<DailyRevenueResponse> {
        let qs = match opts {
            Some(o) => build_qs(&[
                ("since", o.since.clone()),
                ("until", o.until.clone()),
            ]),
            None => String::new(),
        };
        let path = format!("/api/admin/revenue/daily{}", qs);
        self.http.get(&path, true).await
    }

    /// Get system-wide statistics (active sessions, total users, total bandwidth).
    pub async fn get_stats(&self) -> Result<SystemStats> {
        self.http.get("/api/admin/stats", true).await
    }
}
