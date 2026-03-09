"""Auth resource -- registration, login, MFA, token refresh, and password management."""

from __future__ import annotations

import hashlib
from typing import Optional

from .http_client import AsyncHttpClient, SyncHttpClient
from .token_manager import AsyncTokenManager, TokenManager
from .types import LoginResult, MfaSetup, MfaStatus, User

_POW_MAX_NONCE = 100_000_000


def _count_leading_zero_bits(hash_bytes: bytes) -> int:
    """Count leading zero bits in a hash digest."""
    count = 0
    for byte in hash_bytes:
        if byte == 0:
            count += 8
        else:
            mask = 0x80
            while mask and not (byte & mask):
                count += 1
                mask >>= 1
            break
    return count


def _parse_login_result(data: dict) -> LoginResult:
    """Parse a login/register response into a LoginResult."""
    if data.get("mfaRequired"):
        return LoginResult(
            mfa_required=True,
            mfa_challenge_token=data.get("mfaChallengeToken"),
        )

    user_data = data.get("user")
    user = None
    if user_data:
        user = User(
            id=user_data["id"],
            email=user_data["email"],
            created_at=str(user_data.get("created_at", "")),
            is_admin=user_data.get("is_admin", False),
        )

    return LoginResult(
        user=user,
        token=data.get("token"),
        refresh_token=data.get("refreshToken"),
    )


# ──────────────────────────────────────────────────────────────────────
# Sync
# ──────────────────────────────────────────────────────────────────────


class AuthResource:
    """Synchronous auth operations."""

    def __init__(self, http: SyncHttpClient, tokens: TokenManager) -> None:
        self._http = http
        self._tokens = tokens

    def _solve_pow(self) -> dict | None:
        """Request a PoW challenge and solve it. Returns {challengeId, nonce} or None."""
        try:
            challenge = self._http.post("/api/auth/pow/challenge", json={})
            challenge_id: str = challenge["challengeId"]
            prefix: str = challenge["prefix"]
            difficulty: int = challenge["difficulty"]

            for nonce in range(_POW_MAX_NONCE):
                digest = hashlib.sha256((prefix + str(nonce)).encode()).digest()
                if _count_leading_zero_bits(digest) >= difficulty:
                    return {"challengeId": challenge_id, "nonce": nonce}
            return None
        except Exception:
            return None

    def register(self, email: str, password: str) -> LoginResult:
        """Create a new account and return tokens."""
        body: dict = {"email": email, "password": password}
        pow_result = self._solve_pow()
        if pow_result is not None:
            body["pow"] = pow_result
        data = self._http.post("/api/auth/register", json=body)
        result = _parse_login_result(data)
        if result.token and result.refresh_token:
            self._tokens.set_tokens(result.token, result.refresh_token)
        return result

    def login(self, email: str, password: str) -> LoginResult:
        """Authenticate with email/password. May require MFA."""
        data = self._http.post("/api/auth/login", json={"email": email, "password": password})
        result = _parse_login_result(data)
        if result.token and result.refresh_token:
            self._tokens.set_tokens(result.token, result.refresh_token)
        return result

    def verify_mfa(
        self,
        code: str,
        *,
        mfa_challenge_token: Optional[str] = None,
        is_backup_code: bool = False,
    ) -> LoginResult:
        """Complete MFA challenge with TOTP code or backup code."""
        payload: dict = {"code": code, "isBackupCode": is_backup_code}
        if mfa_challenge_token:
            payload["mfaChallengeToken"] = mfa_challenge_token
        data = self._http.post("/api/auth/mfa/verify", json=payload)
        result = _parse_login_result(data)
        if result.token and result.refresh_token:
            self._tokens.set_tokens(result.token, result.refresh_token)
        return result

    def refresh(self, refresh_token: Optional[str] = None) -> tuple[str, str]:
        """Exchange refresh token for new token pair.

        Returns (access_token, refresh_token) tuple.
        """
        rt = refresh_token or self._tokens.refresh_token
        if not rt:
            raise ValueError("No refresh token available")
        data = self._http.post("/api/auth/refresh", json={"refreshToken": rt})
        access = data["token"]
        new_refresh = data["refreshToken"]
        self._tokens.set_tokens(access, new_refresh)
        return (access, new_refresh)

    def logout(self) -> None:
        """Revoke all refresh tokens for the current user."""
        self._http.post("/api/auth/logout")
        self._tokens.clear()

    def me(self) -> User:
        """Get current authenticated user."""
        data = self._http.get("/api/auth/me")
        u = data["user"]
        return User(
            id=u["id"],
            email=u["email"],
            created_at=str(u.get("created_at", "")),
            is_admin=u.get("is_admin", False),
        )

    def change_password(self, current_password: str, new_password: str) -> None:
        """Change the current user's password."""
        self._http.post(
            "/api/auth/change-password",
            json={"currentPassword": current_password, "newPassword": new_password},
        )

    def verify_key(self, api_key: str) -> LoginResult:
        """Verify an API key and get JWT tokens."""
        data = self._http.post("/api/auth/verify-key", json={"apiKey": api_key})
        result = LoginResult(
            token=data.get("token"),
            refresh_token=data.get("refreshToken"),
            user=User(
                id=data.get("userId", ""),
                email=data.get("email", ""),
                created_at="",
            ) if data.get("userId") else None,
        )
        if result.token and result.refresh_token:
            self._tokens.set_tokens(result.token, result.refresh_token)
        return result

    def mfa_setup(self) -> MfaSetup:
        """Generate TOTP secret and backup codes for MFA setup."""
        data = self._http.post("/api/auth/mfa/setup")
        return MfaSetup(
            secret=data["secret"],
            otpauth_uri=data["otpauthUri"],
            backup_codes=data.get("backupCodes", []),
        )

    def mfa_enable(self, code: str) -> bool:
        """Verify initial TOTP code to activate MFA."""
        data = self._http.post("/api/auth/mfa/enable", json={"code": code})
        return data.get("enabled", False)

    def mfa_disable(self, password: str, code: str) -> bool:
        """Disable MFA (requires password + TOTP/backup code)."""
        data = self._http.post("/api/auth/mfa/disable", json={"password": password, "code": code})
        return not data.get("enabled", True)

    def mfa_status(self) -> MfaStatus:
        """Check current MFA status."""
        data = self._http.get("/api/auth/mfa/status")
        return MfaStatus(
            enabled=data["enabled"],
            backup_codes_remaining=data.get("backupCodesRemaining", 0),
        )


