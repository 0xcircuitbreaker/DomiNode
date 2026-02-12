"""Tests for DomiNodeClient and AsyncDomiNodeClient initialization."""

from __future__ import annotations

import pytest
import httpx
import respx

from dominode import (
    AsyncDomiNodeClient,
    DomiNodeClient,
    AuthenticationError,
)
from dominode.auth import AuthResource, AsyncAuthResource
from dominode.keys import KeysResource, AsyncKeysResource
from dominode.wallet import WalletResource, AsyncWalletResource
from dominode.usage import UsageResource, AsyncUsageResource
from dominode.plans import PlansResource, AsyncPlansResource
from dominode.sessions import SessionsResource, AsyncSessionsResource
from dominode.proxy import ProxyResource, AsyncProxyResource
from dominode.admin import AdminResource, AsyncAdminResource
from dominode.constants import DEFAULT_BASE_URL, DEFAULT_PROXY_HOST
from tests.conftest import make_jwt


class TestDomiNodeClientInit:
    """Test sync client initialization modes."""

    def test_default_initialization(self) -> None:
        client = DomiNodeClient()
        try:
            assert client.auth is not None
            assert isinstance(client.auth, AuthResource)
            assert isinstance(client.keys, KeysResource)
            assert isinstance(client.wallet, WalletResource)
            assert isinstance(client.usage, UsageResource)
            assert isinstance(client.plans, PlansResource)
            assert isinstance(client.sessions, SessionsResource)
            assert isinstance(client.proxy, ProxyResource)
            assert isinstance(client.admin, AdminResource)
        finally:
            client.close()

    def test_custom_base_url(self) -> None:
        client = DomiNodeClient(base_url="http://localhost:3000")
        try:
            # Client should be usable with custom URL
            assert client.auth is not None
        finally:
            client.close()

    def test_custom_proxy_settings(self) -> None:
        client = DomiNodeClient(
            proxy_host="myproxy.local",
            http_proxy_port=9090,
            socks5_proxy_port=1081,
        )
        try:
            assert client._proxy_host == "myproxy.local"
            assert client._http_proxy_port == 9090
            assert client._socks5_proxy_port == 1081
        finally:
            client.close()

    def test_pre_existing_tokens(self) -> None:
        access = make_jwt()
        refresh = make_jwt(exp=__import__("time").time() + 7 * 86400)
        client = DomiNodeClient(
            access_token=access,
            refresh_token=refresh,
        )
        try:
            assert client._token_manager.has_tokens is True
            assert client._token_manager.access_token == access
        finally:
            client.close()

    def test_context_manager(self) -> None:
        with DomiNodeClient() as client:
            assert client.auth is not None

    @respx.mock
    def test_connect_with_key(self) -> None:
        """Test that connect_with_key calls verify-key endpoint."""
        access = make_jwt()
        refresh = make_jwt(exp=__import__("time").time() + 7 * 86400)

        respx.post("http://localhost:3000/api/auth/verify-key").mock(
            return_value=httpx.Response(
                200,
                json={
                    "valid": True,
                    "token": access,
                    "refreshToken": refresh,
                    "userId": "u-123",
                    "email": "test@example.com",
                },
            )
        )

        with DomiNodeClient(base_url="http://localhost:3000") as client:
            result = client.connect_with_key("dn_live_test_key_123")
            assert result.token == access
            assert result.refresh_token == refresh
            assert result.user is not None
            assert result.user.id == "u-123"
            assert client._api_key == "dn_live_test_key_123"

    @respx.mock
    def test_connect_with_credentials(self) -> None:
        """Test that connect_with_credentials calls login endpoint."""
        access = make_jwt()
        refresh = make_jwt(exp=__import__("time").time() + 7 * 86400)

        respx.post("http://localhost:3000/api/auth/login").mock(
            return_value=httpx.Response(
                200,
                json={
                    "token": access,
                    "refreshToken": refresh,
                    "user": {
                        "id": "u-456",
                        "email": "user@example.com",
                        "created_at": "2024-01-01T00:00:00Z",
                        "is_admin": False,
                    },
                },
            )
        )

        with DomiNodeClient(base_url="http://localhost:3000") as client:
            result = client.connect_with_credentials("user@example.com", "password123")
            assert result.user is not None
            assert result.user.email == "user@example.com"
            assert result.mfa_required is False

    @respx.mock
    def test_connect_with_mfa_required(self) -> None:
        """Test login flow when MFA is required."""
        respx.post("http://localhost:3000/api/auth/login").mock(
            return_value=httpx.Response(
                200,
                json={
                    "mfaRequired": True,
                    "mfaChallengeToken": "challenge_token_abc",
                },
            )
        )

        with DomiNodeClient(base_url="http://localhost:3000") as client:
            result = client.connect_with_credentials("user@example.com", "password123")
            assert result.mfa_required is True
            assert result.mfa_challenge_token == "challenge_token_abc"
            assert result.user is None

    @respx.mock
    def test_disconnect(self) -> None:
        """Test that disconnect calls logout and clears state."""
        access = make_jwt()
        refresh = make_jwt(exp=__import__("time").time() + 7 * 86400)

        respx.post("http://localhost:3000/api/auth/verify-key").mock(
            return_value=httpx.Response(
                200,
                json={
                    "valid": True,
                    "token": access,
                    "refreshToken": refresh,
                    "userId": "u-123",
                    "email": "test@example.com",
                },
            )
        )
        respx.post("http://localhost:3000/api/auth/logout").mock(
            return_value=httpx.Response(200, json={"message": "Logged out successfully"})
        )

        with DomiNodeClient(base_url="http://localhost:3000") as client:
            client.connect_with_key("dn_live_test_key")
            assert client._token_manager.has_tokens is True
            client.disconnect()
            assert client._token_manager.has_tokens is False
            assert client._api_key is None


