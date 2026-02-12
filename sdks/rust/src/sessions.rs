use std::sync::Arc;

use crate::errors::Result;
use crate::http_client::HttpClient;
use crate::types::ActiveSessionsResponse;

/// Active proxy session resource.
pub struct SessionsResource {
    http: Arc<HttpClient>,
}

impl SessionsResource {
    pub(crate) fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// Get all active proxy sessions for the authenticated user.
    pub async fn get_active(&self) -> Result<ActiveSessionsResponse> {
        self.http.get("/api/sessions/active", true).await
    }
}
