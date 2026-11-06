"""JWT access/refresh pair holders (internal). clear() keeps the refresh callback."""

from __future__ import annotations

import asyncio
import base64
import json
import threading
import time
from typing import Awaitable, Callable, Optional, Tuple

from .constants import TOKEN_REFRESH_BUFFER_SECONDS
from .errors import AuthenticationError

#: refresh_token -> (access_token, new_refresh_token or None)
RefreshResult = Tuple[str, Optional[str]]


def is_expired(token: str) -> bool:
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return True
        seg = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(seg))
        exp = payload.get("exp") if isinstance(payload, dict) else None
        if not isinstance(exp, (int, float)) or isinstance(exp, bool):
            return True
        return exp < time.time() + TOKEN_REFRESH_BUFFER_SECONDS
    except Exception:
        return True


class _BaseTokenManager:
    def __init__(self) -> None:
        self._access: Optional[str] = None
        self._refresh: Optional[str] = None

    def set_tokens(self, access: str, refresh: Optional[str] = None) -> None:
        self._access = access
        if refresh:
            self._refresh = refresh

    @property
    def access_token(self) -> Optional[str]:
        return self._access

    @property
    def refresh_token(self) -> Optional[str]:
        return self._refresh

    def has_tokens(self) -> bool:
        return self._access is not None or self._refresh is not None

    def _clear_tokens(self) -> None:
        self._access = None
        self._refresh = None

    def __repr__(self) -> str:
        return f"{type(self).__name__}([REDACTED])"

    __str__ = __repr__

    def to_json(self) -> str:
        return "[REDACTED]"


class TokenManager(_BaseTokenManager):
    def __init__(self) -> None:
        super().__init__()
        self._refresh_fn: Optional[Callable[[str], RefreshResult]] = None
        self._lock = threading.Lock()

    def set_refresh_function(self, fn: Callable[[str], RefreshResult]) -> None:
        self._refresh_fn = fn

    def has_refresh_function(self) -> bool:
        return self._refresh_fn is not None

    def get_valid_token(self) -> str:
        if self._access and not is_expired(self._access):
            return self._access
        return self.force_refresh()

    def force_refresh(self) -> str:
        """Refresh regardless of expiry. Concurrent callers share one refresh (lock + re-check)."""
        before = self._access
        with self._lock:
            if self._access is not None and self._access != before and not is_expired(self._access):
                return self._access  # another thread refreshed while we waited
            if not self._refresh or not self._refresh_fn:
                raise AuthenticationError("No valid token and cannot refresh")
            try:
                access, refresh = self._refresh_fn(self._refresh)
            except Exception:
                self._clear_tokens()
                raise
            self._access = access
            if refresh:
                self._refresh = refresh
            return access

    def clear(self) -> None:
        """Drop tokens. Does NOT drop the refresh function (reconnecting must keep working)."""
        self._clear_tokens()


class AsyncTokenManager(_BaseTokenManager):
    def __init__(self) -> None:
        super().__init__()
        self._refresh_fn: Optional[Callable[[str], Awaitable[RefreshResult]]] = None
        self._inflight: Optional["asyncio.Future[str]"] = None

    def set_refresh_function(self, fn: Callable[[str], Awaitable[RefreshResult]]) -> None:
        self._refresh_fn = fn

    def has_refresh_function(self) -> bool:
        return self._refresh_fn is not None

    async def get_valid_token(self) -> str:
        if self._access and not is_expired(self._access):
            return self._access
        return await self.force_refresh()

    async def force_refresh(self) -> str:
        if self._inflight is not None:
            return await asyncio.shield(self._inflight)
        if not self._refresh or not self._refresh_fn:
            raise AuthenticationError("No valid token and cannot refresh")
        fut: "asyncio.Future[str]" = asyncio.get_running_loop().create_future()
        self._inflight = fut
        try:
            access, refresh = await self._refresh_fn(self._refresh)
            self._access = access
            if refresh:
                self._refresh = refresh
            fut.set_result(access)
            return access
        except BaseException as err:
            self._clear_tokens()
            fut.set_exception(err)
            fut.exception()  # mark retrieved
            raise
        finally:
            if self._inflight is fut:
                self._inflight = None

    def clear(self) -> None:
        self._clear_tokens()
        self._inflight = None
