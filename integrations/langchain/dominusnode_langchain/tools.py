"""LangChain tools for interacting with the DomiNode proxy service.

Each tool subclasses ``BaseTool`` from ``langchain_core.tools`` and wraps
the DomiNode Python SDK to expose proxy, wallet, usage, and configuration
operations to LangChain agents.

Security:
    - The ``DominusNodeProxiedFetchTool`` validates URLs to prevent SSRF
      attacks.  Private IP ranges, localhost, and non-HTTP(S) schemes are
      blocked.
    - Response bodies are truncated to 4 000 characters to avoid context
      window overflow.
    - API keys and proxy credentials are never exposed in tool outputs.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from typing import Any, Optional, Type
from urllib.parse import urlparse

import httpx
from langchain_core.callbacks import (
    AsyncCallbackManagerForToolRun,
    CallbackManagerForToolRun,
)
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

from dominusnode import AsyncDominusNodeClient, DominusNodeClient
from dominusnode.types import ProxyUrlOptions

# ──────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────

MAX_RESPONSE_CHARS = 4_000
"""Maximum characters returned from a proxied fetch to prevent LLM context overflow."""

_ALLOWED_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
"""HTTP methods permitted through the proxied fetch tool.  Mutating methods
(POST, PUT, DELETE, PATCH) are intentionally excluded to prevent the LLM
from performing destructive actions through the proxy."""

_ALLOWED_SCHEMES = frozenset({"http", "https"})

# Pre-compiled for hostname validation
_HOSTNAME_RE = re.compile(r"^[a-zA-Z0-9._-]+$")

# OFAC sanctioned countries
_SANCTIONED_COUNTRIES = frozenset({"CU", "IR", "KP", "RU", "SY"})

# Credential scrubbing pattern
_CREDENTIAL_RE = re.compile(r"dn_(live|test)_[a-zA-Z0-9]+")

# Maximum response body size (10 MB)
_MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024


def _sanitize_error(message: str) -> str:
    """Remove DomiNode API key patterns from error messages."""
    return _CREDENTIAL_RE.sub("***", message)


# ──────────────────────────────────────────────────────────────────────
# SSRF validation
# ──────────────────────────────────────────────────────────────────────

# Private / reserved IPv4 networks
_BLOCKED_IPV4_NETWORKS = [
    ipaddress.IPv4Network("0.0.0.0/8"),
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("100.64.0.0/10"),
    ipaddress.IPv4Network("127.0.0.0/8"),
    ipaddress.IPv4Network("169.254.0.0/16"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.0.0.0/24"),
    ipaddress.IPv4Network("192.0.2.0/24"),
    ipaddress.IPv4Network("192.168.0.0/16"),
    ipaddress.IPv4Network("198.18.0.0/15"),
    ipaddress.IPv4Network("198.51.100.0/24"),
    ipaddress.IPv4Network("203.0.113.0/24"),
    ipaddress.IPv4Network("224.0.0.0/4"),
    ipaddress.IPv4Network("240.0.0.0/4"),
    ipaddress.IPv4Network("255.255.255.255/32"),
]

# Private / reserved IPv6 networks
_BLOCKED_IPV6_NETWORKS = [
    ipaddress.IPv6Network("::1/128"),
    ipaddress.IPv6Network("::/128"),
    ipaddress.IPv6Network("::ffff:0:0/96"),  # IPv4-mapped
    ipaddress.IPv6Network("64:ff9b::/96"),
    ipaddress.IPv6Network("100::/64"),
    ipaddress.IPv6Network("fe80::/10"),
    ipaddress.IPv6Network("fc00::/7"),  # includes fd00::/8
    ipaddress.IPv6Network("ff00::/8"),
]


def _is_private_ip(hostname: str) -> bool:
    """Check whether *hostname* resolves to a private/reserved IP address.

    Handles raw IPv4, raw IPv6 (with bracket stripping and zone-ID removal),
    and hex/octal/decimal encoded IP forms.
    """
    # Strip IPv6 brackets
    clean = hostname.strip("[]")
    # Strip IPv6 zone ID (e.g. %25eth0)
    if "%" in clean:
        clean = clean.split("%")[0]

    try:
        addr = ipaddress.ip_address(clean)
    except ValueError:
        # Not a literal IP -- could still be a DNS name that resolves to
        # a private IP but we cannot do DNS resolution safely here.
        # Block well-known aliases.
        lower = hostname.lower()
        if lower in ("localhost", "localhost.localdomain"):
            return True
        if lower.endswith(".localhost"):
            return True
        # Block hex-encoded IPv4 (e.g. 0x7f000001)
        if lower.startswith("0x"):
            try:
                num = int(lower, 16)
                if 0 <= num <= 0xFFFFFFFF:
                    addr = ipaddress.IPv4Address(num)
                    return any(addr in net for net in _BLOCKED_IPV4_NETWORKS)
            except (ValueError, ipaddress.AddressValueError):
                pass
        # Block decimal-encoded IPv4 (e.g. 2130706433)
        if lower.isdigit():
            try:
                num = int(lower)
                if 0 <= num <= 0xFFFFFFFF:
                    addr = ipaddress.IPv4Address(num)
                    return any(addr in net for net in _BLOCKED_IPV4_NETWORKS)
            except (ValueError, ipaddress.AddressValueError):
                pass
        return False

    if isinstance(addr, ipaddress.IPv4Address):
        return any(addr in net for net in _BLOCKED_IPV4_NETWORKS)
    if isinstance(addr, ipaddress.IPv6Address):
        return any(addr in net for net in _BLOCKED_IPV6_NETWORKS)
    return False


def _validate_url(url: str) -> str:
    """Validate and sanitize *url*, returning the cleaned URL.

    Raises ``ValueError`` on any SSRF-risky or malformed input.
    """
    if not url or not isinstance(url, str):
        raise ValueError("URL must be a non-empty string")

    # Limit URL length to prevent abuse
    if len(url) > 2048:
        raise ValueError("URL exceeds maximum length of 2048 characters")

    parsed = urlparse(url)

    # Scheme check
    if parsed.scheme.lower() not in _ALLOWED_SCHEMES:
        raise ValueError(
            f"URL scheme '{parsed.scheme}' is not allowed. "
            f"Only {', '.join(sorted(_ALLOWED_SCHEMES))} are permitted."
        )

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("URL must contain a valid hostname")

    # Block credentials in URL
    if parsed.username or parsed.password:
        raise ValueError("URLs with embedded credentials are not allowed")

    # Block private/reserved IPs
    if _is_private_ip(hostname):
        raise ValueError(
            "URLs targeting private, reserved, or loopback addresses are blocked"
        )

    # DNS rebinding protection: resolve hostname and check all IPs
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        # It is a hostname, not a raw IP -- try resolving
        try:
            infos = socket.getaddrinfo(
                hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM
            )
            for _family, _type, _proto, _canonname, sockaddr in infos:
                addr_str = sockaddr[0]
                if "%" in addr_str:
                    addr_str = addr_str.split("%")[0]
                if _is_private_ip(addr_str):
                    raise ValueError(
                        f"Hostname {hostname!r} resolves to private IP {addr_str}"
                    )
        except socket.gaierror:
            raise ValueError(f"Could not resolve hostname: {hostname!r}")

    return url


# ──────────────────────────────────────────────────────────────────────
# Pydantic input schemas
# ──────────────────────────────────────────────────────────────────────


class ProxiedFetchInput(BaseModel):
    """Input schema for the DomiNode proxied fetch tool."""

    url: str = Field(description="The URL to fetch through the DomiNode proxy.")
    method: str = Field(
        default="GET",
        description="HTTP method (GET, HEAD, or OPTIONS). Default: GET.",
    )
    country: Optional[str] = Field(
        default=None,
        description="ISO 3166-1 alpha-2 country code for geo-targeting (e.g. 'US', 'GB', 'DE').",
    )
    proxy_type: str = Field(
        default="dc",
        description="Proxy type: 'dc' for datacenter ($3/GB) or 'residential' ($5/GB). Default: dc.",
    )


class EmptyInput(BaseModel):
    """Empty input schema for tools that require no parameters."""

    pass


# ──────────────────────────────────────────────────────────────────────
# Tools
# ──────────────────────────────────────────────────────────────────────


class DominusNodeProxiedFetchTool(BaseTool):
    """Make HTTP requests through the DomiNode rotating proxy network.

    Fetches the given URL through a DomiNode proxy IP, optionally targeting a
    specific country.  Returns the HTTP status code and the first 4 000
    characters of the response body.

    Supports both datacenter (cheaper, $3/GB) and residential (premium, $5/GB)
    proxy types.  Only read-only HTTP methods (GET, HEAD, OPTIONS) are allowed.
    """

    name: str = "dominusnode_proxied_fetch"
    description: str = (
        "Fetch a URL through the DomiNode rotating proxy network. "
        "Useful for accessing geo-restricted content or browsing anonymously. "
        "Supports country targeting and both datacenter and residential proxies. "
        "Input: url (required), method (GET/HEAD/OPTIONS), country (e.g. US), "
        "proxy_type (dc or residential)."
    )
    args_schema: Type[BaseModel] = ProxiedFetchInput

    # Client instances -- set after construction via toolkit
    sync_client: Optional[Any] = None
    async_client: Optional[Any] = None

    model_config = {"arbitrary_types_allowed": True}

    def _run(
        self,
        url: str,
        method: str = "GET",
        country: Optional[str] = None,
        proxy_type: str = "dc",
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Execute the tool synchronously."""
        try:
            validated_url = _validate_url(url)
        except ValueError as exc:
            return f"Error: {exc}"

        method_upper = method.upper()
        if method_upper not in _ALLOWED_METHODS:
            return (
                f"Error: HTTP method '{method_upper}' is not allowed. "
                f"Permitted methods: {', '.join(sorted(_ALLOWED_METHODS))}."
            )

        # OFAC sanctioned country check
        if country and country.upper() in _SANCTIONED_COUNTRIES:
            return f"Error: Country '{country.upper()}' is blocked (OFAC sanctioned)"

        if proxy_type not in ("dc", "residential"):
            return "Error: proxy_type must be 'dc' or 'residential'."

        if self.sync_client is None:
            return "Error: No DomiNode client configured. Initialize the toolkit first."

        try:
            options = ProxyUrlOptions(country=country, proxy_type=proxy_type)
            proxy_url = self.sync_client.proxy.build_url(options)

            with httpx.Client(
                proxy=proxy_url,
                timeout=30.0,
                follow_redirects=False,
            ) as http_client:
                response = http_client.request(method_upper, validated_url)

            # Response body size cap (H-9)
            content_length = response.headers.get("content-length", "0")
            try:
                if int(content_length) > _MAX_RESPONSE_BODY_BYTES:
                    return "Error: Response too large (exceeds 10MB limit)"
            except ValueError:
                pass
            if len(response.content) > _MAX_RESPONSE_BODY_BYTES:
                return "Error: Response too large (exceeds 10MB limit)"

            body = response.text[:MAX_RESPONSE_CHARS]
            truncated = " [truncated]" if len(response.text) > MAX_RESPONSE_CHARS else ""

            return (
                f"Status: {response.status_code}\n"
                f"Content-Type: {response.headers.get('content-type', 'unknown')}\n"
                f"Body:\n{body}{truncated}"
            )

        except httpx.HTTPError as exc:
            return f"Error: HTTP request failed: {_sanitize_error(str(exc))}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"

    async def _arun(
        self,
        url: str,
        method: str = "GET",
        country: Optional[str] = None,
        proxy_type: str = "dc",
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> str:
        """Execute the tool asynchronously."""
        try:
            validated_url = _validate_url(url)
        except ValueError as exc:
            return f"Error: {exc}"

        method_upper = method.upper()
        if method_upper not in _ALLOWED_METHODS:
            return (
                f"Error: HTTP method '{method_upper}' is not allowed. "
                f"Permitted methods: {', '.join(sorted(_ALLOWED_METHODS))}."
            )

        # OFAC sanctioned country check
        if country and country.upper() in _SANCTIONED_COUNTRIES:
            return f"Error: Country '{country.upper()}' is blocked (OFAC sanctioned)"

        if proxy_type not in ("dc", "residential"):
            return "Error: proxy_type must be 'dc' or 'residential'."

        if self.async_client is None and self.sync_client is None:
            return "Error: No DomiNode client configured. Initialize the toolkit first."

        try:
            # build_url is synchronous even on the async client
            client_for_url = self.async_client or self.sync_client
            options = ProxyUrlOptions(country=country, proxy_type=proxy_type)
            proxy_url = client_for_url.proxy.build_url(options)

            async with httpx.AsyncClient(
                proxy=proxy_url,
                timeout=30.0,
                follow_redirects=False,
            ) as http_client:
                response = await http_client.request(method_upper, validated_url)

            # Response body size cap (H-9)
            content_length = response.headers.get("content-length", "0")
            try:
                if int(content_length) > _MAX_RESPONSE_BODY_BYTES:
                    return "Error: Response too large (exceeds 10MB limit)"
            except ValueError:
                pass
            if len(response.content) > _MAX_RESPONSE_BODY_BYTES:
                return "Error: Response too large (exceeds 10MB limit)"

            body = response.text[:MAX_RESPONSE_CHARS]
            truncated = " [truncated]" if len(response.text) > MAX_RESPONSE_CHARS else ""

            return (
                f"Status: {response.status_code}\n"
                f"Content-Type: {response.headers.get('content-type', 'unknown')}\n"
                f"Body:\n{body}{truncated}"
            )

        except httpx.HTTPError as exc:
            return f"Error: HTTP request failed: {_sanitize_error(str(exc))}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


class DominusNodeBalanceTool(BaseTool):
    """Check the current DomiNode wallet balance.

    Returns the wallet balance in both USD and cents, useful for monitoring
    spend before making proxied requests.
    """

    name: str = "dominusnode_balance"
    description: str = (
        "Check your DomiNode wallet balance. Returns the current balance "
        "in dollars and cents. No input required."
    )
    args_schema: Type[BaseModel] = EmptyInput

    sync_client: Optional[Any] = None
    async_client: Optional[Any] = None

    model_config = {"arbitrary_types_allowed": True}

    def _run(
        self,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        if self.sync_client is None:
            return "Error: No DomiNode client configured. Initialize the toolkit first."
        try:
            wallet = self.sync_client.wallet.get_balance()
            return (
                f"Balance: ${wallet.balance_usd:.2f} ({wallet.balance_cents} cents)\n"
                f"Currency: {wallet.currency}"
            )
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"

    async def _arun(
        self,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> str:
        if self.async_client is not None:
            try:
                wallet = await self.async_client.wallet.get_balance()
                return (
                    f"Balance: ${wallet.balance_usd:.2f} ({wallet.balance_cents} cents)\n"
                    f"Currency: {wallet.currency}"
                )
            except Exception as exc:
                return f"Error: {_sanitize_error(str(exc))}"

        if self.sync_client is not None:
            return self._run()

        return "Error: No DomiNode client configured. Initialize the toolkit first."


class DominusNodeUsageTool(BaseTool):
    """Check DomiNode proxy usage statistics.

    Returns a summary of bandwidth usage including total bytes transferred,
    cost, and request count.
    """

    name: str = "dominusnode_usage"
    description: str = (
        "Check your DomiNode proxy usage statistics. Returns total bandwidth "
        "used (in GB), total cost, and request count. No input required."
    )
    args_schema: Type[BaseModel] = EmptyInput

    sync_client: Optional[Any] = None
    async_client: Optional[Any] = None

    model_config = {"arbitrary_types_allowed": True}

    def _run(
        self,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        if self.sync_client is None:
            return "Error: No DomiNode client configured. Initialize the toolkit first."
        try:
            usage_resp = self.sync_client.usage.get()
            s = usage_resp.summary
            return (
                f"Usage Summary:\n"
                f"  Total Data: {s.total_gb:.4f} GB ({s.total_bytes:,} bytes)\n"
                f"  Total Cost: ${s.total_cost_usd:.2f} ({s.total_cost_cents} cents)\n"
                f"  Requests: {s.request_count:,}\n"
                f"Period: {usage_resp.period.since} to {usage_resp.period.until}"
            )
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"

    async def _arun(
        self,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> str:
        if self.async_client is not None:
            try:
                usage_resp = await self.async_client.usage.get()
                s = usage_resp.summary
                return (
                    f"Usage Summary:\n"
                    f"  Total Data: {s.total_gb:.4f} GB ({s.total_bytes:,} bytes)\n"
                    f"  Total Cost: ${s.total_cost_usd:.2f} ({s.total_cost_cents} cents)\n"
                    f"  Requests: {s.request_count:,}\n"
                    f"Period: {usage_resp.period.since} to {usage_resp.period.until}"
                )
            except Exception as exc:
                return f"Error: {_sanitize_error(str(exc))}"

        if self.sync_client is not None:
            return self._run()

        return "Error: No DomiNode client configured. Initialize the toolkit first."


class DominusNodeProxyConfigTool(BaseTool):
    """Get DomiNode proxy configuration and supported countries.

    Returns the proxy endpoints, supported countries for geo-targeting,
    and available geo-targeting features.
    """

    name: str = "dominusnode_proxy_config"
    description: str = (
        "Get the DomiNode proxy configuration including supported countries, "
        "proxy endpoints, and geo-targeting capabilities. No input required."
    )
    args_schema: Type[BaseModel] = EmptyInput

    sync_client: Optional[Any] = None
    async_client: Optional[Any] = None

    model_config = {"arbitrary_types_allowed": True}

    def _run(
        self,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        if self.sync_client is None:
            return "Error: No DomiNode client configured. Initialize the toolkit first."
        try:
            config = self.sync_client.proxy.get_config()
            countries = ", ".join(config.supported_countries) if config.supported_countries else "none listed"
            gt = config.geo_targeting
            return (
                f"Proxy Configuration:\n"
                f"  HTTP Proxy: {config.http_proxy.host}:{config.http_proxy.port}\n"
                f"  SOCKS5 Proxy: {config.socks5_proxy.host}:{config.socks5_proxy.port}\n"
                f"  Supported Countries: {countries}\n"
                f"  Blocked Countries: {', '.join(config.blocked_countries) if config.blocked_countries else 'none'}\n"
                f"  Rotation Interval: {config.min_rotation_interval_minutes}-{config.max_rotation_interval_minutes} minutes\n"
                f"Geo-Targeting Features:\n"
                f"  State targeting: {'yes' if gt.state_support else 'no'}\n"
                f"  City targeting: {'yes' if gt.city_support else 'no'}\n"
                f"  ASN targeting: {'yes' if gt.asn_support else 'no'}"
            )
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"

    async def _arun(
        self,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> str:
        if self.async_client is not None:
            try:
                config = await self.async_client.proxy.get_config()
                countries = ", ".join(config.supported_countries) if config.supported_countries else "none listed"
                gt = config.geo_targeting
                return (
                    f"Proxy Configuration:\n"
                    f"  HTTP Proxy: {config.http_proxy.host}:{config.http_proxy.port}\n"
                    f"  SOCKS5 Proxy: {config.socks5_proxy.host}:{config.socks5_proxy.port}\n"
                    f"  Supported Countries: {countries}\n"
                    f"  Blocked Countries: {', '.join(config.blocked_countries) if config.blocked_countries else 'none'}\n"
                    f"  Rotation Interval: {config.min_rotation_interval_minutes}-{config.max_rotation_interval_minutes} minutes\n"
                    f"Geo-Targeting Features:\n"
                    f"  State targeting: {'yes' if gt.state_support else 'no'}\n"
                    f"  City targeting: {'yes' if gt.city_support else 'no'}\n"
                    f"  ASN targeting: {'yes' if gt.asn_support else 'no'}"
                )
            except Exception as exc:
                return f"Error: {_sanitize_error(str(exc))}"

        if self.sync_client is not None:
            return self._run()

        return "Error: No DomiNode client configured. Initialize the toolkit first."
