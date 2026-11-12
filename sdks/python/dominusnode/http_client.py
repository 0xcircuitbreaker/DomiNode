"""HTTP layer (internal): auth modes, no redirects, 10 MB cap, 429 retry, 401 refresh, error mapping."""

from __future__ import annotations

import asyncio
import json
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional, Union
from urllib.parse import urlsplit

import httpx

from .constants import (
    MAX_RATE_LIMIT_RETRIES,
    MAX_RESPONSE_BYTES,
    MAX_RETRY_WAIT_SECONDS,
    MIN_RETRY_WAIT_SECONDS,
    REQUEST_TIMEOUT_SECONDS,
    USER_AGENT,
)
from .errors import (
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    Details,
    DominusNodeError,
    InsufficientBalanceError,
    NetworkError,
    NotFoundError,
    RateLimitError,
    ServerError,
    ValidationError,
    invalid_arg,
    scrub_credentials,
)
from .token_manager import AsyncTokenManager, TokenManager

DANGEROUS_KEYS = frozenset({"__proto__", "constructor", "prototype"})
_NO_BODY = object()


def strip_dangerous_keys(obj: Any, depth: int = 0) -> Any:
    """Recursively delete ``__proto__``/``constructor``/``prototype`` keys (depth limit 50)."""
    if depth > 50:
        return obj
    if isinstance(obj, dict):
        for k in list(obj.keys()):
            if k in DANGEROUS_KEYS:
                del obj[k]
            else:
                strip_dangerous_keys(obj[k], depth + 1)
    elif isinstance(obj, list):
        for item in obj:
            strip_dangerous_keys(item, depth + 1)
    return obj


def safe_json_loads(text: str) -> Any:
    return strip_dangerous_keys(json.loads(text))


def retry_delay_seconds(retry_after_seconds: float, rand: Callable[[], float] = random.random) -> float:
    """min(retry_after, 10s), +/-10% jitter, floor 100ms."""
    base = min(max(float(retry_after_seconds), 0.0), MAX_RETRY_WAIT_SECONDS)
    jitter = base * 0.2 * (rand() - 0.5)
    return max(MIN_RETRY_WAIT_SECONDS, round(base + jitter, 3))


def _parse_retry_after(value: Optional[str], fallback: int) -> int:
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        return fallback
    return n if n >= 0 else fallback


def raise_for_status(status: int, body: str, headers: Any) -> None:
    message = body
    code: Optional[str] = None
    details: Optional[Details] = None
    try:
        parsed = safe_json_loads(body)
        if isinstance(parsed, dict):
            m = parsed.get("error", parsed.get("message"))
            if isinstance(m, str):
                message = m
            if isinstance(parsed.get("code"), str):
                code = parsed["code"]
            elif parsed.get("mfaRequired") is True:
                code = "MFA_REQUIRED"
            for k in ("max", "cap", "limitPerDay"):
                v = parsed.get(k)
                if isinstance(v, (int, float, str)) and not isinstance(v, bool):
                    details = details or {}
                    details[k] = v
    except ValueError:
        pass
    if not message:
        message = f"HTTP {status}"
    if len(message) > 500:
        message = message[:500] + "... [truncated]"
    if status == 400:
        raise ValidationError(message, 400, code, details)
    if status == 401:
        raise AuthenticationError(message, code, details)
    if status == 402:
        raise InsufficientBalanceError(message, code, details)
    if status == 403:
        raise AuthorizationError(message, code, details)
    if status == 404:
        raise NotFoundError(message, code, details)
    if status == 409:
        raise ConflictError(message, code, details)
    if status == 429:
        raise RateLimitError(message, _parse_retry_after(headers.get("retry-after"), 60), code, details)
    if status >= 500:
        raise ServerError(message, status, code, details)
    raise DominusNodeError(message, status, code, details)


@dataclass
class Request:
    """One API call. ``auth``: "jwt" | "agent" | "none"."""

    method: str
    path: str
    body: Any = _NO_BODY
    auth: str = "jwt"
    headers: Dict[str, str] = field(default_factory=dict)
    raw: bool = False


