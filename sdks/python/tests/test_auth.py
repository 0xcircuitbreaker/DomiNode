"""Tests for the AuthResource (sync) -- login, register, MFA, verify-key."""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest

from dominusnode.auth import AuthResource, _parse_login_result
from dominusnode.token_manager import TokenManager
from dominusnode.types import LoginResult, MfaSetup, MfaStatus, User
from tests.conftest import make_jwt


class TestParseLoginResult:
    """Tests for the _parse_login_result helper."""

    def test_parses_successful_login(self) -> None:
        data = {
            "token": "access-tok",
            "refreshToken": "refresh-tok",
            "user": {
                "id": "u-1",
                "email": "test@example.com",
                "created_at": "2024-01-01T00:00:00Z",
                "is_admin": False,
            },
        }
        result = _parse_login_result(data)
        assert result.token == "access-tok"
        assert result.refresh_token == "refresh-tok"
        assert result.user is not None
        assert result.user.id == "u-1"
        assert result.user.email == "test@example.com"
        assert result.mfa_required is False

    def test_parses_mfa_required_response(self) -> None:
        data = {
            "mfaRequired": True,
            "mfaChallengeToken": "challenge_abc",
        }
        result = _parse_login_result(data)
        assert result.mfa_required is True
        assert result.mfa_challenge_token == "challenge_abc"
        assert result.user is None
        assert result.token is None

    def test_parses_login_without_user(self) -> None:
        data = {
            "token": "tok",
            "refreshToken": "rtok",
        }
        result = _parse_login_result(data)
        assert result.token == "tok"
        assert result.user is None


class TestAuthResource:
    """Tests for the synchronous AuthResource."""

    def _make_auth(self) -> tuple[AuthResource, MagicMock, TokenManager]:
        mock_http = MagicMock()
        tm = TokenManager()
        auth = AuthResource(mock_http, tm)
        return auth, mock_http, tm

    def test_register_stores_tokens(self) -> None:
        auth, mock_http, tm = self._make_auth()
        access = make_jwt()
        refresh = make_jwt(exp=int(time.time()) + 7 * 86400)

        mock_http.post.return_value = {
            "token": access,
            "refreshToken": refresh,
            "user": {
                "id": "u-new",
                "email": "new@example.com",
                "created_at": "2024-01-01",
                "is_admin": False,
            },
        }

        result = auth.register("new@example.com", "password123")
        assert result.user is not None
        assert result.user.email == "new@example.com"
        assert tm.access_token == access
        assert tm.refresh_token == refresh
        mock_http.post.assert_called_once_with(
            "/api/auth/register",
            json={"email": "new@example.com", "password": "password123"},
        )

    def test_login_stores_tokens(self) -> None:
        auth, mock_http, tm = self._make_auth()
        access = make_jwt()
        refresh = make_jwt(exp=int(time.time()) + 7 * 86400)

        mock_http.post.return_value = {
            "token": access,
            "refreshToken": refresh,
            "user": {
                "id": "u-1",
                "email": "user@test.com",
                "created_at": "2024-01-01",
                "is_admin": False,
            },
        }

        result = auth.login("user@test.com", "pass")
        assert result.user is not None
        assert result.user.email == "user@test.com"
        assert tm.has_tokens is True

    def test_login_returns_mfa_required(self) -> None:
        auth, mock_http, tm = self._make_auth()
        mock_http.post.return_value = {
            "mfaRequired": True,
            "mfaChallengeToken": "challenge_xyz",
        }

        result = auth.login("user@test.com", "pass")
        assert result.mfa_required is True
        assert result.mfa_challenge_token == "challenge_xyz"
        assert tm.has_tokens is False

    def test_verify_key_stores_tokens(self) -> None:
        auth, mock_http, tm = self._make_auth()
        access = make_jwt()
        refresh = make_jwt(exp=int(time.time()) + 7 * 86400)

        mock_http.post.return_value = {
            "valid": True,
            "token": access,
            "refreshToken": refresh,
            "userId": "u-key",
            "email": "key@test.com",
        }

        result = auth.verify_key("dn_live_test_key")
        assert result.token == access
        assert result.user is not None
        assert result.user.id == "u-key"
        assert tm.access_token == access

    def test_logout_clears_tokens(self) -> None:
        auth, mock_http, tm = self._make_auth()
        tm.set_tokens(make_jwt(), make_jwt(exp=int(time.time()) + 7 * 86400))
        mock_http.post.return_value = None

        auth.logout()
        assert tm.has_tokens is False

    def test_me_returns_user(self) -> None:
        auth, mock_http, tm = self._make_auth()
        mock_http.get.return_value = {
            "user": {
                "id": "u-me",
                "email": "me@test.com",
                "created_at": "2024-06-01",
                "is_admin": True,
            },
        }

        user = auth.me()
        assert user.id == "u-me"
        assert user.email == "me@test.com"
        assert user.is_admin is True

    def test_mfa_setup_returns_setup_data(self) -> None:
        auth, mock_http, tm = self._make_auth()
        mock_http.post.return_value = {
            "secret": "JBSWY3DPEHPK3PXP",
            "otpauthUri": "otpauth://totp/Dominus Node:test@test.com?secret=JBSWY3DPEHPK3PXP",
            "backupCodes": ["12345678", "87654321"],
        }

        setup = auth.mfa_setup()
        assert setup.secret == "JBSWY3DPEHPK3PXP"
        assert "otpauth://" in setup.otpauth_uri
        assert len(setup.backup_codes) == 2

    def test_mfa_status(self) -> None:
        auth, mock_http, tm = self._make_auth()
        mock_http.get.return_value = {
            "enabled": True,
            "backupCodesRemaining": 8,
        }

        status = auth.mfa_status()
        assert status.enabled is True
        assert status.backup_codes_remaining == 8

    def test_verify_mfa_stores_tokens(self) -> None:
        auth, mock_http, tm = self._make_auth()
        access = make_jwt()
        refresh = make_jwt(exp=int(time.time()) + 7 * 86400)

        mock_http.post.return_value = {
            "token": access,
            "refreshToken": refresh,
            "user": {
                "id": "u-mfa",
                "email": "mfa@test.com",
                "created_at": "2024-01-01",
                "is_admin": False,
            },
        }

        result = auth.verify_mfa("123456", mfa_challenge_token="challenge_tok")
        assert result.token == access
        assert tm.access_token == access
        mock_http.post.assert_called_once_with(
            "/api/auth/mfa/verify",
            json={"code": "123456", "isBackupCode": False, "mfaChallengeToken": "challenge_tok"},
        )

    def test_refresh_returns_token_pair(self) -> None:
        auth, mock_http, tm = self._make_auth()
        old_refresh = make_jwt(exp=int(time.time()) + 7 * 86400)
        tm.set_tokens(make_jwt(), old_refresh)

        new_access = make_jwt()
        new_refresh = make_jwt(exp=int(time.time()) + 7 * 86400)

        mock_http.post.return_value = {
            "token": new_access,
            "refreshToken": new_refresh,
        }

        access, refresh = auth.refresh()
        assert access == new_access
        assert refresh == new_refresh
        assert tm.access_token == new_access

    def test_refresh_without_token_raises(self) -> None:
        auth, mock_http, tm = self._make_auth()
        with pytest.raises(ValueError, match="No refresh token"):
            auth.refresh()
