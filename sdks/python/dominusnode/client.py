"""Dominus Node SDK clients -- sync and async.

Provides ``DominusNodeClient`` for synchronous usage and
``AsyncDominusNodeClient`` for asyncio-based usage. Both share the same
API surface and resource layout.

Example (sync)::

    from dominusnode import DominusNodeClient

    with DominusNodeClient(base_url="http://localhost:3000") as client:
        client.connect_with_credentials("user@example.com", "password123")
        balance = client.wallet.get_balance()
        print(f"Balance: ${balance.balance_usd}")

Example (async)::

    from dominusnode import AsyncDominusNodeClient

    async with AsyncDominusNodeClient(base_url="http://localhost:3000") as client:
        await client.connect_with_credentials("user@example.com", "password123")
        balance = await client.wallet.get_balance()
        print(f"Balance: ${balance.balance_usd}")
"""

from __future__ import annotations

from typing import Optional

import httpx

from .admin import AdminResource, AsyncAdminResource
from .errors import DominusNodeError
from .auth import AsyncAuthResource, AuthResource
from .constants import (
    DEFAULT_BASE_URL,
    DEFAULT_HTTP_PROXY_PORT,
    DEFAULT_PROXY_HOST,
    DEFAULT_SOCKS5_PROXY_PORT,
)
from .http_client import AsyncHttpClient, SyncHttpClient
from .keys import AsyncKeysResource, KeysResource
from .plans import AsyncPlansResource, PlansResource
from .proxy import AsyncProxyResource, ProxyResource
from .sessions import AsyncSessionsResource, SessionsResource
from .slots import AsyncSlotsResource, SlotsResource
from .agent_wallet import AgenticWalletResource, AsyncAgenticWalletResource
from .teams import TeamsResource as TeamsRes, AsyncTeamsResource as AsyncTeamsRes
from .token_manager import AsyncTokenManager, TokenManager
from .types import LoginResult, User
from .usage import AsyncUsageResource, UsageResource
from .wallet import AsyncWalletResource, WalletResource


# ──────────────────────────────────────────────────────────────────────
# Sync Client
# ──────────────────────────────────────────────────────────────────────