def _validate_base_url(base_url: str) -> str:
    try:
        u = urlsplit(base_url)
    except (ValueError, TypeError):
        raise ValidationError("base_url is not a valid URL", None) from None
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValidationError("base_url must be http(s)", None)
    if "@" in u.netloc:
        raise ValidationError("base_url must not contain credentials", None)
    return base_url.rstrip("/")


def _headers(req: Request, bearer: Optional[str]) -> Dict[str, str]:
    h = {"User-Agent": USER_AGENT, "Accept": "application/json", **req.headers}
    if req.body is not _NO_BODY:
        h["Content-Type"] = "application/json"
    if bearer:
        h["Authorization"] = f"Bearer {bearer}"
    return h


def _content(req: Request) -> Optional[bytes]:
    return None if req.body is _NO_BODY else json.dumps(req.body).encode("utf-8")


_CONTENT_LENGTH_RE = re.compile(r"^[0-9]{1,19}\Z")


def _too_large_by_header(res: httpx.Response) -> bool:
    """True when Content-Length exceeds the cap; a malformed value raises ServerError."""
    raw = res.headers.get("content-length")
    if raw is None:
        return False
    value = raw.strip()
    if not _CONTENT_LENGTH_RE.match(value):
        raise ServerError("Malformed Content-Length header in response", res.status_code)
    return int(value) > MAX_RESPONSE_BYTES


def _finish(req: Request, res: httpx.Response, data: bytes) -> Any:
    text = data.decode("utf-8", errors="replace")
    if 300 <= res.status_code < 400:
        raise NetworkError(f"Redirect (HTTP {res.status_code}) refused: the SDK never follows redirects")
    if not (200 <= res.status_code < 300):
        raise_for_status(res.status_code, text, res.headers)
    if req.raw:
        return text
    if not text:
        return {}
    try:
        return safe_json_loads(text)
    except ValueError:
        raise ServerError("Invalid JSON in response", res.status_code) from None


def _not_authenticated() -> AuthenticationError:
    return AuthenticationError("Not authenticated. Call connect_with_key() or wallet_auth.verify() first.")


