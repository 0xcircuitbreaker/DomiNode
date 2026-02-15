"""HTTP client wrappers for sync and async usage.

Handles:
- User-Agent injection
- Authorization header from token manager
- Automatic retry on 429 (once)
- Status-code-to-exception mapping
"""

from __future__ import annotations

import asyncio
import random
import time
from typing import Any, Dict, Optional

import httpx

from .constants import USER_AGENT
from .errors import (
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    DominusNodeError,
    InsufficientBalanceError,
    NetworkError,
    NotFoundError,
    RateLimitError,
    ServerError,
    ValidationError,
)
from .token_manager import AsyncTokenManager, TokenManager


def _extract_error_message(response: httpx.Response) -> str:
    """Try to extract an error message from the JSON body."""
    try:
        body = response.json()
        if isinstance(body, dict):
            return body.get("error", response.reason_phrase or "Unknown error")
    except Exception:
        pass
    return response.reason_phrase or f"HTTP {response.status_code}"


def _raise_for_status(response: httpx.Response) -> None:
    """Map HTTP status codes to SDK exceptions."""
    status = response.status_code
    if 200 <= status < 300:
        return

    msg = _extract_error_message(response)

    if status == 400:
        raise ValidationError(msg)
    if status == 401:
        raise AuthenticationError(msg)
    if status == 402:
        raise InsufficientBalanceError(msg)
    if status == 403:
        raise AuthorizationError(msg)
    if status == 404:
        raise NotFoundError(msg)
    if status == 409:
        raise ConflictError(msg)
    if status == 429:
        retry_after = 60
        ra_header = response.headers.get("retry-after")
        if ra_header:
            try:
                retry_after = int(ra_header)
            except ValueError:
                pass
        raise RateLimitError(msg, retry_after_seconds=retry_after)
    if status >= 500:
        raise ServerError(msg, status_code=status)

    raise DominusNodeError(msg, status_code=status)


def _parse_retry_after(response: httpx.Response) -> float:
    """Parse Retry-After header, defaulting to 1 second."""
    ra = response.headers.get("retry-after")
    if ra:
        try:
            return max(float(ra), 0.1)
        except ValueError:
            pass
    return 1.0


def _add_jitter(seconds: float) -> float:
    """Add ±10% jitter to prevent thundering-herd on rate-limited endpoints (R15 H-5)."""
    jitter = seconds * 0.2 * (random.random() - 0.5)
    return max(0.1, seconds + jitter)


# ──────────────────────────────────────────────────────────────────────
# Sync HTTP Client
# ──────────────────────────────────────────────────────────────────────


