use std::sync::Arc;

use crate::errors::Result;
use crate::http_client::HttpClient;
use crate::types::{DailyUsageResponse, TopHostsResponse, UsageResponse};

/// Options for date-range filtering.
#[derive(Debug, Default)]
pub struct DateRangeOptions {
    /// Start date (ISO 8601, e.g. `"2025-01-01"`). Maps to the `since` query parameter.
    pub from: Option<String>,
    /// End date (ISO 8601, e.g. `"2025-01-31"`). Maps to the `until` query parameter.
    pub to: Option<String>,
}

/// Options for the main usage endpoint (date range + pagination).
#[derive(Debug, Default)]
pub struct UsageOptions {
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
}

/// Options for the top-hosts endpoint (date range + limit).
#[derive(Debug, Default)]
pub struct TopHostsOptions {
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<u64>,
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

/// Usage data resource -- metered bandwidth, daily aggregations, top hosts, CSV export.
pub struct UsageResource {
    http: Arc<HttpClient>,
}

impl UsageResource {
    pub(crate) fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// Get detailed usage records with a summary and pagination.
    pub async fn get(&self, opts: Option<&UsageOptions>) -> Result<UsageResponse> {
        let qs = match opts {
            Some(o) => build_qs(&[
                ("since", o.from.clone()),
                ("until", o.to.clone()),
                ("limit", o.limit.map(|v| v.to_string())),
                ("offset", o.offset.map(|v| v.to_string())),
            ]),
            None => String::new(),
        };
        let path = format!("/api/usage{}", qs);
        self.http.get(&path, true).await
    }

    /// Get daily usage aggregation suitable for charting.
    pub async fn get_daily(&self, opts: Option<&DateRangeOptions>) -> Result<DailyUsageResponse> {
        let qs = match opts {
            Some(o) => build_qs(&[
                ("since", o.from.clone()),
                ("until", o.to.clone()),
            ]),
            None => String::new(),
        };
        let path = format!("/api/usage/daily{}", qs);
        self.http.get(&path, true).await
    }

    /// Get the top target hosts ranked by bandwidth consumption.
    pub async fn get_top_hosts(
        &self,
        opts: Option<&TopHostsOptions>,
    ) -> Result<TopHostsResponse> {
        let qs = match opts {
            Some(o) => build_qs(&[
                ("since", o.from.clone()),
                ("until", o.to.clone()),
                ("limit", o.limit.map(|v| v.to_string())),
            ]),
            None => String::new(),
        };
        let path = format!("/api/usage/top-hosts{}", qs);
        self.http.get(&path, true).await
    }

    /// Export usage records as a CSV string.
    pub async fn export_csv(&self, opts: Option<&DateRangeOptions>) -> Result<String> {
        let qs = match opts {
            Some(o) => build_qs(&[
                ("since", o.from.clone()),
                ("until", o.to.clone()),
            ]),
            None => String::new(),
        };
        let path = format!("/api/usage/export{}", qs);
        self.http.get_text(&path, true).await
    }
}
