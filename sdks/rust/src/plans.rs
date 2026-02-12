use std::sync::Arc;

use serde::Serialize;

use crate::errors::Result;
use crate::http_client::HttpClient;
use crate::types::{ChangePlanResponse, ListPlansResponse, UserPlanResponse};

#[derive(Serialize)]
struct ChangePlanBody<'a> {
    #[serde(rename = "planId")]
    plan_id: &'a str,
}

/// Billing plan resource.
pub struct PlansResource {
    http: Arc<HttpClient>,
}

impl PlansResource {
    pub(crate) fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// List all available plans. Does **not** require authentication.
    pub async fn list(&self) -> Result<ListPlansResponse> {
        self.http.get("/api/plans", false).await
    }

    /// Get the authenticated user's current plan and monthly usage.
    pub async fn get_user_plan(&self) -> Result<UserPlanResponse> {
        self.http.get("/api/plans/user/plan", true).await
    }

    /// Switch the authenticated user to a different plan.
    pub async fn change_plan(&self, plan_id: &str) -> Result<ChangePlanResponse> {
        self.http
            .put("/api/plans/user/plan", Some(&ChangePlanBody { plan_id }))
            .await
    }
}