class TestAsyncDomiNodeClientInit:
    """Test async client initialization."""

    def test_default_initialization(self) -> None:
        client = AsyncDomiNodeClient()
        assert isinstance(client.auth, AsyncAuthResource)
        assert isinstance(client.keys, AsyncKeysResource)
        assert isinstance(client.wallet, AsyncWalletResource)
        assert isinstance(client.usage, AsyncUsageResource)
        assert isinstance(client.plans, AsyncPlansResource)
        assert isinstance(client.sessions, AsyncSessionsResource)
        assert isinstance(client.proxy, AsyncProxyResource)
        assert isinstance(client.admin, AsyncAdminResource)

    def test_custom_settings(self) -> None:
        client = AsyncDomiNodeClient(
            base_url="http://localhost:3000",
            proxy_host="myproxy.local",
            http_proxy_port=9090,
            socks5_proxy_port=1081,
        )
        assert client._proxy_host == "myproxy.local"

    def test_pre_existing_tokens(self) -> None:
        access = make_jwt()
        refresh = make_jwt(exp=__import__("time").time() + 7 * 86400)
        client = AsyncDomiNodeClient(access_token=access, refresh_token=refresh)
        assert client._token_manager.has_tokens is True

    @pytest.mark.asyncio
    @respx.mock
    async def test_async_context_manager_with_key(self) -> None:
        """Test async context manager auto-connects with API key."""
        access = make_jwt()
        refresh = make_jwt(exp=__import__("time").time() + 7 * 86400)

        respx.post("http://localhost:3000/api/auth/verify-key").mock(
            return_value=httpx.Response(
                200,
                json={
                    "valid": True,
                    "token": access,
                    "refreshToken": refresh,
                    "userId": "u-789",
                    "email": "async@example.com",
                },
            )
        )

        async with AsyncDomiNodeClient(
            base_url="http://localhost:3000",
            api_key="dn_live_async_key",
        ) as client:
            assert client._token_manager.has_tokens is True
            assert client._api_key == "dn_live_async_key"

    @pytest.mark.asyncio
    @respx.mock
    async def test_async_connect_with_credentials(self) -> None:
        access = make_jwt()
        refresh = make_jwt(exp=__import__("time").time() + 7 * 86400)

        respx.post("http://localhost:3000/api/auth/login").mock(
            return_value=httpx.Response(
                200,
                json={
                    "token": access,
                    "refreshToken": refresh,
                    "user": {
                        "id": "u-async",
                        "email": "async@example.com",
                        "created_at": "2024-01-01T00:00:00Z",
                        "is_admin": False,
                    },
                },
            )
        )

        async with AsyncDomiNodeClient(base_url="http://localhost:3000") as client:
            result = await client.connect_with_credentials("async@example.com", "pass123")
            assert result.user is not None
            assert result.user.email == "async@example.com"
