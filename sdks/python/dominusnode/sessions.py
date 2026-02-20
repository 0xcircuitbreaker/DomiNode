"""Sessions resource -- active proxy sessions."""

from __future__ import annotations

from typing import List

from .http_client import AsyncHttpClient, SyncHttpClient
from .types import ActiveSession


# ──────────────────────────────────────────────────────────────────────
# Sync
# ──────────────────────────────────────────────────────────────────────


class SessionsResource:
    """Synchronous session operations."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def get_active(self) -> List[ActiveSession]:
        """Get currently active proxy sessions."""
        data = self._http.get("/api/sessions/active")
        return [
            ActiveSession(
                id=s["id"],
                started_at=str(s["startedAt"]),
                status=s.get("status", "active"),
            )
            for s in data.get("sessions", [])
        ]


# ──────────────────────────────────────────────────────────────────────
# Async
# ──────────────────────────────────────────────────────────────────────


class AsyncSessionsResource:
    """Asynchronous session operations."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def get_active(self) -> List[ActiveSession]:
        data = await self._http.get("/api/sessions/active")
        return [
            ActiveSession(
                id=s["id"],
                started_at=str(s["startedAt"]),
                status=s.get("status", "active"),
            )
            for s in data.get("sessions", [])
        ]
