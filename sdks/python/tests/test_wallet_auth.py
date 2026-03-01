"""Tests for wallet auth resource."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from dominusnode.wallet_auth import (
    WalletAuthResource,
    AsyncWalletAuthResource,
    _validate_address,
    _validate_signature,
)

VALID_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678"
# Valid EIP-191 signature: 0x + 130 hex chars (65 bytes)
VALID_SIGNATURE = "0x" + "a" * 130
VALID_CHALLENGE = "Sign this message to authenticate: abc123"


class TestValidation:

    def test_valid_address(self) -> None:
        _validate_address(VALID_ADDRESS)  # should not raise

    def test_invalid_address_format(self) -> None:
        with pytest.raises(ValueError, match="valid Ethereum address"):
            _validate_address("not-an-address")

    def test_empty_address(self) -> None:
        with pytest.raises(ValueError, match="address is required"):
            _validate_address("")

    def test_address_without_0x(self) -> None:
        with pytest.raises(ValueError, match="valid Ethereum address"):
            _validate_address("1234567890abcdef1234567890abcdef12345678")

    def test_address_wrong_length(self) -> None:
        with pytest.raises(ValueError, match="valid Ethereum address"):
            _validate_address("0x1234")

    def test_empty_signature(self) -> None:
        with pytest.raises(ValueError, match="signature is required"):
            _validate_signature("")

    def test_short_signature(self) -> None:
        with pytest.raises(ValueError, match="valid EIP-191 signature"):
            _validate_signature("0xdeadbeef")

    def test_signature_without_0x(self) -> None:
        with pytest.raises(ValueError, match="valid EIP-191 signature"):
            _validate_signature("a" * 130)

    def test_oversized_signature(self) -> None:
        with pytest.raises(ValueError, match="must not exceed 200"):
            _validate_signature("0x" + "a" * 250)

    def test_valid_signature(self) -> None:
        _validate_signature(VALID_SIGNATURE)  # should not raise


class TestWalletAuthResource:

    def _make_resource(self) -> tuple[MagicMock, MagicMock, WalletAuthResource]:
        http = MagicMock()
        tokens = MagicMock()
        resource = WalletAuthResource(http, tokens)
        return http, tokens, resource

    def test_challenge(self) -> None:
        http, tokens, resource = self._make_resource()
        http.post.return_value = {
            "challenge": VALID_CHALLENGE,
            "expiresAt": "2026-03-01T00:00:00Z",
        }

        result = resource.challenge(VALID_ADDRESS)

        http.post.assert_called_once_with(
            "/api/auth/wallet/challenge",
            json={"address": VALID_ADDRESS},
            requires_auth=False,
        )
        assert result.challenge == VALID_CHALLENGE
        assert result.expires_at == "2026-03-01T00:00:00Z"

    def test_challenge_rejects_invalid_address(self) -> None:
        _, _, resource = self._make_resource()
        with pytest.raises(ValueError, match="valid Ethereum address"):
            resource.challenge("bad-addr")

    def test_verify_with_challenge(self) -> None:
        http, tokens, resource = self._make_resource()
        http.post.return_value = {
            "token": "jwt-access",
            "refreshToken": "jwt-refresh",
            "user": {"id": "u1", "email": "w@example.com", "created_at": "", "is_admin": False},
        }

        result = resource.verify(VALID_ADDRESS, VALID_SIGNATURE, VALID_CHALLENGE)

        http.post.assert_called_once_with(
            "/api/auth/wallet/verify",
            json={
                "address": VALID_ADDRESS,
                "signature": VALID_SIGNATURE,
                "challenge": VALID_CHALLENGE,
            },
            requires_auth=False,
        )
        assert result.token == "jwt-access"
        assert result.refresh_token == "jwt-refresh"
        assert result.user.id == "u1"
        tokens.set_tokens.assert_called_once_with("jwt-access", "jwt-refresh")

    def test_verify_without_challenge(self) -> None:
        http, tokens, resource = self._make_resource()
        http.post.return_value = {
            "token": "jwt-access",
            "refreshToken": "jwt-refresh",
            "user": {"id": "u1", "email": "w@example.com", "created_at": "", "is_admin": False},
        }

        result = resource.verify(VALID_ADDRESS, VALID_SIGNATURE)

        http.post.assert_called_once_with(
            "/api/auth/wallet/verify",
            json={
                "address": VALID_ADDRESS,
                "signature": VALID_SIGNATURE,
            },
            requires_auth=False,
        )
        assert result.token == "jwt-access"
        tokens.set_tokens.assert_called_once_with("jwt-access", "jwt-refresh")

    def test_verify_rejects_empty_signature(self) -> None:
        _, _, resource = self._make_resource()
        with pytest.raises(ValueError, match="signature is required"):
            resource.verify(VALID_ADDRESS, "", VALID_CHALLENGE)

    def test_verify_rejects_invalid_signature_format(self) -> None:
        _, _, resource = self._make_resource()
        with pytest.raises(ValueError, match="valid EIP-191 signature"):
            resource.verify(VALID_ADDRESS, "0xshort", VALID_CHALLENGE)

    def test_link_with_challenge(self) -> None:
        http, tokens, resource = self._make_resource()
        http.post.return_value = {
            "success": True,
            "walletAddress": VALID_ADDRESS,
        }

        result = resource.link(VALID_ADDRESS, VALID_SIGNATURE, VALID_CHALLENGE)

        http.post.assert_called_once_with(
            "/api/auth/wallet/link",
            json={
                "address": VALID_ADDRESS,
                "signature": VALID_SIGNATURE,
                "challenge": VALID_CHALLENGE,
            },
        )
        assert result.success is True
        assert result.wallet_address == VALID_ADDRESS

    def test_link_without_challenge(self) -> None:
        http, tokens, resource = self._make_resource()
        http.post.return_value = {
            "success": True,
            "walletAddress": VALID_ADDRESS,
        }

        result = resource.link(VALID_ADDRESS, VALID_SIGNATURE)

        http.post.assert_called_once_with(
            "/api/auth/wallet/link",
            json={
                "address": VALID_ADDRESS,
                "signature": VALID_SIGNATURE,
            },
        )
        assert result.success is True

    def test_link_rejects_invalid_address(self) -> None:
        _, _, resource = self._make_resource()
        with pytest.raises(ValueError, match="valid Ethereum address"):
            resource.link("bad-addr", VALID_SIGNATURE, VALID_CHALLENGE)

    def test_verify_repr_redacts_tokens(self) -> None:
        http, _, resource = self._make_resource()
        http.post.return_value = {
            "token": "secret-jwt",
            "refreshToken": "secret-refresh",
            "user": {"id": "u1", "email": "w@example.com", "created_at": "", "is_admin": False},
        }
        result = resource.verify(VALID_ADDRESS, VALID_SIGNATURE, VALID_CHALLENGE)
        text = repr(result)
        assert "secret-jwt" not in text
        assert "secret-refresh" not in text
        assert "[REDACTED]" in text
