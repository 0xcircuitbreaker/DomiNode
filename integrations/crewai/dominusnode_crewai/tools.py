"""CrewAI tool implementations for DomiNode proxy service.

Each tool subclasses ``crewai.tools.BaseTool`` and manages its own
DomiNode SDK client connection.

Security:
    - URL validation blocks SSRF (private IPs, localhost, non-HTTP schemes).
    - API keys are never exposed in tool outputs.
    - Response bodies are truncated to 4000 characters to stay within LLM
      context limits.
"""

from __future__ import annotations

import ipaddress
import os
import re
import socket
from typing import Any, Optional, Type
from urllib.parse import urlparse

import httpx
from crewai.tools import BaseTool
from pydantic import BaseModel, Field

from dominusnode import DominusNodeClient
from dominusnode.types import ProxyUrlOptions

# ---------------------------------------------------------------------------
# Pricing constants (match backend PRICE_PER_GB_CENTS)
# ---------------------------------------------------------------------------

_DC_PRICE_PER_GB_CENTS = 300
_RESIDENTIAL_PRICE_PER_GB_CENTS = 500
_BYTES_PER_GB = 1_073_741_824

# OFAC sanctioned countries
_SANCTIONED_COUNTRIES = frozenset({"CU", "IR", "KP", "RU", "SY"})

# Credential scrubbing pattern
_CREDENTIAL_RE = re.compile(r"dn_(live|test)_[a-zA-Z0-9]+")

# Maximum response body size (10 MB)
_MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024


def _sanitize_error(message: str) -> str:
    """Remove DomiNode API key patterns from error messages."""
    return _CREDENTIAL_RE.sub("***", message)

# ---------------------------------------------------------------------------
# SSRF protection helpers
# ---------------------------------------------------------------------------

# Regex for decimal-encoded IPs like http://2130706433
_DECIMAL_IP_RE = re.compile(r"^\d{8,10}$")

# Regex for octal-encoded octets like 0177.0.0.1
_OCTAL_OCTET_RE = re.compile(r"^0\d+$")


def _is_private_ip(host: str) -> bool:
    """Return True if *host* resolves to a private, loopback, or link-local address."""
    # Strip IPv6 brackets and zone ID
    clean = host.strip("[]")
    if "%" in clean:
        clean = clean.split("%")[0]

    try:
        addr = ipaddress.ip_address(clean)
    except ValueError:
        return False

    if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved:
        return True

    if isinstance(addr, ipaddress.IPv6Address):
        # IPv4-compatible IPv6 (::x.x.x.x or hex form ::7f00:1)
        packed = addr.packed
        if all(b == 0 for b in packed[:12]):
            embedded = ipaddress.IPv4Address(packed[12:16])
            if embedded.is_private or embedded.is_loopback or embedded.is_reserved:
                return True

        # Teredo tunneling (2001:0000::/32) -- block unconditionally
        ip_lower = clean.lower()
        if ip_lower.startswith("2001:0000:") or ip_lower.startswith("2001:0:"):
            return True

        # 6to4 tunneling (2002::/16) -- block unconditionally
        if ip_lower.startswith("2002:"):
            return True

        # IPv6 multicast (ff00::/8)
        if ip_lower.startswith("ff"):
            return True

    return False


def _has_octal_octets(host: str) -> bool:
    """Detect octal-encoded IPv4 like 0177.0.0.01."""
    parts = host.split(".")
    if len(parts) != 4:
        return False
    return any(_OCTAL_OCTET_RE.match(p) for p in parts)


