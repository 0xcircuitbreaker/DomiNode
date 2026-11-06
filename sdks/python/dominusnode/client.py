"""DominusNode relay-network clients (sync and async, identical surface)."""

from __future__ import annotations

from typing import Any, Dict, Generator, Optional

import httpx

from ._ops import drive_async, drive_sync
from .constants import DEFAULT_BASE_URL, DEFAULT_HTTP_PROXY_PORT, DEFAULT_PROXY_HOST, DEFAULT_SOCKS5_PROXY_PORT
from .errors import DominusNodeError
from .http_client import AsyncHttpClient, SyncHttpClient
from .resources import (
    AgenticWalletResource, AsyncAgenticWalletResource, AsyncAuthResource, AsyncCreditsResource,
    AsyncKeysResource, AsyncNetworkResource, AsyncNodesResource, AsyncPayoutsResource,
    AsyncPayoutWalletResource, AsyncProxyResource, AsyncSessionsResource, AsyncTeamsResource,
    AsyncUsageResource, AsyncWalletAuthResource, AsyncWalletResource, AsyncX402Resource, AuthResource,
    CreditsResource, KeysResource, NetworkResource, NodesResource, PayoutsResource, PayoutWalletResource,
    ProxyResource, SessionsResource, TeamsResource, UsageResource, WalletAuthResource, WalletResource,
    X402Resource, _AuthResource, _Ctx,
)
from .token_manager import AsyncTokenManager, TokenManager
from .validation import validate_api_key


def _connect_gen(ctx: _Ctx, auth: Any, api_key: str) -> Generator[Any, Any, Dict[str, Any]]:
    validate_api_key(api_key)
    try:
        r = yield from _AuthResource.verify_key(auth, api_key)
    except DominusNodeError as err:
        if err.code == "MFA_REQUIRED":
            ctx.api_key = api_key
            return {"mfaRequired": True}
        raise
    ctx.api_key = api_key
    ctx.tokens.set_tokens(r.get("token"), r.get("refreshToken"))
    return {"mfaRequired": False, "userId": r.get("userId")}


def _disconnect_gen(ctx: _Ctx, auth: Any) -> Generator[Any, Any, None]:
    try:
        if ctx.tokens.has_tokens():
            try:
                yield from _AuthResource.logout(auth)
            except Exception:  # noqa: BLE001 - best effort
                pass
    finally:
        ctx.api_key = None
        ctx.tokens.clear()


class _ClientBase:
    _ctx: _Ctx

    @property
    def is_connected(self) -> bool:
        """True when an API key or any JWT is held."""
        return self._ctx.api_key is not None or self._ctx.tokens.has_tokens()

    def __repr__(self) -> str:
        return f"{type(self).__name__}(connected={'true' if self.is_connected else 'false'})"

    __str__ = __repr__

    def to_json(self) -> Dict[str, Any]:
        return {"connected": self.is_connected}

    def __reduce__(self) -> Any:
        raise TypeError("client cannot be pickled")


