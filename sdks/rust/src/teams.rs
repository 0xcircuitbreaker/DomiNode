use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::errors::Result;
use crate::http_client::{encode_uri_component, HttpClient};

#[derive(Debug, Deserialize)]
pub struct Team {
    pub id: String,
    pub name: String,
    #[serde(rename = "ownerId")]
    pub owner_id: String,
    #[serde(rename = "maxMembers")]
    pub max_members: i32,
    #[serde(rename = "balanceCents")]
    pub balance_cents: i64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct TeamMember {
    #[serde(rename = "userId")]
    pub user_id: String,
    pub email: String,
    pub role: String,
    #[serde(rename = "joinedAt")]
    pub joined_at: String,
}

#[derive(Debug, Deserialize)]
pub struct TeamInvite {
    pub id: String,
    #[serde(rename = "teamId")]
    pub team_id: String,
    pub email: String,
    pub role: String,
    pub token: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct TeamTransaction {
    pub id: String,
    #[serde(rename = "teamId")]
    pub team_id: String,
    #[serde(rename = "type")]
    pub tx_type: String,
    #[serde(rename = "amountCents")]
    pub amount_cents: i64,
    pub description: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct TeamKey {
    pub id: String,
    #[serde(rename = "keyPrefix")]
    pub key_prefix: String,
    pub label: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct TeamKeyCreateResponse {
    pub id: String,
    pub key: String,
    #[serde(rename = "keyPrefix")]
    pub key_prefix: String,
    pub label: String,
}

#[derive(Debug, Deserialize)]
pub struct TeamDeleteResponse {
    #[serde(rename = "refundedCents")]
    pub refunded_cents: i64,
}

#[derive(Debug, Deserialize)]
pub struct TeamFundResponse {
    pub transaction: TeamTransaction,
}

#[derive(Debug, Deserialize)]
pub struct TeamTransactionsResponse {
    pub transactions: Vec<TeamTransaction>,
}

#[derive(Debug, Deserialize)]
pub struct TeamMembersResponse {
    pub members: Vec<TeamMember>,
}

#[derive(Debug, Deserialize)]
pub struct TeamInvitesResponse {
    pub invites: Vec<TeamInvite>,
}

#[derive(Debug, Deserialize)]
pub struct TeamKeysResponse {
    pub keys: Vec<TeamKey>,
}

// ─── Request Bodies ─────────────────────────────────────────────────────

#[derive(Serialize)]
struct CreateTeamBody<'a> {
    name: &'a str,
    #[serde(rename = "maxMembers", skip_serializing_if = "Option::is_none")]
    max_members: Option<i32>,
}

#[derive(Serialize)]
struct UpdateTeamBody<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(rename = "maxMembers", skip_serializing_if = "Option::is_none")]
    max_members: Option<i32>,
}

#[derive(Serialize)]
struct FundBody {
    #[serde(rename = "amountCents")]
    amount_cents: i64,
}

#[derive(Serialize)]
struct AddMemberBody<'a> {
    email: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<&'a str>,
}

#[derive(Serialize)]
struct UpdateRoleBody<'a> {
    role: &'a str,
}

#[derive(Serialize)]
struct CreateInviteBody<'a> {
    email: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<&'a str>,
}

#[derive(Serialize)]
struct CreateKeyBody<'a> {
    label: &'a str,
}

/// Team operations -- team management with shared wallet, members, invites, and API keys.
pub struct TeamsResource {
    http: Arc<HttpClient>,
}

impl TeamsResource {
    pub(crate) fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// Create a new team.
    pub async fn create(&self, name: &str, max_members: Option<i32>) -> Result<Team> {
        self.http
            .post(
                "/api/teams",
                Some(&CreateTeamBody { name, max_members }),
                true,
            )
            .await
    }

    /// List all teams the authenticated user belongs to.
    pub async fn list(&self) -> Result<Vec<Team>> {
        self.http.get("/api/teams", true).await
    }

    /// Get a single team by ID.
    pub async fn get(&self, team_id: &str) -> Result<Team> {
        self.http
            .get(&format!("/api/teams/{}", encode_uri_component(team_id)), true)
            .await
    }

    /// Update a team's settings.
    pub async fn update(
        &self,
        team_id: &str,
        name: Option<&str>,
        max_members: Option<i32>,
    ) -> Result<Team> {
        self.http
            .patch(
                &format!("/api/teams/{}", encode_uri_component(team_id)),
                Some(&UpdateTeamBody { name, max_members }),
                true,
            )
            .await
    }

    /// Delete a team and refund remaining wallet balance.
    pub async fn delete(&self, team_id: &str) -> Result<TeamDeleteResponse> {
        self.http
            .delete(&format!("/api/teams/{}", encode_uri_component(team_id)))
            .await
    }