def _validate_url(url: str) -> str:
    """Validate and sanitise a URL for safe external fetching.

    Raises ``ValueError`` for disallowed schemes, private IPs, and other
    SSRF-prone patterns.
    """
    if not url or not url.strip():
        raise ValueError("URL must not be empty")

    parsed = urlparse(url)

    # -- Scheme check -------------------------------------------------------
    if parsed.scheme not in ("http", "https"):
        raise ValueError(
            f"Only http and https schemes are allowed, got: {parsed.scheme!r}"
        )

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("URL must contain a valid hostname")

    # Block embedded credentials in URL
    if parsed.username or parsed.password:
        raise ValueError("URLs with embedded credentials are not allowed")

    # Strip IPv6 zone IDs (%25... or %...)
    if "%" in hostname:
        hostname = hostname.split("%")[0]

    # -- Block decimal / octal IP tricks ------------------------------------
    if _DECIMAL_IP_RE.match(hostname):
        raise ValueError("Decimal-encoded IP addresses are not allowed")

    if _has_octal_octets(hostname):
        raise ValueError("Octal-encoded IP addresses are not allowed")

    # -- Block known dangerous hostnames ------------------------------------
    lower = hostname.lower()
    blocked_hosts = (
        "localhost",
        "metadata.google.internal",
        "169.254.169.254",
    )
    if lower in blocked_hosts:
        raise ValueError(f"Hostname {hostname!r} is blocked")

    if lower == "localhost.localdomain" or lower.endswith(".localhost"):
        raise ValueError(f"Hostname {hostname!r} is blocked")

    if lower.endswith(".internal") or lower.endswith(".local") or lower.endswith(".arpa"):
        raise ValueError(f"Hostname {hostname!r} is in a blocked domain suffix")

    # -- Resolve and check IP -----------------------------------------------
    if _is_private_ip(hostname):
        raise ValueError(f"Hostname {hostname!r} resolves to a private/reserved IP")

    # For non-IP hostnames, attempt DNS resolution to catch private-IP CNAMEs
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        # It is a hostname, not a raw IP -- try resolving
        try:
            infos = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
            for _family, _type, _proto, _canonname, sockaddr in infos:
                addr_str = sockaddr[0]
                # Strip IPv6 zone ID
                if "%" in addr_str:
                    addr_str = addr_str.split("%")[0]
                if _is_private_ip(addr_str):
                    raise ValueError(
                        f"Hostname {hostname!r} resolves to private IP {addr_str}"
                    )
        except socket.gaierror:
            raise ValueError(f"Could not resolve hostname: {hostname!r}")

    return url


# ---------------------------------------------------------------------------
# Pydantic input schemas for CrewAI tools
# ---------------------------------------------------------------------------


class WebScrapeInput(BaseModel):
    """Input schema for the DomiNode web scrape tool."""

    url: str = Field(description="The URL to fetch through the proxy network.")
    country: Optional[str] = Field(
        default=None,
        description="Two-letter country code for geo-targeting (e.g., 'US', 'GB', 'DE').",
    )
    proxy_type: str = Field(
        default="dc",
        description="Proxy type: 'dc' for datacenter ($3/GB) or 'residential' ($5/GB).",
    )


class BalanceInput(BaseModel):
    """Input schema for the DomiNode balance tool."""

    # No required inputs -- the tool just checks the current balance.
    pass


class GeoTargetInput(BaseModel):
    """Input schema for the DomiNode geo-targets tool."""

    # No required inputs -- the tool just lists available locations.
    pass


class TopupPaypalInput(BaseModel):
    """Input schema for the DomiNode PayPal top-up tool."""

    amount_cents: int = Field(
        description="Amount in cents to top up via PayPal (min 500 = $5, max 100000 = $1,000).",
    )


# ---------------------------------------------------------------------------
# Helper: create an authenticated SDK client
# ---------------------------------------------------------------------------


def _make_client(
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    proxy_host: Optional[str] = None,
) -> DominusNodeClient:
    """Create and authenticate a ``DominusNodeClient``.

    Falls back to the ``DOMINUSNODE_API_KEY``, ``DOMINUSNODE_BASE_URL``,
    and ``DOMINUSNODE_PROXY_HOST`` environment variables when the
    corresponding arguments are not provided.
    """
    key = api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
    if not key:
        raise RuntimeError(
            "DomiNode API key is required.  Pass api_key= or set DOMINUSNODE_API_KEY."
        )

    url = base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
    host = proxy_host or os.environ.get("DOMINUSNODE_PROXY_HOST", "proxy.dominusnode.com")

    client = DominusNodeClient(base_url=url, api_key=key, proxy_host=host)
    return client


# ---------------------------------------------------------------------------
# Tool 1: Web Scrape
# ---------------------------------------------------------------------------


