"""Shared test fixtures for the Dominus Node SDK test suite."""

from __future__ import annotations

import base64
import json
import time
from typing import Generator

import pytest

from dominusnode import DominusNodeClient, AsyncDominusNodeClient


def make_jwt(
    *,
    exp: int | None = None,
    user_id: str = "test-user-id",
    email: str = "test@example.com",
    is_admin: bool = False,
) -> str:
    """Create a fake JWT token for testing.

    The token has valid base64-encoded header and payload segments but
    no real cryptographic signature.
    """
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).rstrip(b"=").decode()

    payload_data = {
        "userId": user_id,
        "email": email,
        "isAdmin": is_admin,
        "iat": int(time.time()),
    }
    if exp is not None:
        payload_data["exp"] = exp
    else:
        payload_data["exp"] = int(time.time()) + 900  # 15 min default

    payload = base64.urlsafe_b64encode(
        json.dumps(payload_data).encode()
    ).rstrip(b"=").decode()

    signature = base64.urlsafe_b64encode(b"fake-signature").rstrip(b"=").decode()

    return f"{header}.{payload}.{signature}"


@pytest.fixture
def valid_token() -> str:
    """A JWT that expires 15 minutes from now."""
    return make_jwt()


@pytest.fixture
def expired_token() -> str:
    """A JWT that expired 5 minutes ago."""
    return make_jwt(exp=int(time.time()) - 300)


@pytest.fixture
def expiring_soon_token() -> str:
    """A JWT that expires in 30 seconds (within the 60s refresh buffer)."""
    return make_jwt(exp=int(time.time()) + 30)


@pytest.fixture
def refresh_token() -> str:
    """A fake refresh token."""
    return make_jwt(exp=int(time.time()) + 7 * 24 * 3600)