class SyncHttpClient:
    """Synchronous HTTP client wrapping httpx.Client."""

    def __init__(
        self,
        base_url: str,
        token_manager: TokenManager,
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token_manager = token_manager
        self._client = httpx.Client(
            base_url=self._base_url,
            timeout=timeout,
            headers={"User-Agent": USER_AGENT},
            follow_redirects=False,  # R17: Prevent HTTPS→HTTP credential leakage
        )

    def close(self) -> None:
        self._client.close()

    def _build_headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        headers: Dict[str, str] = {}
        token = self._token_manager.get_valid_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if extra:
            headers.update(extra)
        return headers

    def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> httpx.Response:
        """Execute an HTTP request with auto-retry on 401 (token refresh) and 429."""
        merged_headers = self._build_headers(headers)
        try:
            response = self._client.request(
                method,
                path,
                json=json,
                params=params,
                headers=merged_headers,
            )
        except httpx.HTTPError as exc:
            raise NetworkError(str(exc)) from exc

        # Auto-retry once on 401 after force-refreshing the token (R12 H-3)
        if response.status_code == 401 and self._token_manager.has_refresh_token:
            self._token_manager.force_refresh()
            merged_headers = self._build_headers(headers)
            try:
                response = self._client.request(
                    method,
                    path,
                    json=json,
                    params=params,
                    headers=merged_headers,
                )
            except httpx.HTTPError as exc:
                raise NetworkError(str(exc)) from exc

        # Auto-retry once on 429
        if response.status_code == 429:
            wait = _parse_retry_after(response)
            time.sleep(_add_jitter(min(wait, 10.0)))  # Cap at 10s + jitter
            # R16 P16-C: Rebuild headers to get fresh token in case it expired during wait
            merged_headers = self._build_headers(headers)
            try:
                response = self._client.request(
                    method,
                    path,
                    json=json,
                    params=params,
                    headers=merged_headers,
                )
            except httpx.HTTPError as exc:
                raise NetworkError(str(exc)) from exc

        _raise_for_status(response)
        return response

    def get(self, path: str, *, params: Optional[Dict[str, Any]] = None) -> Any:
        resp = self.request("GET", path, params=params)
        if resp.status_code == 204:
            return None
        return resp.json()

    def post(self, path: str, *, json: Any = None, params: Optional[Dict[str, Any]] = None) -> Any:
        resp = self.request("POST", path, json=json, params=params)
        if resp.status_code == 204:
            return None
        return resp.json()

    def put(self, path: str, *, json: Any = None, params: Optional[Dict[str, Any]] = None) -> Any:
        resp = self.request("PUT", path, json=json, params=params)
        if resp.status_code == 204:
            return None
        return resp.json()

    def delete(self, path: str, *, params: Optional[Dict[str, Any]] = None) -> Any:
        resp = self.request("DELETE", path, params=params)
        if resp.status_code == 204:
            return None
        return resp.json()

    def get_raw(self, path: str, *, params: Optional[Dict[str, Any]] = None) -> httpx.Response:
        """Return the raw httpx.Response (for CSV export, etc.)."""
        return self.request("GET", path, params=params)


# ──────────────────────────────────────────────────────────────────────
# Async HTTP Client
# ──────────────────────────────────────────────────────────────────────


class AsyncHttpClient:
    """Asynchronous HTTP client wrapping httpx.AsyncClient."""

    def __init__(
        self,
        base_url: str,
        token_manager: AsyncTokenManager,
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token_manager = token_manager
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=timeout,
            headers={"User-Agent": USER_AGENT},
            follow_redirects=False,  # R17: Prevent HTTPS→HTTP credential leakage
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _build_headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        headers: Dict[str, str] = {}
        token = await self._token_manager.get_valid_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if extra:
            headers.update(extra)
        return headers

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> httpx.Response:
        """Execute an HTTP request with auto-retry on 401 (token refresh) and 429."""
        merged_headers = await self._build_headers(headers)
        try:
            response = await self._client.request(
                method,
                path,
                json=json,
                params=params,
                headers=merged_headers,
            )
        except httpx.HTTPError as exc:
            raise NetworkError(str(exc)) from exc

        # Auto-retry once on 401 after force-refreshing the token (R13 C-3)
        if response.status_code == 401 and self._token_manager.has_refresh_token:
            await self._token_manager.force_refresh()
            merged_headers = await self._build_headers(headers)
            try:
                response = await self._client.request(
                    method,
                    path,
                    json=json,
                    params=params,
                    headers=merged_headers,
                )
            except httpx.HTTPError as exc:
                raise NetworkError(str(exc)) from exc

        # Auto-retry once on 429
        if response.status_code == 429:
            wait = _parse_retry_after(response)
            await asyncio.sleep(_add_jitter(min(wait, 10.0)))
            # R16 P16-C: Rebuild headers to get fresh token in case it expired during wait
            merged_headers = await self._build_headers(headers)
            try:
                response = await self._client.request(
                    method,
                    path,
                    json=json,
                    params=params,
                    headers=merged_headers,
                )
            except httpx.HTTPError as exc:
                raise NetworkError(str(exc)) from exc

        _raise_for_status(response)
        return response

    async def get(self, path: str, *, params: Optional[Dict[str, Any]] = None) -> Any:
        resp = await self.request("GET", path, params=params)
        if resp.status_code == 204:
            return None
        return resp.json()

    async def post(self, path: str, *, json: Any = None, params: Optional[Dict[str, Any]] = None) -> Any:
        resp = await self.request("POST", path, json=json, params=params)
        if resp.status_code == 204:
            return None
        return resp.json()

    async def put(self, path: str, *, json: Any = None, params: Optional[Dict[str, Any]] = None) -> Any:
        resp = await self.request("PUT", path, json=json, params=params)
        if resp.status_code == 204:
            return None
        return resp.json()

    async def delete(self, path: str, *, params: Optional[Dict[str, Any]] = None) -> Any:
        resp = await self.request("DELETE", path, params=params)
        if resp.status_code == 204:
            return None
        return resp.json()

    async def get_raw(self, path: str, *, params: Optional[Dict[str, Any]] = None) -> httpx.Response:
        """Return the raw httpx.Response (for CSV export, etc.)."""
        return await self.request("GET", path, params=params)
