"""HTTP behaviour: error mapping, scrubbing, 429 retry, 401 refresh, 10 MB cap, redirects, JSON hardening."""

from __future__ import annotations

from typing import Any, List

import httpx
import pytest

from conftest import ACCESS, API_KEY, REFRESH, Recorder, make_jwt, new_async_client, new_client
from dominusnode import (
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
    MAX_RESPONSE_BYTES,
)
from dominusnode.http_client import retry_delay_seconds

NODE_KEY = "dn_node_" + "a" * 64


@pytest.mark.parametrize("status,cls", [
    (400, ValidationError), (401, AuthenticationError), (402, InsufficientBalanceError), (403, AuthorizationError),
    (404, NotFoundError), (409, ConflictError), (500, ServerError), (503, ServerError), (418, DominusNodeError),
])
def test_error_mapping(rec: Recorder, status: int, cls: type) -> None:
    c = new_client(rec)
    rec.add(status, {"error": "nope", "code": "SOME_CODE", "max": 5, "cap": "7", "limitPerDay": 5, "other": 1})
    with pytest.raises(cls) as ei:
        c.network.stats()
    e = ei.value
    assert e.status_code == status and e.code == "SOME_CODE" and str(e) == "nope"
    assert e.details == {"max": 5, "cap": "7", "limitPerDay": 5}


def test_429_mapping_carries_retry_after(rec: Recorder) -> None:
    c = new_client(rec)
    rec.add(429, {"error": "slow", "code": "RATE_LIMITED"}, {"retry-after": "3"})
    rec.add(429, {"error": "slow", "code": "RATE_LIMITED"}, {"retry-after": "42"})
    with pytest.raises(RateLimitError) as ei:
        c.network.stats()
    assert ei.value.retry_after_seconds == 42 and ei.value.code == "RATE_LIMITED" and len(rec.requests) == 2


def test_429_default_retry_after_60(rec: Recorder) -> None:
    c = new_client(rec)
    rec.add(429)
    rec.add(429)
    with pytest.raises(RateLimitError) as ei:
        c.network.stats()
    assert ei.value.retry_after_seconds == 60


def test_429_retry_then_success(rec: Recorder) -> None:
    c = new_client(rec)
    waits: List[float] = []
    c._http.sleep = waits.append
    rec.add(429, headers={"retry-after": "30"})
    rec.add(200, {"onlineNodes": 1})
    assert c.network.stats() == {"onlineNodes": 1}
    assert len(rec.requests) == 2 and len(waits) == 1 and 9.0 <= waits[0] <= 11.0


def test_429_default_wait_is_5s(rec: Recorder) -> None:
    c = new_client(rec)
    waits: List[float] = []
    c._http.sleep = waits.append
    rec.add(429)
    rec.add(200, {})
    c.network.stats()
    assert 4.5 <= waits[0] <= 5.5


def test_retry_delay_bounds() -> None:
    assert retry_delay_seconds(100, lambda: 1.0) == pytest.approx(11.0)
    assert retry_delay_seconds(100, lambda: 0.0) == pytest.approx(9.0)
    assert retry_delay_seconds(10, lambda: 0.5) == pytest.approx(10.0)
    assert retry_delay_seconds(0, lambda: 0.0) == pytest.approx(0.1)
    assert retry_delay_seconds(0.05, lambda: 1.0) == pytest.approx(0.1)
    for _ in range(200):
        assert 0.1 <= retry_delay_seconds(1000) <= 11.0


def test_mfa_required_code(rec: Recorder) -> None:
    c = new_client(rec)
    rec.add(403, {"error": "MFA needed", "mfaRequired": True})
    with pytest.raises(AuthorizationError) as ei:
        c.auth.verify_key(API_KEY)
    assert ei.value.code == "MFA_REQUIRED"


def test_message_truncated(rec: Recorder) -> None:
    c = new_client(rec)
    rec.add(400, {"error": "x" * 600})
    with pytest.raises(ValidationError) as ei:
        c.network.stats()
    assert str(ei.value) == "x" * 500 + "... [truncated]"


def test_plain_text_error_and_fallbacks(rec: Recorder) -> None:
    c = new_client(rec)
    rec.add(500, raw=b"upstream exploded")
    with pytest.raises(ServerError, match="upstream exploded"):
        c.network.stats()
    rec.add(500, raw=b"")
    with pytest.raises(ServerError, match="HTTP 500"):
        c.network.stats()
    rec.add(400, {"message": "from message"})
    with pytest.raises(ValidationError, match="from message"):
        c.network.stats()


@pytest.mark.parametrize("secret", [API_KEY, "dn_test_abcdefgh123", NODE_KEY, "dn_proxy_abc_def", ACCESS])
def test_credential_scrubbing(rec: Recorder, secret: str) -> None:
    c = new_client(rec)
    rec.add(400, {"error": f"bad key {secret} here"})
    with pytest.raises(ValidationError) as ei:
        c.network.stats()
    assert secret not in str(ei.value) and "[REDACTED]" in str(ei.value) and secret not in repr(ei.value)


def test_transport_error_is_network_error_and_scrubbed() -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"connect failed for {API_KEY}")

    from dominusnode import DominusNodeClient

    c = DominusNodeClient(base_url="https://api.test", transport=httpx.MockTransport(boom))
    with pytest.raises(NetworkError) as ei:
        c.network.stats()
    assert API_KEY not in str(ei.value)


