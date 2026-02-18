"""JWT token management with auto-refresh.

Tokens are stored in memory only -- never written to disk.
JWT expiry is decoded from the base64 payload without cryptographic
verification (the server validates the signature).
"""

from __future__ import annotations

import asyncio
import base64
import json
import threading
import time
from typing import TYPE_CHECKING, Callable, Optional

from .constants import TOKEN_REFRESH_BUFFER_SECONDS

if TYPE_CHECKING:
    from typing import Awaitable


class TokenManager:
    """Sync token manager with threading.Lock for singleton refresh."""

    def __init__(self) -> None:
        self._access_token: Optional[str] = None
        self._refresh_token: Optional[str] = None
        self._refresh_lock = threading.Lock()
        self._refresh_fn: Optional[Callable[[str], tuple[str, str]]] = None

    def set_tokens(self, access_token: str, refresh_token: str) -> None:
        """Store a new token pair."""
        self._access_token = access_token
        self._refresh_token = refresh_token

    def set_refresh_fn(self, fn: Callable[[str], tuple[str, str]]) -> None:
        """Register the sync function that performs token refresh.

        The function receives the current refresh token and must return
        a (new_access_token, new_refresh_token) tuple.
        """
        self._refresh_fn = fn

    def clear(self) -> None:
        """Remove stored tokens."""
        self._access_token = None
        self._refresh_token = None

    @property
    def access_token(self) -> Optional[str]:
        return self._access_token

    @property
    def refresh_token(self) -> Optional[str]:
        return self._refresh_token

    @property
    def has_tokens(self) -> bool:
        return self._access_token is not None

    @property
    def has_refresh_token(self) -> bool:
        return self._refresh_token is not None

    def get_valid_token(self) -> Optional[str]:
        """Return a valid access token, refreshing if needed.

        Returns None if no tokens are available or refresh fails.
        """
        if self._access_token is None:
            return None

        if not is_expired(self._access_token):
            return self._access_token

        # Token expired or about to expire -- try refresh
        return self._do_refresh()

    def force_refresh(self) -> Optional[str]:
        """Force a token refresh regardless of expiry (e.g., after 401).

        R23 C-2: Raises RuntimeError if refresh fails instead of returning None,
        preventing "Bearer None" from being sent as an auth header.
        """
        return self._do_refresh(force=True)

    def _do_refresh(self, force: bool = False) -> Optional[str]:
        """Perform a singleton refresh under lock."""
        if self._refresh_token is None or self._refresh_fn is None:
            if force:
                raise RuntimeError("No valid token and cannot refresh")
            return None

        with self._refresh_lock:
            # Double-check: another thread may have refreshed while we waited
            # Skip double-check on force_refresh — the whole point is to NOT reuse current token
            if not force and self._access_token and not is_expired(self._access_token):
                return self._access_token

            try:
                new_access, new_refresh = self._refresh_fn(self._refresh_token)
                self._access_token = new_access
                self._refresh_token = new_refresh
                return self._access_token
            except Exception:
                self.clear()
                if force:
                    raise RuntimeError("Token refresh failed")
                return None


class AsyncTokenManager:
    """Async token manager with asyncio.Lock for singleton refresh.

    The lock is created lazily on first use to avoid binding to an event loop
    at __init__ time, which would fail if the TokenManager is constructed
    outside of an async context (e.g., in frameworks that manage their own
    event loops like FastAPI/uvicorn or Django ASGI).
    """

    def __init__(self) -> None:
        self._access_token: Optional[str] = None
        self._refresh_token: Optional[str] = None
        self._refresh_lock: Optional[asyncio.Lock] = None
        self._refresh_fn: Optional[Callable[[str], Awaitable[tuple[str, str]]]] = None

    def _get_lock(self) -> asyncio.Lock:
        """Lazily create the asyncio.Lock on first use within an async context."""
        if self._refresh_lock is None:
            self._refresh_lock = asyncio.Lock()
        return self._refresh_lock

    def set_tokens(self, access_token: str, refresh_token: str) -> None:
        """Store a new token pair."""
        self._access_token = access_token
        self._refresh_token = refresh_token

    def set_refresh_fn(self, fn: Callable[[str], Awaitable[tuple[str, str]]]) -> None:
        """Register the async function that performs token refresh."""
        self._refresh_fn = fn

    def clear(self) -> None:
        """Remove stored tokens."""
        self._access_token = None
        self._refresh_token = None

    @property
    def access_token(self) -> Optional[str]:
        return self._access_token

    @property
    def refresh_token(self) -> Optional[str]:
        return self._refresh_token

    @property
    def has_tokens(self) -> bool:
        return self._access_token is not None

    @property
    def has_refresh_token(self) -> bool:
        return self._refresh_token is not None

    async def get_valid_token(self) -> Optional[str]:
        """Return a valid access token, refreshing if needed."""
        if self._access_token is None:
            return None

        if not is_expired(self._access_token):
            return self._access_token

        return await self._do_refresh()

    async def force_refresh(self) -> Optional[str]:
        """Force a token refresh regardless of expiry (e.g., after 401).

        R23 C-2: Raises RuntimeError if refresh fails instead of returning None.
        """
        return await self._do_refresh(force=True)

    async def _do_refresh(self, force: bool = False) -> Optional[str]:
        """Perform a singleton refresh under async lock."""
        if self._refresh_token is None or self._refresh_fn is None:
            if force:
                raise RuntimeError("No valid token and cannot refresh")
            return None

        async with self._get_lock():
            # Skip double-check on force_refresh
            if not force and self._access_token and not is_expired(self._access_token):
                return self._access_token

            try:
                new_access, new_refresh = await self._refresh_fn(self._refresh_token)
                self._access_token = new_access
                self._refresh_token = new_refresh
                return self._access_token
            except Exception:
                self.clear()
                if force:
                    raise RuntimeError("Token refresh failed")
                return None


def is_expired(token: str) -> bool:
    """Check if a JWT is expired or will expire within the buffer window.

    Decodes the base64 payload to read the ``exp`` claim. No signature
    verification is performed -- that is the server's responsibility.

    Returns True if the token is expired / about to expire, or if the
    token cannot be decoded.
    """
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return True

        # Base64url decode the payload (second segment)
        payload_b64 = parts[1]
        # Add padding
        padding = 4 - len(payload_b64) % 4
        if padding != 4:
            payload_b64 += "=" * padding

        payload_bytes = base64.urlsafe_b64decode(payload_b64)
        payload = json.loads(payload_bytes)

        exp = payload.get("exp")
        if exp is None:
            return True

        return time.time() >= (exp - TOKEN_REFRESH_BUFFER_SECONDS)
    except Exception:
        return True
