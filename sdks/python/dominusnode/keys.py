"""API key management resource."""

from __future__ import annotations

from typing import List, Optional
from urllib.parse import quote

from .http_client import AsyncHttpClient, SyncHttpClient
from .types import ApiKey, CreatedApiKey


# ──────────────────────────────────────────────────────────────────────
# Sync
# ──────────────────────────────────────────────────────────────────────


class KeysResource:
    """Synchronous API key operations."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def create(self, label: str = "Default") -> CreatedApiKey:
        """Create a new API key. The raw key is only returned once."""
        data = self._http.post("/api/keys", json={"label": label})
        return CreatedApiKey(
            key=data["key"],
            id=data["id"],
            prefix=data["prefix"],
            label=data["label"],
            created_at=str(data["created_at"]),
        )

    def list(self) -> List[ApiKey]:
        """List all API keys for the current user."""
        data = self._http.get("/api/keys")
        return [
            ApiKey(
                id=k["id"],
                prefix=k["prefix"],
                label=k["label"],
                created_at=str(k["created_at"]),
                revoked_at=str(k["revoked_at"]) if k.get("revoked_at") else None,
            )
            for k in data.get("keys", [])
        ]

    def revoke(self, key_id: str) -> None:
        """Revoke an API key by ID."""
        self._http.delete(f"/api/keys/{quote(key_id, safe='')}")


# ──────────────────────────────────────────────────────────────────────
# Async
# ──────────────────────────────────────────────────────────────────────


class AsyncKeysResource:
    """Asynchronous API key operations."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def create(self, label: str = "Default") -> CreatedApiKey:
        data = await self._http.post("/api/keys", json={"label": label})
        return CreatedApiKey(
            key=data["key"],
            id=data["id"],
            prefix=data["prefix"],
            label=data["label"],
            created_at=str(data["created_at"]),
        )

    async def list(self) -> List[ApiKey]:
        data = await self._http.get("/api/keys")
        return [
            ApiKey(
                id=k["id"],
                prefix=k["prefix"],
                label=k["label"],
                created_at=str(k["created_at"]),
                revoked_at=str(k["revoked_at"]) if k.get("revoked_at") else None,
            )
            for k in data.get("keys", [])
        ]

    async def revoke(self, key_id: str) -> None:
        await self._http.delete(f"/api/keys/{quote(key_id, safe='')}")
