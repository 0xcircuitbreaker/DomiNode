"""Teams resource -- team management with members, invites, wallet, and API keys."""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from urllib.parse import quote

from .http_client import AsyncHttpClient, SyncHttpClient
from .types import (
    Team,
    TeamMember,
    TeamInvite,
    TeamTransaction,
    TeamKey,
    TeamKeyCreateResponse,
    TeamDeleteResponse,
)


def _parse_team(data: Dict[str, Any]) -> Team:
    return Team(
        id=data["id"],
        name=data["name"],
        owner_id=data["ownerId"],
        max_members=data.get("maxMembers", 0),
        balance_cents=data.get("balanceCents", 0),
        created_at=data.get("createdAt", ""),
    )


def _parse_member(data: Dict[str, Any]) -> TeamMember:
    return TeamMember(
        user_id=data["userId"],
        email=data["email"],
        role=data["role"],
        joined_at=data.get("joinedAt", ""),
    )


def _parse_invite(data: Dict[str, Any]) -> TeamInvite:
    return TeamInvite(
        id=data["id"],
        team_id=data["teamId"],
        email=data["email"],
        role=data["role"],
        token=data.get("token", ""),
        expires_at=data.get("expiresAt", ""),
        created_at=data.get("createdAt", ""),
    )


def _parse_transaction(data: Dict[str, Any]) -> TeamTransaction:
    return TeamTransaction(
        id=data["id"],
        team_id=data["teamId"],
        type=data["type"],
        amount_cents=data["amountCents"],
        description=data["description"],
        created_at=data.get("createdAt", ""),
    )


def _parse_key(data: Dict[str, Any]) -> TeamKey:
    return TeamKey(
        id=data["id"],
        key_prefix=data["keyPrefix"],
        label=data["label"],
        created_at=data.get("createdAt", ""),
    )


