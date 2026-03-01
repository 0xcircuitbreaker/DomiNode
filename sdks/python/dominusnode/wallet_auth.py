"""Wallet-based authentication using EIP-191 signed messages."""

from __future__ import annotations

import re
from typing import Optional
from dataclasses import dataclass

from .http_client import AsyncHttpClient, SyncHttpClient
from .token_manager import AsyncTokenManager, TokenManager
from .types import LoginResult, User

# Ethereum address: 0x followed by 40 hex characters
_ETH_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")

# EIP-191 signature format: 0x prefix + 130 hex chars (65 bytes)
_EIP191_SIGNATURE_RE = re.compile(r"^0x[0-9a-fA-F]{130}$")
_MAX_SIGNATURE_LENGTH = 200


def _validate_address(address: str) -> None:
    """Validate Ethereum address format."""
    if not address or not isinstance(address, str):
        raise ValueError("address is required and must be a string")
    if not _ETH_ADDRESS_RE.match(address):
        raise ValueError(
            "address must be a valid Ethereum address (0x followed by 40 hex characters)"
        )


def _validate_signature(signature: str) -> None:
    """Validate EIP-191 signature format."""
    if not signature or not isinstance(signature, str):
        raise ValueError("signature is required and must be a string")
    # Max length check before regex
    if len(signature) > _MAX_SIGNATURE_LENGTH:
        raise ValueError(
            f"signature must not exceed {_MAX_SIGNATURE_LENGTH} characters"
        )
    # EIP-191 format validation
    if not _EIP191_SIGNATURE_RE.match(signature):
        raise ValueError(
            "signature must be a valid EIP-191 signature (0x followed by 130 hex characters)"
        )


@dataclass(frozen=True)
class WalletChallenge:
    """Challenge returned by the wallet/challenge endpoint."""
    challenge: str
    expires_at: str


@dataclass(frozen=True, repr=False)
class WalletVerifyResult:
    """Result from wallet/verify -- includes JWT tokens and user.

    When ``mfa_required`` is ``True``, the caller must complete MFA
    verification using ``auth.verify_mfa(code, mfa_challenge_token=result.mfa_challenge_token)``
    before the client is fully authenticated. In this case ``token`` and
    ``refresh_token`` will be empty strings.
    """
    token: str
    refresh_token: str
    user: User
    mfa_required: bool = False
    mfa_challenge_token: Optional[str] = None

    def __repr__(self) -> str:
        return (
            f"WalletVerifyResult(user={self.user!r}, mfa_required={self.mfa_required}, "
            f"token='[REDACTED]', refresh_token='[REDACTED]')"
        )


@dataclass(frozen=True)
class WalletLinkResult:
    """Result from wallet/link."""
    success: bool
    wallet_address: str


def _parse_verify_result(data: dict) -> WalletVerifyResult:
    """Parse verify response into typed result.

    Detect MFA-required responses so callers know to complete MFA
    instead of silently returning empty tokens.
    """
    if data.get("mfaRequired"):
        return WalletVerifyResult(
            token="",
            refresh_token="",
            user=User(id="", email="", created_at=""),
            mfa_required=True,
            mfa_challenge_token=data.get("mfaChallengeToken"),
        )
    user_data = data.get("user", {})
    user = User(
        id=user_data.get("id", ""),
        email=user_data.get("email", ""),
        created_at=str(user_data.get("created_at", "")),
        is_admin=user_data.get("is_admin", False),
    )
    return WalletVerifyResult(
        token=data.get("token", ""),
        refresh_token=data.get("refreshToken", ""),
        user=user,
    )


# ──────────────────────────────────────────────────────────────────────
# Sync
# ──────────────────────────────────────────────────────────────────────


class WalletAuthResource:
    """Synchronous wallet-based authentication operations."""

    def __init__(self, http: SyncHttpClient, tokens: TokenManager) -> None:
        self._http = http
        self._tokens = tokens

    def challenge(self, address: str) -> WalletChallenge:
        """Request a signature challenge for the given Ethereum address.

        No authentication required.
        """
        _validate_address(address)
        data = self._http.post(
            "/api/auth/wallet/challenge",
            json={"address": address},
            requires_auth=False,
        )
        return WalletChallenge(
            challenge=data["challenge"],
            expires_at=data["expiresAt"],
        )

    def verify(self, address: str, signature: str, challenge: str = "") -> WalletVerifyResult:
        """Submit signed challenge to create account or login.

        No authentication required. On success, JWT tokens are stored
        for subsequent authenticated requests.

        Args:
            address: Ethereum address (0x-prefixed, 40 hex chars)
            signature: EIP-191 signature of the challenge message
            challenge: Optional challenge string (server looks up internally)
        """
        _validate_address(address)
        _validate_signature(signature)
        body: dict = {"address": address, "signature": signature}
        if challenge:
            body["challenge"] = challenge
        data = self._http.post(
            "/api/auth/wallet/verify",
            json=body,
            requires_auth=False,
        )
        result = _parse_verify_result(data)
        if result.token and result.refresh_token:
            self._tokens.set_tokens(result.token, result.refresh_token)
        return result

    def link(self, address: str, signature: str, challenge: str = "") -> WalletLinkResult:
        """Link an Ethereum wallet to the current account.

        Requires JWT authentication.
        """
        _validate_address(address)
        _validate_signature(signature)
        body: dict = {"address": address, "signature": signature}
        if challenge:
            body["challenge"] = challenge
        data = self._http.post(
            "/api/auth/wallet/link",
            json=body,
        )
        return WalletLinkResult(
            success=data.get("success", False),
            wallet_address=data.get("walletAddress", ""),
        )


# ──────────────────────────────────────────────────────────────────────
# Async
# ──────────────────────────────────────────────────────────────────────


class AsyncWalletAuthResource:
    """Asynchronous wallet-based authentication operations."""

    def __init__(self, http: AsyncHttpClient, tokens: AsyncTokenManager) -> None:
        self._http = http
        self._tokens = tokens

    async def challenge(self, address: str) -> WalletChallenge:
        """Request a signature challenge (no auth required)."""
        _validate_address(address)
        data = await self._http.post(
            "/api/auth/wallet/challenge",
            json={"address": address},
            requires_auth=False,
        )
        return WalletChallenge(
            challenge=data["challenge"],
            expires_at=data["expiresAt"],
        )

    async def verify(self, address: str, signature: str, challenge: str = "") -> WalletVerifyResult:
        """Submit signed challenge to create account or login (no auth required)."""
        _validate_address(address)
        _validate_signature(signature)
        body: dict = {"address": address, "signature": signature}
        if challenge:
            body["challenge"] = challenge
        data = await self._http.post(
            "/api/auth/wallet/verify",
            json=body,
            requires_auth=False,
        )
        result = _parse_verify_result(data)
        if result.token and result.refresh_token:
            self._tokens.set_tokens(result.token, result.refresh_token)
        return result

    async def link(self, address: str, signature: str, challenge: str = "") -> WalletLinkResult:
        """Link an Ethereum wallet to the current account (requires auth)."""
        _validate_address(address)
        _validate_signature(signature)
        body: dict = {"address": address, "signature": signature}
        if challenge:
            body["challenge"] = challenge
        data = await self._http.post(
            "/api/auth/wallet/link",
            json=body,
        )
        return WalletLinkResult(
            success=data.get("success", False),
            wallet_address=data.get("walletAddress", ""),
        )
