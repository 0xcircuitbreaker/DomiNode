use std::sync::Arc;

use serde::Serialize;

use crate::errors::Result;
use crate::http_client::HttpClient;
use crate::types::{SlotsInfo, WaitlistCount, WaitlistJoinResult};

#[derive(Serialize)]
struct JoinWaitlistBody<'a> {
    email: &'a str,
}

/// Slot availability and waitlist operations.
/// All methods are public (no authentication required).
pub struct SlotsResource {
    http: Arc<HttpClient>,
}

impl SlotsResource {
    pub(crate) fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// Check available registration slots.
    pub async fn get_slots(&self) -> Result<SlotsInfo> {
        self.http.get("/api/slots", false).await
    }

    /// Join the waitlist when registration slots are full.
    pub async fn join_waitlist(&self, email: &str) -> Result<WaitlistJoinResult> {
        self.http
            .post("/api/waitlist/join", Some(&JoinWaitlistBody { email }), false)
            .await
    }

    /// Get the number of people on the waitlist.
    pub async fn get_waitlist_count(&self) -> Result<WaitlistCount> {
        self.http.get("/api/waitlist/count", false).await
    }
}