class TeamsResource:
    """Synchronous team operations."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def create(self, name: str, max_members: Optional[int] = None) -> Team:
        """Create a new team."""
        body: Dict[str, Any] = {"name": name}
        if max_members is not None:
            body["maxMembers"] = max_members
        data = self._http.post("/api/teams", json=body)
        return _parse_team(data)

    def list(self) -> List[Team]:
        """List all teams the user belongs to."""
        data = self._http.get("/api/teams")
        return [_parse_team(t) for t in data]

    def get(self, team_id: str) -> Team:
        """Get a single team by ID."""
        data = self._http.get(f"/api/teams/{quote(team_id, safe='')}")
        return _parse_team(data)

    def update(self, team_id: str, name: Optional[str] = None, max_members: Optional[int] = None) -> Team:
        """Update a team's settings."""
        body: Dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if max_members is not None:
            body["maxMembers"] = max_members
        data = self._http.patch(f"/api/teams/{quote(team_id, safe='')}", json=body)
        return _parse_team(data)

    def delete(self, team_id: str) -> TeamDeleteResponse:
        """Delete a team and refund remaining wallet balance."""
        data = self._http.delete(f"/api/teams/{quote(team_id, safe='')}")
        return TeamDeleteResponse(refunded_cents=data["refundedCents"])

    def fund_wallet(self, team_id: str, amount_cents: int) -> TeamTransaction:
        """Fund the team wallet from the user's main wallet."""
        data = self._http.post(
            f"/api/teams/{quote(team_id, safe='')}/wallet/fund",
            json={"amountCents": amount_cents},
        )
        return _parse_transaction(data["transaction"])

    def get_transactions(self, team_id: str, limit: int = 50, offset: int = 0) -> List[TeamTransaction]:
        """Get wallet transaction history for a team."""
        data = self._http.get(
            f"/api/teams/{quote(team_id, safe='')}/wallet/transactions?limit={limit}&offset={offset}"
        )
        return [_parse_transaction(tx) for tx in data["transactions"]]

    def list_members(self, team_id: str) -> List[TeamMember]:
        """List all members of a team."""
        data = self._http.get(f"/api/teams/{quote(team_id, safe='')}/members")
        return [_parse_member(m) for m in data["members"]]

    def add_member(self, team_id: str, email: str, role: Optional[str] = None) -> TeamMember:
        """Add a member to a team."""
        body: Dict[str, Any] = {"email": email}
        if role is not None:
            body["role"] = role
        data = self._http.post(f"/api/teams/{quote(team_id, safe='')}/members", json=body)
        return _parse_member(data)

    def update_member_role(self, team_id: str, user_id: str, role: str) -> TeamMember:
        """Update a member's role within a team."""
        data = self._http.patch(
            f"/api/teams/{quote(team_id, safe='')}/members/{quote(user_id, safe='')}",
            json={"role": role},
        )
        return _parse_member(data)

    def remove_member(self, team_id: str, user_id: str) -> None:
        """Remove a member from a team."""
        self._http.delete(
            f"/api/teams/{quote(team_id, safe='')}/members/{quote(user_id, safe='')}"
        )

    def create_invite(self, team_id: str, email: str, role: Optional[str] = None) -> TeamInvite:
        """Create an invite for a team."""
        body: Dict[str, Any] = {"email": email}
        if role is not None:
            body["role"] = role
        data = self._http.post(f"/api/teams/{quote(team_id, safe='')}/invites", json=body)
        return _parse_invite(data)

    def list_invites(self, team_id: str) -> List[TeamInvite]:
        """List pending invites for a team."""
        data = self._http.get(f"/api/teams/{quote(team_id, safe='')}/invites")
        return [_parse_invite(i) for i in data["invites"]]

    def cancel_invite(self, team_id: str, invite_id: str) -> None:
        """Cancel a pending invite."""
        self._http.delete(
            f"/api/teams/{quote(team_id, safe='')}/invites/{quote(invite_id, safe='')}"
        )

    def accept_invite(self, token: str) -> TeamMember:
        """Accept a team invite using the invite token."""
        data = self._http.post(
            f"/api/teams/invites/{quote(token, safe='')}/accept", json={}
        )
        return _parse_member(data)

    def create_key(self, team_id: str, label: str) -> TeamKeyCreateResponse:
        """Create a new API key for the team."""
        data = self._http.post(
            f"/api/teams/{quote(team_id, safe='')}/keys",
            json={"label": label},
        )
        return TeamKeyCreateResponse(
            id=data["id"],
            key=data["key"],
            key_prefix=data["keyPrefix"],
            label=data["label"],
        )

    def list_keys(self, team_id: str) -> List[TeamKey]:
        """List API keys for a team."""
        data = self._http.get(f"/api/teams/{quote(team_id, safe='')}/keys")
        return [_parse_key(k) for k in data["keys"]]

    def revoke_key(self, team_id: str, key_id: str) -> None:
        """Revoke a team API key by its ID."""
        self._http.delete(
            f"/api/teams/{quote(team_id, safe='')}/keys/{quote(key_id, safe='')}"
        )