class DominusNodeWebScrapeTool(BaseTool):
    """Fetch web page content through DomiNode's rotating proxy network.

    Useful for accessing geo-restricted content or avoiding IP blocks when
    scraping. Supports datacenter and residential proxy types with optional
    country-level geo-targeting.
    """

    name: str = "dominusnode_web_scrape"
    description: str = (
        "Fetch web page content through DomiNode's rotating proxy network. "
        "Useful for accessing geo-restricted content or avoiding IP blocks. "
        "Input requires a URL. Optionally specify a two-letter country code "
        "and proxy_type ('dc' or 'residential')."
    )
    args_schema: Type[BaseModel] = WebScrapeInput

    # -- Configuration (not exposed to the LLM) ----------------------------
    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    proxy_host: Optional[str] = Field(default=None, exclude=True)

    _max_body_chars: int = 4000

    def _run(
        self,
        url: str,
        country: Optional[str] = None,
        proxy_type: str = "dc",
    ) -> str:
        # Validate URL (SSRF protection)
        try:
            validated_url = _validate_url(url)
        except ValueError as exc:
            return f"Error: URL validation failed -- {exc}"

        # OFAC sanctioned country check
        if country and country.upper() in _SANCTIONED_COUNTRIES:
            return f"Error: Country '{country.upper()}' is blocked (OFAC sanctioned)"

        # Normalise proxy_type
        ptype = proxy_type.lower().strip()
        if ptype not in ("dc", "residential"):
            return "Error: proxy_type must be 'dc' or 'residential'."

        client: Optional[DominusNodeClient] = None
        try:
            client = _make_client(
                api_key=self.api_key,
                base_url=self.base_url,
                proxy_host=self.proxy_host,
            )

            # Build proxy URL via SDK
            options = ProxyUrlOptions(
                country=country.upper() if country else None,
                protocol="http",
            )
            proxy_url = client.proxy.build_url(options)

            # Fetch through the proxy
            with httpx.Client(
                proxy=proxy_url,
                timeout=30.0,
                follow_redirects=False,
            ) as http:
                response = http.get(validated_url)

            # Response body size cap (H-10)
            content_length = response.headers.get("content-length", "0")
            try:
                if int(content_length) > _MAX_RESPONSE_BODY_BYTES:
                    return "Error: Response too large (exceeds 10MB limit)"
            except ValueError:
                pass
            if len(response.content) > _MAX_RESPONSE_BODY_BYTES:
                return "Error: Response too large (exceeds 10MB limit)"

            body = response.text[: self._max_body_chars]
            truncated = " [truncated]" if len(response.text) > self._max_body_chars else ""

            return (
                f"Status: {response.status_code}\n"
                f"Content-Type: {response.headers.get('content-type', 'unknown')}\n"
                f"Body ({len(response.text)} chars{truncated}):\n{body}"
            )

        except RuntimeError as exc:
            return f"Error: {_sanitize_error(str(exc))}"
        except httpx.HTTPError as exc:
            return f"Error: HTTP request failed -- {_sanitize_error(str(exc))}"
        except Exception as exc:
            return f"Error: {type(exc).__name__} -- {_sanitize_error(str(exc))}"
        finally:
            if client is not None:
                client.close()


# ---------------------------------------------------------------------------
# Tool 2: Balance Check
# ---------------------------------------------------------------------------


class DominusNodeBalanceTool(BaseTool):
    """Check remaining proxy balance and estimate browsing budget.

    Returns the current wallet balance in dollars together with an estimate
    of how many gigabytes of proxy traffic remain at datacenter and
    residential rates.
    """

    name: str = "dominusnode_check_balance"
    description: str = (
        "Check remaining proxy balance and estimate how much browsing budget "
        "is left. Returns balance in dollars and estimated GB remaining at "
        "datacenter ($3/GB) and residential ($5/GB) rates."
    )
    args_schema: Type[BaseModel] = BalanceInput

    # -- Configuration (not exposed to the LLM) ----------------------------
    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    proxy_host: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        client: Optional[DominusNodeClient] = None
        try:
            client = _make_client(
                api_key=self.api_key,
                base_url=self.base_url,
                proxy_host=self.proxy_host,
            )

            wallet = client.wallet.get_balance()

            balance_cents = wallet.balance_cents
            balance_usd = balance_cents / 100.0

            dc_gb = balance_cents / _DC_PRICE_PER_GB_CENTS if _DC_PRICE_PER_GB_CENTS else 0
            res_gb = (
                balance_cents / _RESIDENTIAL_PRICE_PER_GB_CENTS
                if _RESIDENTIAL_PRICE_PER_GB_CENTS
                else 0
            )

            return (
                f"Wallet Balance: ${balance_usd:.2f}\n"
                f"Estimated remaining:\n"
                f"  - Datacenter proxy:    {dc_gb:.2f} GB (at $3.00/GB)\n"
                f"  - Residential proxy:   {res_gb:.2f} GB (at $5.00/GB)"
            )

        except RuntimeError as exc:
            return f"Error: {_sanitize_error(str(exc))}"
        except Exception as exc:
            return f"Error: {type(exc).__name__} -- {_sanitize_error(str(exc))}"
        finally:
            if client is not None:
                client.close()


# ---------------------------------------------------------------------------
# Tool 3: Geo Targeting
# ---------------------------------------------------------------------------