    /// Fund the team wallet from the user's main wallet.
    pub async fn fund_wallet(&self, team_id: &str, amount_cents: i64) -> Result<TeamFundResponse> {
        if amount_cents <= 0 || amount_cents > 2_147_483_647 {
            return Err(crate::errors::DominusNodeError::Validation(
                "amountCents must be a positive integer <= 2,147,483,647".to_string(),
            ));
        }
        self.http
            .post(
                &format!("/api/teams/{}/wallet/fund", encode_uri_component(team_id)),
                Some(&FundBody { amount_cents }),
                true,
            )
            .await
    }

    /// Get wallet transaction history for a team.
    pub async fn get_transactions(
        &self,
        team_id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<TeamTransactionsResponse> {
        self.http
            .get(
                &format!(
                    "/api/teams/{}/wallet/transactions?limit={}&offset={}",
                    encode_uri_component(team_id),
                    limit,
                    offset
                ),
                true,
            )
            .await
    }

    /// List all members of a team.
    pub async fn list_members(&self, team_id: &str) -> Result<TeamMembersResponse> {
        self.http
            .get(
                &format!("/api/teams/{}/members", encode_uri_component(team_id)),
                true,
            )
            .await
    }

    /// Add a member to a team.
    pub async fn add_member(
        &self,
        team_id: &str,
        email: &str,
        role: Option<&str>,
    ) -> Result<TeamMember> {
        self.http
            .post(
                &format!("/api/teams/{}/members", encode_uri_component(team_id)),
                Some(&AddMemberBody { email, role }),
                true,
            )
            .await
    }

    /// Update a member's role within a team.
    pub async fn update_member_role(
        &self,
        team_id: &str,
        user_id: &str,
        role: &str,
    ) -> Result<TeamMember> {
        self.http
            .patch(
                &format!(
                    "/api/teams/{}/members/{}",
                    encode_uri_component(team_id),
                    encode_uri_component(user_id)
                ),
                Some(&UpdateRoleBody { role }),
                true,
            )
            .await
    }

    /// Remove a member from a team.
    pub async fn remove_member(&self, team_id: &str, user_id: &str) -> Result<()> {
        let _: serde_json::Value = self
            .http
            .delete(&format!(
                "/api/teams/{}/members/{}",
                encode_uri_component(team_id),
                encode_uri_component(user_id)
            ))
            .await?;
        Ok(())
    }

    /// Create an invite for a team.
    pub async fn create_invite(
        &self,
        team_id: &str,
        email: &str,
        role: Option<&str>,
    ) -> Result<TeamInvite> {
        self.http
            .post(
                &format!("/api/teams/{}/invites", encode_uri_component(team_id)),
                Some(&CreateInviteBody { email, role }),
                true,
            )
            .await
    }

    /// List pending invites for a team.
    pub async fn list_invites(&self, team_id: &str) -> Result<TeamInvitesResponse> {
        self.http
            .get(
                &format!("/api/teams/{}/invites", encode_uri_component(team_id)),
                true,
            )
            .await
    }

    /// Cancel a pending team invite.
    pub async fn cancel_invite(&self, team_id: &str, invite_id: &str) -> Result<()> {
        let _: serde_json::Value = self
            .http
            .delete(&format!(
                "/api/teams/{}/invites/{}",
                encode_uri_component(team_id),
                encode_uri_component(invite_id)
            ))
            .await?;
        Ok(())
    }

    /// Accept a team invite using the invite token.
    pub async fn accept_invite(&self, token: &str) -> Result<TeamMember> {
        let empty: Option<&()> = None;
        self.http
            .post(
                &format!("/api/teams/invites/{}/accept", encode_uri_component(token)),
                empty,
                true,
            )
            .await
    }

    /// Create a new API key for the team.
    pub async fn create_key(&self, team_id: &str, label: &str) -> Result<TeamKeyCreateResponse> {
        self.http
            .post(
                &format!("/api/teams/{}/keys", encode_uri_component(team_id)),
                Some(&CreateKeyBody { label }),
                true,
            )
            .await
    }

    /// List all API keys for a team.
    pub async fn list_keys(&self, team_id: &str) -> Result<TeamKeysResponse> {
        self.http
            .get(
                &format!("/api/teams/{}/keys", encode_uri_component(team_id)),
                true,
            )
            .await
    }

    /// Revoke a team API key by its ID.
    pub async fn revoke_key(&self, team_id: &str, key_id: &str) -> Result<()> {
        let _: serde_json::Value = self
            .http
            .delete(&format!(
                "/api/teams/{}/keys/{}",
                encode_uri_component(team_id),
                encode_uri_component(key_id)
            ))
            .await?;
        Ok(())
    }
}