class AsyncTeamsResource:
    """Asynchronous team operations."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def create(self, name: str, max_members: Optional[int] = None) -> Team:
        """Create a new team."""
        body: Dict[str, Any] = {"name": name}
        if max_members is not None:
            body["maxMembers"] = max_members
        data = await self._http.post("/api/teams", json=body)
        return _parse_team(data)

    async def list(self) -> List[Team]:
        """List all teams the user belongs to."""
        data = await self._http.get("/api/teams")
        return [_parse_team(t) for t in data]

    async def get(self, team_id: str) -> Team:
        """Get a single team by ID."""
        data = await self._http.get(f"/api/teams/{quote(team_id, safe='')}")
        return _parse_team(data)

    async def update(self, team_id: str, name: Optional[str] = None, max_members: Optional[int] = None) -> Team:
        """Update a team's settings."""
        body: Dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if max_members is not None:
            body["maxMembers"] = max_members
        data = await self._http.patch(f"/api/teams/{quote(team_id, safe='')}", json=body)
        return _parse_team(data)

    async def delete(self, team_id: str) -> TeamDeleteResponse:
        """Delete a team and refund remaining wallet balance."""
        data = await self._http.delete(f"/api/teams/{quote(team_id, safe='')}")
        return TeamDeleteResponse(refunded_cents=data["refundedCents"])

    async def fund_wallet(self, team_id: str, amount_cents: int) -> TeamTransaction:
        """Fund the team wallet from the user's main wallet."""
        data = await self._http.post(
            f"/api/teams/{quote(team_id, safe='')}/wallet/fund",
            json={"amountCents": amount_cents},
        )
        return _parse_transaction(data["transaction"])

    async def get_transactions(self, team_id: str, limit: int = 50, offset: int = 0) -> List[TeamTransaction]:
        """Get wallet transaction history for a team."""
        data = await self._http.get(
            f"/api/teams/{quote(team_id, safe='')}/wallet/transactions?limit={limit}&offset={offset}"
        )
        return [_parse_transaction(tx) for tx in data["transactions"]]

    async def list_members(self, team_id: str) -> List[TeamMember]:
        """List all members of a team."""
        data = await self._http.get(f"/api/teams/{quote(team_id, safe='')}/members")
        return [_parse_member(m) for m in data["members"]]

    async def add_member(self, team_id: str, email: str, role: Optional[str] = None) -> TeamMember:
        """Add a member to a team."""
        body: Dict[str, Any] = {"email": email}
        if role is not None:
            body["role"] = role
        data = await self._http.post(f"/api/teams/{quote(team_id, safe='')}/members", json=body)
        return _parse_member(data)

    async def update_member_role(self, team_id: str, user_id: str, role: str) -> TeamMember:
        """Update a member's role within a team."""
        data = await self._http.patch(
            f"/api/teams/{quote(team_id, safe='')}/members/{quote(user_id, safe='')}",
            json={"role": role},
        )
        return _parse_member(data)

    async def remove_member(self, team_id: str, user_id: str) -> None:
        """Remove a member from a team."""
        await self._http.delete(
            f"/api/teams/{quote(team_id, safe='')}/members/{quote(user_id, safe='')}"
        )

    async def create_invite(self, team_id: str, email: str, role: Optional[str] = None) -> TeamInvite:
        """Create an invite for a team."""
        body: Dict[str, Any] = {"email": email}
        if role is not None:
            body["role"] = role
        data = await self._http.post(f"/api/teams/{quote(team_id, safe='')}/invites", json=body)
        return _parse_invite(data)

    async def list_invites(self, team_id: str) -> List[TeamInvite]:
        """List pending invites for a team."""
        data = await self._http.get(f"/api/teams/{quote(team_id, safe='')}/invites")
        return [_parse_invite(i) for i in data["invites"]]

    async def cancel_invite(self, team_id: str, invite_id: str) -> None:
        """Cancel a pending invite."""
        await self._http.delete(
            f"/api/teams/{quote(team_id, safe='')}/invites/{quote(invite_id, safe='')}"
        )

    async def accept_invite(self, token: str) -> TeamMember:
        """Accept a team invite using the invite token."""
        data = await self._http.post(
            f"/api/teams/invites/{quote(token, safe='')}/accept", json={}
        )
        return _parse_member(data)

    async def create_key(self, team_id: str, label: str) -> TeamKeyCreateResponse:
        """Create a new API key for the team."""
        data = await self._http.post(
            f"/api/teams/{quote(team_id, safe='')}/keys",
            json={"label": label},
        )
        return TeamKeyCreateResponse(
            id=data["id"],
            key=data["key"],
            key_prefix=data["keyPrefix"],
            label=data["label"],
        )

    async def list_keys(self, team_id: str) -> List[TeamKey]:
        """List API keys for a team."""
        data = await self._http.get(f"/api/teams/{quote(team_id, safe='')}/keys")
        return [_parse_key(k) for k in data["keys"]]

    async def revoke_key(self, team_id: str, key_id: str) -> None:
        """Revoke a team API key by its ID."""
        await self._http.delete(
            f"/api/teams/{quote(team_id, safe='')}/keys/{quote(key_id, safe='')}"
        )