class SyncHttpClient:
    def __init__(
        self,
        base_url: str,
        tokens: TokenManager,
        api_key: Callable[[], Optional[str]],
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        self._base_url = _validate_base_url(base_url)
        self._tokens = tokens
        self._api_key = api_key
        self._client = httpx.Client(
            transport=transport, follow_redirects=False, timeout=REQUEST_TIMEOUT_SECONDS, trust_env=False
        )
        self.sleep: Callable[[float], None] = time.sleep

    def close(self) -> None:
        self._client.close()

    def _bearer(self, mode: str, force: bool) -> Optional[str]:
        if mode == "none":
            return None
        if mode == "agent":
            key = self._api_key()
            if key:
                return key
        if not self._tokens.has_tokens():
            raise _not_authenticated()
        return self._tokens.force_refresh() if force else self._tokens.get_valid_token()

    def _send(self, req: Request, bearer: Optional[str]) -> httpx.Response:
        try:
            r = self._client.build_request(
                req.method, self._base_url + req.path, headers=_headers(req, bearer), content=_content(req)
            )
            return self._client.send(r, stream=True)
        except httpx.HTTPError as err:
            raise NetworkError(scrub_credentials(str(err) or "Network request failed")) from None

    def _read(self, res: httpx.Response) -> bytes:
        try:
            if _too_large_by_header(res):
                raise ServerError("Response body too large", res.status_code)
            buf = bytearray()
            for chunk in res.iter_bytes():
                buf += chunk
                if len(buf) > MAX_RESPONSE_BYTES:
                    raise ServerError("Response body exceeds size limit", res.status_code)
            return bytes(buf)
        except httpx.HTTPError as err:
            raise NetworkError(scrub_credentials(str(err) or "Network read failed")) from None
        finally:
            res.close()

    def request(self, req: Request) -> Any:
        if req.auth not in ("jwt", "agent", "none"):
            raise invalid_arg("unknown auth mode")
        bearer = self._bearer(req.auth, False)
        res = self._send(req, bearer)
        for _ in range(MAX_RATE_LIMIT_RETRIES):
            if res.status_code != 429:
                break
            wait = retry_delay_seconds(_parse_retry_after(res.headers.get("retry-after"), 5))
            res.close()  # do not read the 429 body
            self.sleep(wait)
            bearer = self._bearer(req.auth, False)
            res = self._send(req, bearer)
        used_jwt = bearer is not None and not bearer.startswith("dn_")
        if res.status_code == 401 and used_jwt and self._tokens.refresh_token:
            res.close()
            try:
                refreshed: Optional[str] = self._bearer(req.auth, True)
            except Exception:
                refreshed = None
            if not refreshed:
                raise AuthenticationError("Session expired and token refresh failed")
            res = self._send(req, refreshed)
        return _finish(req, res, self._read(res))

    def __repr__(self) -> str:
        return f"SyncHttpClient({self._base_url})"


class AsyncHttpClient:
    def __init__(
        self,
        base_url: str,
        tokens: AsyncTokenManager,
        api_key: Callable[[], Optional[str]],
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self._base_url = _validate_base_url(base_url)
        self._tokens = tokens
        self._api_key = api_key
        self._client = httpx.AsyncClient(
            transport=transport, follow_redirects=False, timeout=REQUEST_TIMEOUT_SECONDS, trust_env=False
        )
        self.sleep: Callable[[float], Any] = asyncio.sleep

    async def close(self) -> None:
        await self._client.aclose()

    async def _bearer(self, mode: str, force: bool) -> Optional[str]:
        if mode == "none":
            return None
        if mode == "agent":
            key = self._api_key()
            if key:
                return key
        if not self._tokens.has_tokens():
            raise _not_authenticated()
        return await (self._tokens.force_refresh() if force else self._tokens.get_valid_token())

    async def _send(self, req: Request, bearer: Optional[str]) -> httpx.Response:
        try:
            r = self._client.build_request(
                req.method, self._base_url + req.path, headers=_headers(req, bearer), content=_content(req)
            )
            return await self._client.send(r, stream=True)
        except httpx.HTTPError as err:
            raise NetworkError(scrub_credentials(str(err) or "Network request failed")) from None

    async def _read(self, res: httpx.Response) -> bytes:
        try:
            if _too_large_by_header(res):
                raise ServerError("Response body too large", res.status_code)
            buf = bytearray()
            async for chunk in res.aiter_bytes():
                buf += chunk
                if len(buf) > MAX_RESPONSE_BYTES:
                    raise ServerError("Response body exceeds size limit", res.status_code)
            return bytes(buf)
        except httpx.HTTPError as err:
            raise NetworkError(scrub_credentials(str(err) or "Network read failed")) from None
        finally:
            await res.aclose()

    async def request(self, req: Request) -> Any:
        if req.auth not in ("jwt", "agent", "none"):
            raise invalid_arg("unknown auth mode")
        bearer = await self._bearer(req.auth, False)
        res = await self._send(req, bearer)
        for _ in range(MAX_RATE_LIMIT_RETRIES):
            if res.status_code != 429:
                break
            wait = retry_delay_seconds(_parse_retry_after(res.headers.get("retry-after"), 5))
            await res.aclose()
            await self.sleep(wait)
            bearer = await self._bearer(req.auth, False)
            res = await self._send(req, bearer)
        used_jwt = bearer is not None and not bearer.startswith("dn_")
        if res.status_code == 401 and used_jwt and self._tokens.refresh_token:
            await res.aclose()
            try:
                refreshed: Optional[str] = await self._bearer(req.auth, True)
            except Exception:
                refreshed = None
            if not refreshed:
                raise AuthenticationError("Session expired and token refresh failed")
            res = await self._send(req, refreshed)
        data = await self._read(res)
        return _finish(req, res, data)

    def __repr__(self) -> str:
        return f"AsyncHttpClient({self._base_url})"


AnyHttpClient = Union[SyncHttpClient, AsyncHttpClient]