# ──────────────────────────────────────────────────────────────────────
# Async
# ──────────────────────────────────────────────────────────────────────


class AsyncAuthResource:
    """Asynchronous auth operations."""

    def __init__(self, http: AsyncHttpClient, tokens: AsyncTokenManager) -> None:
        self._http = http
        self._tokens = tokens

    async def _solve_pow(self) -> dict | None:
        """Request a PoW challenge and solve it. Returns {challengeId, nonce} or None."""
        try:
            challenge = await self._http.post("/api/auth/pow/challenge", json={})
            challenge_id: str = challenge["challengeId"]
            prefix: str = challenge["prefix"]
            difficulty: int = challenge["difficulty"]

            for nonce in range(_POW_MAX_NONCE):
                digest = hashlib.sha256((prefix + str(nonce)).encode()).digest()
                if _count_leading_zero_bits(digest) >= difficulty:
                    return {"challengeId": challenge_id, "nonce": nonce}
            return None
        except Exception:
            return None

    async def register(self, email: str, password: str) -> LoginResult:
        body: dict = {"email": email, "password": password}
        pow_result = await self._solve_pow()
        if pow_result is not None:
            body["pow"] = pow_result
        data = await self._http.post("/api/auth/register", json=body)
        result = _parse_login_result(data)
        if result.token and result.refresh_token:
            self._tokens.set_tokens(result.token, result.refresh_token)
        return result

    async def login(self, email: str, password: str) -> LoginResult:
        data = await self._http.post("/api/auth/login", json={"email": email, "password": password})
        result = _parse_login_result(data)
        if result.token and result.refresh_token:
            self._tokens.set_tokens(result.token, result.refresh_token)
        return result

    async def verify_mfa(
        self,
        code: str,
        *,
        mfa_challenge_token: Optional[str] = None,
        is_backup_code: bool = False,
    ) -> LoginResult:
        payload: dict = {"code": code, "isBackupCode": is_backup_code}
        if mfa_challenge_token:
            payload["mfaChallengeToken"] = mfa_challenge_token
        data = await self._http.post("/api/auth/mfa/verify", json=payload)
        result = _parse_login_result(data)
        if result.token and result.refresh_token:
            self._tokens.set_tokens(result.token, result.refresh_token)
        return result

    async def refresh(self, refresh_token: Optional[str] = None) -> tuple[str, str]:
        rt = refresh_token or self._tokens.refresh_token
        if not rt:
            raise ValueError("No refresh token available")
        data = await self._http.post("/api/auth/refresh", json={"refreshToken": rt})
        access = data["token"]
        new_refresh = data["refreshToken"]
        self._tokens.set_tokens(access, new_refresh)
        return (access, new_refresh)

    async def logout(self) -> None:
        await self._http.post("/api/auth/logout")
        self._tokens.clear()

    async def me(self) -> User:
        data = await self._http.get("/api/auth/me")
        u = data["user"]
        return User(
            id=u["id"],
            email=u["email"],
            created_at=str(u.get("created_at", "")),
            is_admin=u.get("is_admin", False),
        )

    async def change_password(self, current_password: str, new_password: str) -> None:
        await self._http.post(
            "/api/auth/change-password",
            json={"currentPassword": current_password, "newPassword": new_password},
        )

    async def verify_key(self, api_key: str) -> LoginResult:
        data = await self._http.post("/api/auth/verify-key", json={"apiKey": api_key})
        result = LoginResult(
            token=data.get("token"),
            refresh_token=data.get("refreshToken"),
            user=User(
                id=data.get("userId", ""),
                email=data.get("email", ""),
                created_at="",
            ) if data.get("userId") else None,
        )
        if result.token and result.refresh_token:
            self._tokens.set_tokens(result.token, result.refresh_token)
        return result

    async def mfa_setup(self) -> MfaSetup:
        data = await self._http.post("/api/auth/mfa/setup")
        return MfaSetup(
            secret=data["secret"],
            otpauth_uri=data["otpauthUri"],
            backup_codes=data.get("backupCodes", []),
        )

    async def mfa_enable(self, code: str) -> bool:
        data = await self._http.post("/api/auth/mfa/enable", json={"code": code})
        return data.get("enabled", False)

    async def mfa_disable(self, password: str, code: str) -> bool:
        data = await self._http.post("/api/auth/mfa/disable", json={"password": password, "code": code})
        return not data.get("enabled", True)

    async def mfa_status(self) -> MfaStatus:
        data = await self._http.get("/api/auth/mfa/status")
        return MfaStatus(
            enabled=data["enabled"],
            backup_codes_remaining=data.get("backupCodesRemaining", 0),
        )
