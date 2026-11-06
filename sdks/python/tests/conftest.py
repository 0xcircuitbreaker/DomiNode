from __future__ import annotations

import base64
import json
import time
from typing import Any, Dict, List, Optional

import httpx
import pytest

from dominusnode import AsyncDominusNodeClient, DominusNodeClient

API_KEY = "dn_live_testkey1234567890abcdef"
BASE = "https://api.test"


def make_jwt(exp_offset: int = 3600, sub: str = "u1") -> str:
    def b64(obj: Dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    return f"{b64({'alg': 'HS256', 'typ': 'JWT'})}.{b64({'sub': sub, 'exp': int(time.time()) + exp_offset})}.sig"


ACCESS = make_jwt()
REFRESH = make_jwt(86400, "r1")


class Recorder:
    """Mock transport: queue responses, record requests. Unqueued requests get 200 {}."""

    def __init__(self) -> None:
        self.requests: List[httpx.Request] = []
        self.queue: List[httpx.Response] = []

    def add(self, status: int = 200, body: Any = None, headers: Optional[Dict[str, str]] = None, raw: Optional[bytes] = None) -> None:
        if raw is None:
            raw = b"" if body is None else json.dumps(body).encode()
        self.queue.append(httpx.Response(status, content=raw, headers=headers or {}))

    def handler(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        if self.queue:
            return self.queue.pop(0)
        return httpx.Response(200, content=b"{}")

    async def ahandler(self, request: httpx.Request) -> httpx.Response:
        await request.aread()
        return self.handler(request)

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]

    def body(self, i: int = -1) -> Any:
        c = self.requests[i].content
        return json.loads(c) if c else None


@pytest.fixture
def rec() -> Recorder:
    return Recorder()


def new_client(rec: Recorder, **kw: Any) -> DominusNodeClient:
    c = DominusNodeClient(base_url=BASE, transport=httpx.MockTransport(rec.handler), **kw)
    c._http.sleep = lambda s: None
    return c


def new_async_client(rec: Recorder, **kw: Any) -> AsyncDominusNodeClient:
    c = AsyncDominusNodeClient(base_url=BASE, transport=httpx.MockTransport(rec.ahandler), **kw)

    async def nosleep(s: float) -> None:
        return None

    c._http.sleep = nosleep
    return c


def connect(c: DominusNodeClient, rec: Recorder) -> None:
    rec.add(200, {"valid": True, "token": ACCESS, "refreshToken": REFRESH, "userId": "u1", "email": "a@b.c"})
    c.connect_with_key(API_KEY)
    rec.requests.clear()


@pytest.fixture
def client(rec: Recorder) -> DominusNodeClient:
    c = new_client(rec)
    connect(c, rec)
    return c