class DominusNodeGeoTargetTool(BaseTool):
    """List available proxy server countries and geo-targeting options.

    Queries the DomiNode API for the current proxy configuration including
    supported countries, US state targeting, city targeting, and ASN
    targeting capabilities.
    """

    name: str = "dominusnode_geo_targets"
    description: str = (
        "List available proxy server countries and geo-targeting options. "
        "Returns supported countries, US state targeting, city targeting, "
        "and ASN targeting capabilities."
    )
    args_schema: Type[BaseModel] = GeoTargetInput

    # -- Configuration (not exposed to the LLM) ----------------------------
    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    proxy_host: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        client: Optional[DominusNodeClient] = None
        try:
            client = _make_client(
                api_key=self.api_key,
                base_url=self.base_url,
                proxy_host=self.proxy_host,
            )

            config = client.proxy.get_config()

            countries = ", ".join(config.supported_countries) if config.supported_countries else "None listed"
            blocked = ", ".join(config.blocked_countries) if config.blocked_countries else "None"

            geo = config.geo_targeting
            features: list[str] = []
            if geo.state_support:
                features.append("US state targeting")
            if geo.city_support:
                features.append("City targeting")
            if geo.asn_support:
                features.append("ASN targeting")
            features_str = ", ".join(features) if features else "Country-level only"

            lines = [
                "DomiNode Geo-Targeting Options:",
                f"  Supported countries: {countries}",
                f"  Blocked countries:   {blocked}",
                f"  Targeting features:  {features_str}",
            ]

            if geo.us_states:
                states_str = ", ".join(str(s) for s in geo.us_states[:20])
                if len(geo.us_states) > 20:
                    states_str += f" ... and {len(geo.us_states) - 20} more"
                lines.append(f"  US states:           {states_str}")

            if geo.major_us_cities:
                cities_str = ", ".join(str(c) for c in geo.major_us_cities[:10])
                if len(geo.major_us_cities) > 10:
                    cities_str += f" ... and {len(geo.major_us_cities) - 10} more"
                lines.append(f"  Major US cities:     {cities_str}")

            lines.extend([
                f"  Rotation interval:   {config.min_rotation_interval_minutes}-{config.max_rotation_interval_minutes} minutes",
            ])

            return "\n".join(lines)

        except RuntimeError as exc:
            return f"Error: {_sanitize_error(str(exc))}"
        except Exception as exc:
            return f"Error: {type(exc).__name__} -- {_sanitize_error(str(exc))}"
        finally:
            if client is not None:
                client.close()


# ---------------------------------------------------------------------------
# Tool 4: PayPal Top-Up
# ---------------------------------------------------------------------------


class DominusNodeTopupPaypalTool(BaseTool):
    """Top up your DomiNode wallet balance via PayPal.

    Creates a PayPal order and returns an approval URL to complete payment.
    Minimum $5 (500 cents), maximum $1,000 (100,000 cents).
    """

    name: str = "dominusnode_topup_paypal"
    description: str = (
        "Top up your DomiNode wallet balance via PayPal. "
        "Creates a PayPal order and returns an approval URL to complete "
        "payment. Input: amount_cents (integer, min 500 = $5, max 100000 = $1,000)."
    )
    args_schema: Type[BaseModel] = TopupPaypalInput

    # -- Configuration (not exposed to the LLM) ----------------------------
    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    proxy_host: Optional[str] = Field(default=None, exclude=True)

    def _run(self, amount_cents: int = 0, **kwargs: Any) -> str:
        if not isinstance(amount_cents, int) or amount_cents < 500 or amount_cents > 100000:
            return "Error: amount_cents must be an integer between 500 ($5) and 100000 ($1,000)."

        client: Optional[DominusNodeClient] = None
        try:
            client = _make_client(
                api_key=self.api_key,
                base_url=self.base_url,
                proxy_host=self.proxy_host,
            )

            result = client.wallet.topup_paypal(amount_cents=amount_cents)

            return (
                f"PayPal Top-Up Order Created\n"
                f"Order ID: {result.order_id}\n"
                f"Amount: ${amount_cents / 100:.2f}\n"
                f"Approval URL: {result.approval_url}\n\n"
                f"Open the approval URL in a browser to complete payment."
            )

        except RuntimeError as exc:
            return f"Error: {_sanitize_error(str(exc))}"
        except Exception as exc:
            return f"Error: {type(exc).__name__} -- {_sanitize_error(str(exc))}"
        finally:
            if client is not None:
                client.close()
