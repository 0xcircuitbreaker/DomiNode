"""Slots and waitlist resource -- check registration availability and join waitlist."""

from __future__ import annotations

from .http_client import AsyncHttpClient, SyncHttpClient
from .types import SlotsInfo, WaitlistCount, WaitlistJoinResult


class SlotsResource:
    """Synchronous slots and waitlist operations."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def get_slots(self) -> SlotsInfo:
        """Check available registration slots."""
        data = self._http.get("/api/slots", requires_auth=False)
        return SlotsInfo(
            total=data["total"],
            used=data["used"],
            remaining=data["remaining"],
            unlimited=data["unlimited"],
        )

    def join_waitlist(self, email: str) -> WaitlistJoinResult:
        """Join the waitlist when registration slots are full."""
        data = self._http.post("/api/waitlist/join", json={"email": email}, requires_auth=False)
        return WaitlistJoinResult(message=data.get("message", ""))

    def get_waitlist_count(self) -> WaitlistCount:
        """Get the number of people on the waitlist."""
        data = self._http.get("/api/waitlist/count", requires_auth=False)
        return WaitlistCount(pending=data["pending"])


class AsyncSlotsResource:
    """Asynchronous slots and waitlist operations."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def get_slots(self) -> SlotsInfo:
        """Check available registration slots."""
        data = await self._http.get("/api/slots", requires_auth=False)
        return SlotsInfo(
            total=data["total"],
            used=data["used"],
            remaining=data["remaining"],
            unlimited=data["unlimited"],
        )

    async def join_waitlist(self, email: str) -> WaitlistJoinResult:
        """Join the waitlist when registration slots are full."""
        data = await self._http.post("/api/waitlist/join", json={"email": email}, requires_auth=False)
        return WaitlistJoinResult(message=data.get("message", ""))

    async def get_waitlist_count(self) -> WaitlistCount:
        """Get the number of people on the waitlist."""
        data = await self._http.get("/api/waitlist/count", requires_auth=False)
        return WaitlistCount(pending=data["pending"])
