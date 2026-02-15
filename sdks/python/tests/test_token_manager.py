"""Tests for JWT token management and auto-refresh."""

from __future__ import annotations

import asyncio
import time
from unittest.mock import MagicMock

import pytest

from dominusnode.token_manager import AsyncTokenManager, TokenManager, is_expired
from tests.conftest import make_jwt


class TestIsExpired:
    """Tests for the is_expired() utility function."""

    def test_valid_token_not_expired(self) -> None:
        token = make_jwt(exp=int(time.time()) + 300)
        assert is_expired(token) is False

    def test_expired_token(self) -> None:
        token = make_jwt(exp=int(time.time()) - 60)
        assert is_expired(token) is True

    def test_token_within_buffer_is_expired(self) -> None:
        # Token expires in 30 seconds -- within the 60s refresh buffer
        token = make_jwt(exp=int(time.time()) + 30)
        assert is_expired(token) is True

    def test_token_outside_buffer_is_not_expired(self) -> None:
        # Token expires in 120 seconds -- well outside the 60s buffer
        token = make_jwt(exp=int(time.time()) + 120)
        assert is_expired(token) is False

    def test_malformed_token_is_expired(self) -> None:
        assert is_expired("not.a.jwt") is True

    def test_empty_string_is_expired(self) -> None:
        assert is_expired("") is True

    def test_missing_exp_is_expired(self) -> None:
        # Build a JWT without an exp claim
        import base64
        import json

        header = base64.urlsafe_b64encode(b'{"alg":"HS256"}').rstrip(b"=").decode()
        payload = base64.urlsafe_b64encode(b'{"sub":"user"}').rstrip(b"=").decode()
        sig = base64.urlsafe_b64encode(b"sig").rstrip(b"=").decode()
        token = f"{header}.{payload}.{sig}"
        assert is_expired(token) is True

    def test_non_json_payload_is_expired(self) -> None:
        import base64

        header = base64.urlsafe_b64encode(b'{"alg":"HS256"}').rstrip(b"=").decode()
        payload = base64.urlsafe_b64encode(b"not json").rstrip(b"=").decode()
        sig = base64.urlsafe_b64encode(b"sig").rstrip(b"=").decode()
        token = f"{header}.{payload}.{sig}"
        assert is_expired(token) is True


class TestTokenManager:
    """Tests for the synchronous TokenManager."""

    def test_initial_state(self) -> None:
        tm = TokenManager()
        assert tm.access_token is None
        assert tm.refresh_token is None
        assert tm.has_tokens is False

    def test_set_tokens(self, valid_token: str, refresh_token: str) -> None:
        tm = TokenManager()
        tm.set_tokens(valid_token, refresh_token)
        assert tm.access_token == valid_token
        assert tm.refresh_token == refresh_token
        assert tm.has_tokens is True

    def test_clear_tokens(self, valid_token: str, refresh_token: str) -> None:
        tm = TokenManager()
        tm.set_tokens(valid_token, refresh_token)
        tm.clear()
        assert tm.access_token is None
        assert tm.refresh_token is None
        assert tm.has_tokens is False

    def test_get_valid_token_returns_token_when_valid(self, valid_token: str, refresh_token: str) -> None:
        tm = TokenManager()
        tm.set_tokens(valid_token, refresh_token)
        assert tm.get_valid_token() == valid_token

    def test_get_valid_token_returns_none_when_no_tokens(self) -> None:
        tm = TokenManager()
        assert tm.get_valid_token() is None

    def test_get_valid_token_triggers_refresh_on_expired(
        self, expired_token: str, refresh_token: str
    ) -> None:
        new_access = make_jwt(exp=int(time.time()) + 900)
        new_refresh = make_jwt(exp=int(time.time()) + 7 * 86400)

        mock_refresh = MagicMock(return_value=(new_access, new_refresh))

        tm = TokenManager()
        tm.set_tokens(expired_token, refresh_token)
        tm.set_refresh_fn(mock_refresh)

        result = tm.get_valid_token()
        assert result == new_access
        mock_refresh.assert_called_once_with(refresh_token)

    def test_get_valid_token_triggers_refresh_on_expiring_soon(
        self, expiring_soon_token: str, refresh_token: str
    ) -> None:
        new_access = make_jwt(exp=int(time.time()) + 900)
        new_refresh = make_jwt(exp=int(time.time()) + 7 * 86400)

        mock_refresh = MagicMock(return_value=(new_access, new_refresh))

        tm = TokenManager()
        tm.set_tokens(expiring_soon_token, refresh_token)
        tm.set_refresh_fn(mock_refresh)

        result = tm.get_valid_token()
        assert result == new_access
        mock_refresh.assert_called_once()

    def test_refresh_failure_clears_tokens(
        self, expired_token: str, refresh_token: str
    ) -> None:
        mock_refresh = MagicMock(side_effect=Exception("network error"))

        tm = TokenManager()
        tm.set_tokens(expired_token, refresh_token)
        tm.set_refresh_fn(mock_refresh)

        result = tm.get_valid_token()
        assert result is None
        assert tm.has_tokens is False

    def test_no_refresh_fn_returns_none_on_expired(
        self, expired_token: str, refresh_token: str
    ) -> None:
        tm = TokenManager()
        tm.set_tokens(expired_token, refresh_token)
        # No refresh function set
        result = tm.get_valid_token()
        assert result is None


class TestAsyncTokenManager:
    """Tests for the asynchronous AsyncTokenManager."""

    @pytest.mark.asyncio
    async def test_initial_state(self) -> None:
        tm = AsyncTokenManager()
        assert tm.access_token is None
        assert tm.has_tokens is False

    @pytest.mark.asyncio
    async def test_set_and_get_valid_token(self, valid_token: str, refresh_token: str) -> None:
        tm = AsyncTokenManager()
        tm.set_tokens(valid_token, refresh_token)
        result = await tm.get_valid_token()
        assert result == valid_token

    @pytest.mark.asyncio
    async def test_refresh_on_expired(self, expired_token: str, refresh_token: str) -> None:
        new_access = make_jwt(exp=int(time.time()) + 900)
        new_refresh = make_jwt(exp=int(time.time()) + 7 * 86400)

        async def mock_refresh(rt: str) -> tuple[str, str]:
            return (new_access, new_refresh)

        tm = AsyncTokenManager()
        tm.set_tokens(expired_token, refresh_token)
        tm.set_refresh_fn(mock_refresh)

        result = await tm.get_valid_token()
        assert result == new_access

    @pytest.mark.asyncio
    async def test_refresh_failure_clears(self, expired_token: str, refresh_token: str) -> None:
        async def mock_refresh(rt: str) -> tuple[str, str]:
            raise Exception("fail")

        tm = AsyncTokenManager()
        tm.set_tokens(expired_token, refresh_token)
        tm.set_refresh_fn(mock_refresh)

        result = await tm.get_valid_token()
        assert result is None
        assert tm.has_tokens is False

    @pytest.mark.asyncio
    async def test_returns_none_when_no_tokens(self) -> None:
        tm = AsyncTokenManager()
        result = await tm.get_valid_token()
        assert result is None