def test_redirect_not_followed(rec: Recorder) -> None:
    c = new_client(rec)
    rec.add(302, headers={"location": "https://evil.test/steal"})
    with pytest.raises(NetworkError, match="Redirect"):
        c.network.stats()
    assert len(rec.requests) == 1


def test_cap_by_content_length(rec: Recorder) -> None:
    c = new_client(rec)
    rec.queue.append(httpx.Response(200, content=b"{}", headers={"content-length": str(MAX_RESPONSE_BYTES + 1)}))
    with pytest.raises(ServerError, match="too large"):
        c.network.stats()


def test_cap_by_actual_size(rec: Recorder) -> None:
    c = new_client(rec)

    def chunks() -> Any:
        for _ in range(11):
            yield b"x" * (1024 * 1024)

    rec.queue.append(httpx.Response(200, content=chunks()))
    with pytest.raises(ServerError, match="size limit"):
        c.network.stats()


def test_invalid_json_and_empty_body(rec: Recorder) -> None:
    c = new_client(rec)
    rec.add(200, raw=b"not json")
    with pytest.raises(ServerError, match="Invalid JSON"):
        c.network.stats()
    rec.add(200, raw=b"")
    assert c.network.stats() == {}


def test_strips_prototype_pollution_keys(rec: Recorder) -> None:
    c = new_client(rec)
    rec.add(200, raw=b'{"a":{"__proto__":{"x":1},"b":[{"constructor":1,"prototype":2,"ok":3}]}}')
    assert c.network.stats() == {"a": {"b": [{"ok": 3}]}}


def test_no_credential_raises_before_request(rec: Recorder) -> None:
    c = new_client(rec)
    with pytest.raises(AuthenticationError):
        c.auth.me()
    with pytest.raises(AuthenticationError):
        c.credits.balance()
    assert rec.requests == []


# ------------------------------------------------------------ 401 refresh
def test_401_refreshes_and_retries(rec: Recorder) -> None:
    c = new_client(rec, access_token=ACCESS, refresh_token=REFRESH)
    new_access = make_jwt(3600, "new")
    rec.add(401, {"error": "expired"})
    rec.add(200, {"token": new_access, "refreshToken": REFRESH})
    rec.add(200, {"user": {"id": "u"}})
    assert c.auth.me() == {"user": {"id": "u"}}
    assert [r.url.path for r in rec.requests] == ["/api/auth/me", "/api/auth/refresh", "/api/auth/me"]
    assert rec.requests[2].headers["authorization"] == f"Bearer {new_access}"
    assert "authorization" not in rec.requests[1].headers


def test_expired_token_refreshed_proactively(rec: Recorder) -> None:
    c = new_client(rec, access_token=make_jwt(30), refresh_token=REFRESH)
    rec.add(200, {"token": ACCESS})
    rec.add(200, {"user": {}})
    c.auth.me()
    assert rec.requests[0].url.path == "/api/auth/refresh"


def test_401_refresh_failure_clears_tokens(rec: Recorder) -> None:
    c = new_client(rec, access_token=ACCESS, refresh_token=REFRESH)
    rec.add(401, {"error": "expired"})
    rec.add(401, {"error": "refresh revoked"})
    with pytest.raises(AuthenticationError, match="refresh failed"):
        c.auth.me()
    assert not c.is_connected and c._ctx.tokens.access_token is None and c._ctx.tokens.refresh_token is None


def test_no_refresh_for_api_key_auth(rec: Recorder, client: Any) -> None:
    rec.add(401, {"error": "bad key"})
    with pytest.raises(AuthenticationError):
        client.credits.balance()
    assert len(rec.requests) == 1


async def test_async_401_refresh(rec: Recorder) -> None:
    c = new_async_client(rec, access_token=ACCESS, refresh_token=REFRESH)
    rec.add(401)
    rec.add(200, {"token": make_jwt(3600, "x")})
    rec.add(200, {"user": {}})
    assert await c.auth.me() == {"user": {}}
    assert len(rec.requests) == 3


async def test_async_concurrent_refresh_is_singleton(rec: Recorder) -> None:
    import asyncio

    c = new_async_client(rec, access_token=make_jwt(-10), refresh_token=REFRESH)
    rec.add(200, {"token": ACCESS})
    await asyncio.gather(*(c.auth.me() for _ in range(5)))
    assert [r.url.path for r in rec.requests].count("/api/auth/refresh") == 1


async def test_async_429_and_errors(rec: Recorder) -> None:
    c = new_async_client(rec)
    rec.add(429)
    rec.add(429, headers={"retry-after": "9"})
    with pytest.raises(RateLimitError) as ei:
        await c.network.stats()
    assert ei.value.retry_after_seconds == 9
    rec.queue.append(httpx.Response(200, content=b"{}", headers={"content-length": str(MAX_RESPONSE_BYTES + 1)}))
    with pytest.raises(ServerError):
        await c.network.stats()
    rec.add(301, headers={"location": "https://x"})
    with pytest.raises(NetworkError):
        await c.network.stats()


@pytest.mark.parametrize("url", ["ftp://x", "https://user:pw@api.test", "not a url", "https://"])
def test_base_url_validation(url: str) -> None:
    from dominusnode import DominusNodeClient

    with pytest.raises(ValidationError):
        DominusNodeClient(base_url=url)


def test_base_url_trailing_slash_stripped(rec: Recorder) -> None:
    from dominusnode import DominusNodeClient

    c = DominusNodeClient(base_url="https://api.test///", transport=httpx.MockTransport(rec.handler))
    c.network.stats()
    assert str(rec.last.url) == "https://api.test/v1/network/stats"
