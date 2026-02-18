"""Proxy resource -- build proxy URLs, health, status, and config."""

from __future__ import annotations

from typing import List, Optional
from urllib.parse import quote

from .errors import ProxyError
from .http_client import AsyncHttpClient, SyncHttpClient
from .types import (
    GeoTargeting,
    ProxyConfig,
    ProxyEndpointConfig,
    ProxyEndpoints,
    ProxyHealth,
    ProxyStatus,
    ProxyUrlOptions,
    ProviderStat,
)


def build_proxy_url(
    api_key: str,
    *,
    proxy_host: str,
    http_proxy_port: int,
    socks5_proxy_port: int,
    options: Optional[ProxyUrlOptions] = None,
) -> str:
    """Build a proxy URL string for use with HTTP clients.

    The Dominus Node proxy uses HTTP Basic auth where:
    - username encodes geo-targeting and session options
    - password is the API key

    Args:
        api_key: The ``dn_live_...`` API key.
        proxy_host: Hostname of the proxy server.
        http_proxy_port: HTTP proxy port (default 8080).
        socks5_proxy_port: SOCKS5 proxy port (default 1080).
        options: Optional geo-targeting and protocol settings.

    Returns:
        A proxy URL like ``http://user:key@host:port``.
    """
    if not api_key:
        raise ProxyError("API key is required to build proxy URL")

    # R31 C-4: Validate proxy_host to prevent URL injection via crafted hostnames
    if any(c in proxy_host for c in " /\\@?#"):
        raise ValueError("proxy_host contains invalid characters")

    opts = options or ProxyUrlOptions()

    # Build username with geo-targeting segments (R13: standardized separator format)
    username_parts: list[str] = ["user"]

    if opts.country:
        username_parts.append(f"country_{quote(opts.country.upper(), safe='')}")

    if opts.state:
        username_parts.append(f"state_{quote(opts.state, safe='')}")

    if opts.city:
        username_parts.append(f"city_{quote(opts.city, safe='')}")

    if opts.asn is not None:
        username_parts.append(f"asn_{opts.asn}")

    if opts.session_id:
        username_parts.append(f"session_{quote(opts.session_id, safe='')}")

    username = "-".join(username_parts)

    # Select port based on protocol
    protocol = opts.protocol.lower()
    if protocol == "socks5":
        port = socks5_proxy_port
        scheme = "socks5"
    else:
        port = http_proxy_port
        scheme = "http"

    # URL-encode password in case of special characters
    encoded_key = quote(api_key, safe="")

    return f"{scheme}://{username}:{encoded_key}@{proxy_host}:{port}"


def _parse_proxy_health(data: dict) -> ProxyHealth:
    return ProxyHealth(
        status=data.get("status", "unknown"),
        active_sessions=data.get("activeSessions", 0),
        uptime_seconds=data.get("uptimeSeconds", 0),
    )


def _parse_provider_stat(p: dict) -> ProviderStat:
    return ProviderStat(
        name=p["name"],
        state=p["state"],
        consecutive_failures=p.get("consecutiveFailures", 0),
        total_requests=p.get("totalRequests", 0),
        total_errors=p.get("totalErrors", 0),
        avg_latency_ms=p.get("avgLatencyMs", 0),
        fallback_only=p.get("fallbackOnly", False),
    )


def _parse_proxy_status(data: dict) -> ProxyStatus:
    endpoints_data = data.get("endpoints", {})
    endpoints = ProxyEndpoints(
        http=endpoints_data.get("http", ""),
        socks5=endpoints_data.get("socks5", ""),
    )
    providers = [_parse_provider_stat(p) for p in data.get("providers", [])]
    return ProxyStatus(
        status=data.get("status", "unknown"),
        active_sessions=data.get("activeSessions", 0),
        user_active_sessions=data.get("userActiveSessions", 0),
        avg_latency_ms=data.get("avgLatencyMs", 0),
        providers=providers,
        endpoints=endpoints,
        supported_countries=data.get("supportedCountries", []),
        uptime_seconds=data.get("uptimeSeconds", 0),
    )