class DominusNodeClient:
    """Synchronous Dominus Node API client.

    Args:
        base_url: Base URL of the Dominus Node API server.
        api_key: API key for immediate connection (optional).
        email: Email for credential-based connection (optional).
        password: Password for credential-based connection (optional).
        access_token: Pre-existing access token (optional).
        refresh_token: Pre-existing refresh token (optional).
        proxy_host: Hostname of the proxy server.
        http_proxy_port: HTTP proxy port.
        socks5_proxy_port: SOCKS5 proxy port.
        timeout: HTTP request timeout in seconds.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        api_key: Optional[str] = None,
        email: Optional[str] = None,
        password: Optional[str] = None,
        access_token: Optional[str] = None,
        refresh_token: Optional[str] = None,
        proxy_host: str = DEFAULT_PROXY_HOST,
        http_proxy_port: int = DEFAULT_HTTP_PROXY_PORT,
        socks5_proxy_port: int = DEFAULT_SOCKS5_PROXY_PORT,
        timeout: float = 30.0,
    ) -> None:
        self._api_key: Optional[str] = api_key
        self._proxy_host = proxy_host
        self._http_proxy_port = http_proxy_port
        self._socks5_proxy_port = socks5_proxy_port

        # Token management
        self._token_manager = TokenManager()

        # Wire up the token refresh function
        def _sync_refresh(rt: str) -> tuple[str, str]:
            return self.auth.refresh(rt)

        self._token_manager.set_refresh_fn(_sync_refresh)

        if access_token and refresh_token:
            self._token_manager.set_tokens(access_token, refresh_token)

        # HTTP client
        self._http = SyncHttpClient(base_url, self._token_manager, timeout=timeout)

        # Resource instances
        self._auth = AuthResource(self._http, self._token_manager)
        self._keys = KeysResource(self._http)
        self._wallet = WalletResource(self._http)
        self._usage = UsageResource(self._http)
        self._plans = PlansResource(self._http)
        self._sessions = SessionsResource(self._http)
        self._proxy = ProxyResource(
            self._http,
            proxy_host=proxy_host,
            http_proxy_port=http_proxy_port,
            socks5_proxy_port=socks5_proxy_port,
            get_api_key=lambda: self._api_key,
        )
        self._admin = AdminResource(self._http)
        self._slots = SlotsResource(self._http)
        self._agentic_wallets = AgenticWalletResource(self._http)
        self._teams = TeamsRes(self._http)

        # Auto-connect if credentials provided.
        # On failure, clear credentials to prevent retention in a partial object.
        try:
            if api_key:
                self.connect_with_key(api_key)
            elif email and password:
                self.connect_with_credentials(email, password)
        except Exception:
            self._api_key = None
            self._token_manager.clear()
            raise

    # ── Resource properties ──────────────────────────────────────────

    @property
    def auth(self) -> AuthResource:
        """Auth operations (register, login, MFA, etc.)."""
        return self._auth

    @property
    def keys(self) -> KeysResource:
        """API key management."""
        return self._keys

    @property
    def wallet(self) -> WalletResource:
        """Wallet operations (balance, transactions, top-ups)."""
        return self._wallet

    @property
    def usage(self) -> UsageResource:
        """Usage statistics and data export."""
        return self._usage

    @property
    def plans(self) -> PlansResource:
        """Plan management."""
        return self._plans

    @property
    def sessions(self) -> SessionsResource:
        """Active proxy sessions."""
        return self._sessions

    @property
    def proxy(self) -> ProxyResource:
        """Proxy operations (URL building, health, status, config)."""
        return self._proxy

    @property
    def admin(self) -> AdminResource:
        """Admin operations (requires admin privileges)."""
        return self._admin

    @property
    def slots(self) -> SlotsResource:
        """Slots and waitlist operations (public, no auth required)."""
        return self._slots

    @property
    def agentic_wallets(self) -> AgenticWalletResource:
        """Agentic wallet operations (sub-wallets with spending limits)."""
        return self._agentic_wallets

    @property
    def teams(self) -> TeamsRes:
        """Team operations (shared wallets, members, invites, keys)."""
        return self._teams

    # ── Connection methods ───────────────────────────────────────────

    def connect_with_key(self, api_key: str) -> LoginResult:
        """Authenticate using an API key.

        Verifies the key with the server and stores the resulting JWT tokens.
        """
        self._api_key = api_key
        return self._auth.verify_key(api_key)

    def connect_with_credentials(self, email: str, password: str) -> LoginResult:
        """Authenticate using email and password.

        If MFA is required, the returned LoginResult will have
        ``mfa_required=True``. Call ``complete_mfa()`` to finish.
        """
        return self._auth.login(email, password)

    def complete_mfa(
        self,
        code: str,
        *,
        mfa_challenge_token: Optional[str] = None,
        is_backup_code: bool = False,
    ) -> LoginResult:
        """Complete MFA verification after login."""
        return self._auth.verify_mfa(
            code,
            mfa_challenge_token=mfa_challenge_token,
            is_backup_code=is_backup_code,
        )

    def disconnect(self) -> None:
        """Log out and clear stored tokens."""
        try:
            self._auth.logout()
        except (OSError, httpx.HTTPError, DominusNodeError):
            pass  # Best-effort — server may be unreachable
        self._token_manager.clear()
        self._api_key = None

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._http.close()

    def __enter__(self) -> DominusNodeClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


# ──────────────────────────────────────────────────────────────────────
# Async Client
# ──────────────────────────────────────────────────────────────────────


class AsyncDominusNodeClient:
    """Asynchronous Dominus Node API client.

    Args:
        base_url: Base URL of the Dominus Node API server.
        api_key: API key for immediate connection (optional).
        email: Email for credential-based connection (optional).
        password: Password for credential-based connection (optional).
        access_token: Pre-existing access token (optional).
        refresh_token: Pre-existing refresh token (optional).
        proxy_host: Hostname of the proxy server.
        http_proxy_port: HTTP proxy port.
        socks5_proxy_port: SOCKS5 proxy port.
        timeout: HTTP request timeout in seconds.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        api_key: Optional[str] = None,
        email: Optional[str] = None,
        password: Optional[str] = None,
        access_token: Optional[str] = None,
        refresh_token: Optional[str] = None,
        proxy_host: str = DEFAULT_PROXY_HOST,
        http_proxy_port: int = DEFAULT_HTTP_PROXY_PORT,
        socks5_proxy_port: int = DEFAULT_SOCKS5_PROXY_PORT,
        timeout: float = 30.0,
    ) -> None:
        self._api_key: Optional[str] = api_key
        self._proxy_host = proxy_host
        self._http_proxy_port = http_proxy_port
        self._socks5_proxy_port = socks5_proxy_port
        self._deferred_api_key = api_key
        self._deferred_email = email
        self._deferred_password = password

        # Token management
        self._token_manager = AsyncTokenManager()

        # Wire up the async token refresh function
        async def _async_refresh(rt: str) -> tuple[str, str]:
            return await self.auth.refresh(rt)

        self._token_manager.set_refresh_fn(_async_refresh)

        if access_token and refresh_token:
            self._token_manager.set_tokens(access_token, refresh_token)

        # HTTP client
        self._http = AsyncHttpClient(base_url, self._token_manager, timeout=timeout)

        # Resource instances
        self._auth = AsyncAuthResource(self._http, self._token_manager)
        self._keys = AsyncKeysResource(self._http)
        self._wallet = AsyncWalletResource(self._http)
        self._usage = AsyncUsageResource(self._http)
        self._plans = AsyncPlansResource(self._http)
        self._sessions = AsyncSessionsResource(self._http)
        self._proxy = AsyncProxyResource(
            self._http,
            proxy_host=proxy_host,
            http_proxy_port=http_proxy_port,
            socks5_proxy_port=socks5_proxy_port,
            get_api_key=lambda: self._api_key,
        )
        self._admin = AsyncAdminResource(self._http)
        self._slots = AsyncSlotsResource(self._http)
        self._agentic_wallets = AsyncAgenticWalletResource(self._http)
        self._teams = AsyncTeamsRes(self._http)

    # ── Resource properties ──────────────────────────────────────────

    @property
    def auth(self) -> AsyncAuthResource:
        return self._auth

    @property
    def keys(self) -> AsyncKeysResource:
        return self._keys

    @property
    def wallet(self) -> AsyncWalletResource:
        return self._wallet

    @property
    def usage(self) -> AsyncUsageResource:
        return self._usage

    @property
    def plans(self) -> AsyncPlansResource:
        return self._plans

    @property
    def sessions(self) -> AsyncSessionsResource:
        return self._sessions

    @property
    def proxy(self) -> AsyncProxyResource:
        return self._proxy

    @property
    def admin(self) -> AsyncAdminResource:
        return self._admin

    @property
    def slots(self) -> AsyncSlotsResource:
        return self._slots

    @property
    def agentic_wallets(self) -> AsyncAgenticWalletResource:
        return self._agentic_wallets

    @property
    def teams(self) -> AsyncTeamsRes:
        """Team operations (shared wallets, members, invites, keys)."""
        return self._teams

    # ── Connection methods ───────────────────────────────────────────

    async def connect_with_key(self, api_key: str) -> LoginResult:
        """Authenticate using an API key."""
        self._api_key = api_key
        return await self._auth.verify_key(api_key)

    async def connect_with_credentials(self, email: str, password: str) -> LoginResult:
        """Authenticate using email and password."""
        return await self._auth.login(email, password)

    async def complete_mfa(
        self,
        code: str,
        *,
        mfa_challenge_token: Optional[str] = None,
        is_backup_code: bool = False,
    ) -> LoginResult:
        """Complete MFA verification after login."""
        return await self._auth.verify_mfa(
            code,
            mfa_challenge_token=mfa_challenge_token,
            is_backup_code=is_backup_code,
        )

    async def disconnect(self) -> None:
        """Log out and clear stored tokens."""
        try:
            await self._auth.logout()
        except (OSError, httpx.HTTPError, DominusNodeError):
            pass  # Best-effort — server may be unreachable
        self._token_manager.clear()
        self._api_key = None
        # R25 H-5: Clear deferred credentials to prevent retention after disconnect
        self._deferred_api_key = None
        self._deferred_email = None
        self._deferred_password = None

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._http.close()

    async def __aenter__(self) -> AsyncDominusNodeClient:
        # Handle deferred auto-connect for async
        # Clear credentials in finally to prevent retention on failure (R12 C-1)
        try:
            if self._deferred_api_key and not self._token_manager.has_tokens:
                await self.connect_with_key(self._deferred_api_key)
            elif self._deferred_email and self._deferred_password and not self._token_manager.has_tokens:
                await self.connect_with_credentials(self._deferred_email, self._deferred_password)
        finally:
            self._deferred_api_key = None
            self._deferred_email = None
            self._deferred_password = None
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()