class DominusNodeClient(_ClientBase):
    """Synchronous client::

        with DominusNodeClient() as dn:
            dn.connect_with_key(os.environ["DOMINUSNODE_API_KEY"])
            res = dn.proxy.fetch("https://example.com", country="US")
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        proxy_host: str = DEFAULT_PROXY_HOST,
        http_proxy_port: int = DEFAULT_HTTP_PROXY_PORT,
        socks5_proxy_port: int = DEFAULT_SOCKS5_PROXY_PORT,
        access_token: Optional[str] = None,
        refresh_token: Optional[str] = None,
        transport: Optional[httpx.BaseTransport] = None,
        gateway_tls: Any = None,
    ) -> None:
        tokens = TokenManager()
        self._ctx = ctx = _Ctx(tokens)
        self._http = http = SyncHttpClient(base_url, tokens, lambda: ctx.api_key, transport)
        self.auth = AuthResource(http, ctx)
        self.wallet_auth = WalletAuthResource(http, ctx)
        self.keys = KeysResource(http, ctx)
        self.wallet = WalletResource(http, ctx)
        self.agentic_wallets = AgenticWalletResource(http, ctx)
        self.teams = TeamsResource(http, ctx)
        self.usage = UsageResource(http, ctx)
        self.sessions = SessionsResource(http, ctx)
        self.x402 = X402Resource(http, ctx)
        self.network = NetworkResource(http, ctx)
        self.nodes = NodesResource(http, ctx)
        self.credits = CreditsResource(http, ctx)
        self.payout_wallet = PayoutWalletResource(http, ctx)
        self.payouts = PayoutsResource(http, ctx)
        self.proxy = ProxyResource(http, ctx, proxy_host, http_proxy_port, socks5_proxy_port, gateway_tls)

        def refresh(rt: str) -> Any:
            r = self.auth.refresh(rt)
            return r.get("token"), r.get("refreshToken")

        tokens.set_refresh_function(refresh)  # never cleared
        if access_token:
            tokens.set_tokens(access_token, refresh_token)

    def connect_with_key(self, api_key: str) -> Dict[str, Any]:
        """Returns {mfaRequired: False, userId} or {mfaRequired: True} (key-auth routes still work)."""
        return drive_sync(self._http, _connect_gen(self._ctx, self.auth, api_key))

    def disconnect(self) -> None:
        """Best-effort logout, then clear the API key, access token and refresh token."""
        drive_sync(self._http, _disconnect_gen(self._ctx, self.auth))

    def close(self) -> None:
        self.disconnect()
        self._http.close()

    def __enter__(self) -> "DominusNodeClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class AsyncDominusNodeClient(_ClientBase):
    """asyncio client with the same surface; every resource method is a coroutine (signers may be async)."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        proxy_host: str = DEFAULT_PROXY_HOST,
        http_proxy_port: int = DEFAULT_HTTP_PROXY_PORT,
        socks5_proxy_port: int = DEFAULT_SOCKS5_PROXY_PORT,
        access_token: Optional[str] = None,
        refresh_token: Optional[str] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        gateway_tls: Any = None,
    ) -> None:
        tokens = AsyncTokenManager()
        self._ctx = ctx = _Ctx(tokens)
        self._http = http = AsyncHttpClient(base_url, tokens, lambda: ctx.api_key, transport)
        self.auth = AsyncAuthResource(http, ctx)
        self.wallet_auth = AsyncWalletAuthResource(http, ctx)
        self.keys = AsyncKeysResource(http, ctx)
        self.wallet = AsyncWalletResource(http, ctx)
        self.agentic_wallets = AsyncAgenticWalletResource(http, ctx)
        self.teams = AsyncTeamsResource(http, ctx)
        self.usage = AsyncUsageResource(http, ctx)
        self.sessions = AsyncSessionsResource(http, ctx)
        self.x402 = AsyncX402Resource(http, ctx)
        self.network = AsyncNetworkResource(http, ctx)
        self.nodes = AsyncNodesResource(http, ctx)
        self.credits = AsyncCreditsResource(http, ctx)
        self.payout_wallet = AsyncPayoutWalletResource(http, ctx)
        self.payouts = AsyncPayoutsResource(http, ctx)
        self.proxy = AsyncProxyResource(http, ctx, proxy_host, http_proxy_port, socks5_proxy_port, gateway_tls)

        async def refresh(rt: str) -> Any:
            r = await self.auth.refresh(rt)
            return r.get("token"), r.get("refreshToken")

        tokens.set_refresh_function(refresh)
        if access_token:
            tokens.set_tokens(access_token, refresh_token)

    async def connect_with_key(self, api_key: str) -> Dict[str, Any]:
        return await drive_async(self._http, _connect_gen(self._ctx, self.auth, api_key))

    async def disconnect(self) -> None:
        await drive_async(self._http, _disconnect_gen(self._ctx, self.auth))

    async def close(self) -> None:
        await self.disconnect()
        await self._http.close()

    async def __aenter__(self) -> "AsyncDominusNodeClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()