def _parse_proxy_config(data: dict) -> ProxyConfig:
    hp = data.get("httpProxy", {})
    sp = data.get("socks5Proxy", {})
    gt = data.get("geoTargeting", {})
    return ProxyConfig(
        http_proxy=ProxyEndpointConfig(host=hp.get("host", ""), port=hp.get("port", 8080)),
        socks5_proxy=ProxyEndpointConfig(host=sp.get("host", ""), port=sp.get("port", 1080)),
        supported_countries=data.get("supportedCountries", []),
        blocked_countries=data.get("blockedCountries", []),
        max_rotation_interval_minutes=data.get("maxRotationIntervalMinutes", 60),
        min_rotation_interval_minutes=data.get("minRotationIntervalMinutes", 1),
        geo_targeting=GeoTargeting(
            state_support=gt.get("stateSupport", False),
            city_support=gt.get("citySupport", False),
            asn_support=gt.get("asnSupport", False),
            us_states=gt.get("usStates", []),
            major_us_cities=gt.get("majorUsCities", []),
        ),
    )


# ──────────────────────────────────────────────────────────────────────
# Sync
# ──────────────────────────────────────────────────────────────────────


class ProxyResource:
    """Synchronous proxy operations."""

    def __init__(
        self,
        http: SyncHttpClient,
        *,
        proxy_host: str,
        http_proxy_port: int,
        socks5_proxy_port: int,
        get_api_key: callable,
    ) -> None:
        self._http = http
        self._proxy_host = proxy_host
        self._http_proxy_port = http_proxy_port
        self._socks5_proxy_port = socks5_proxy_port
        self._get_api_key = get_api_key

    def build_url(self, options: Optional[ProxyUrlOptions] = None) -> str:
        """Build a proxy URL using the current API key and options."""
        api_key = self._get_api_key()
        if not api_key:
            raise ProxyError("No API key set. Call connect_with_key() first.")
        return build_proxy_url(
            api_key,
            proxy_host=self._proxy_host,
            http_proxy_port=self._http_proxy_port,
            socks5_proxy_port=self._socks5_proxy_port,
            options=options,
        )

    def get_health(self) -> ProxyHealth:
        """Get public proxy health status (no auth required)."""
        data = self._http.get("/api/proxy/health")
        return _parse_proxy_health(data)

    def get_status(self) -> ProxyStatus:
        """Get detailed proxy status (auth required)."""
        data = self._http.get("/api/proxy/status")
        return _parse_proxy_status(data)

    def get_config(self) -> ProxyConfig:
        """Get proxy server configuration (auth required)."""
        data = self._http.get("/api/proxy/config")
        return _parse_proxy_config(data)


# ──────────────────────────────────────────────────────────────────────
# Async
# ──────────────────────────────────────────────────────────────────────


class AsyncProxyResource:
    """Asynchronous proxy operations."""

    def __init__(
        self,
        http: AsyncHttpClient,
        *,
        proxy_host: str,
        http_proxy_port: int,
        socks5_proxy_port: int,
        get_api_key: callable,
    ) -> None:
        self._http = http
        self._proxy_host = proxy_host
        self._http_proxy_port = http_proxy_port
        self._socks5_proxy_port = socks5_proxy_port
        self._get_api_key = get_api_key

    def build_url(self, options: Optional[ProxyUrlOptions] = None) -> str:
        """Build a proxy URL (synchronous -- no network call needed)."""
        api_key = self._get_api_key()
        if not api_key:
            raise ProxyError("No API key set. Call connect_with_key() first.")
        return build_proxy_url(
            api_key,
            proxy_host=self._proxy_host,
            http_proxy_port=self._http_proxy_port,
            socks5_proxy_port=self._socks5_proxy_port,
            options=options,
        )

    async def get_health(self) -> ProxyHealth:
        data = await self._http.get("/api/proxy/health")
        return _parse_proxy_health(data)

    async def get_status(self) -> ProxyStatus:
        data = await self._http.get("/api/proxy/status")
        return _parse_proxy_status(data)

    async def get_config(self) -> ProxyConfig:
        data = await self._http.get("/api/proxy/config")
        return _parse_proxy_config(data)
