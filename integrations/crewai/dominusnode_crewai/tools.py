"""CrewAI tool implementations for Dominus Node proxy service.

Each tool subclasses ``crewai.tools.BaseTool`` and manages its own
Dominus Node SDK client connection.

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
from urllib.parse import quote, urlparse

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
_CREDENTIAL_RE = re.compile(r"dn_(live|test)_[a-zA-Z0-9]+|eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+")

# Maximum response body size (10 MB)
_MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024


def _sanitize_error(message: str) -> str:
    """Remove Dominus Node API key patterns from error messages."""
    return _CREDENTIAL_RE.sub("***", message)


# ---------------------------------------------------------------------------
# Prototype pollution prevention
# ---------------------------------------------------------------------------

_DANGEROUS_KEYS = frozenset({"__proto__", "constructor", "prototype"})


def _strip_dangerous_keys(obj: Any, depth: int = 0) -> None:
    """Recursively remove prototype pollution keys from parsed JSON."""
    if depth > 50 or obj is None:
        return
    if isinstance(obj, list):
        for item in obj:
            _strip_dangerous_keys(item, depth + 1)
    elif isinstance(obj, dict):
        for key in list(obj.keys()):
            if key in _DANGEROUS_KEYS:
                del obj[key]
            else:
                _strip_dangerous_keys(obj[key], depth + 1)


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
    """Input schema for the Dominus Node web scrape tool."""

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
    """Input schema for the Dominus Node balance tool."""

    # No required inputs -- the tool just checks the current balance.
    pass


class GeoTargetInput(BaseModel):
    """Input schema for the Dominus Node geo-targets tool."""

    # No required inputs -- the tool just lists available locations.
    pass


class TopupPaypalInput(BaseModel):
    """Input schema for the Dominus Node PayPal top-up tool."""

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
            "Dominus Node API key is required.  Pass api_key= or set DOMINUSNODE_API_KEY."
        )

    url = base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
    host = proxy_host or os.environ.get("DOMINUSNODE_PROXY_HOST", "proxy.dominusnode.com")

    client = DominusNodeClient(base_url=url, api_key=key, proxy_host=host)
    return client


# ---------------------------------------------------------------------------
# Tool 1: Web Scrape
# ---------------------------------------------------------------------------


class DominusNodeWebScrapeTool(BaseTool):
    """Fetch web page content through Dominus Node's rotating proxy network.

    Useful for accessing geo-restricted content or avoiding IP blocks when
    scraping. Supports datacenter and residential proxy types with optional
    country-level geo-targeting.
    """

    name: str = "dominusnode_web_scrape"
    description: str = (
        "Fetch web page content through Dominus Node's rotating proxy network. "
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

    Queries the Dominus Node API for the current proxy configuration including
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
                "Dominus Node Geo-Targeting Options:",
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
# Tool 4: x402 Info
# ---------------------------------------------------------------------------


class X402InfoInput(BaseModel):
    """Input schema for the Dominus Node x402 info tool."""

    # No required inputs -- the tool just fetches x402 protocol information.
    pass


class DominusNodeX402InfoTool(BaseTool):
    """Get x402 micropayment protocol information.

    Returns details about x402 HTTP 402 Payment Required protocol support
    including facilitators, pricing, supported currencies, and payment options
    for AI agent micropayments.
    """

    name: str = "dominusnode_x402_info"
    description: str = (
        "Get x402 micropayment protocol information including supported "
        "facilitators, pricing, and payment options."
    )
    args_schema: Type[BaseModel] = X402InfoInput

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

            info = client.x402.get_info()

            return (
                f"x402 Protocol Information:\n"
                f"  Supported: {info.supported}\n"
                f"  Enabled: {info.enabled}\n"
                f"  Protocol: {info.protocol}\n"
                f"  Version: {info.version}\n"
                f"  Currencies: {', '.join(info.currencies)}\n"
                f"  Wallet Type: {info.wallet_type}\n"
                f"  Agentic Wallets: {info.agentic_wallets}\n"
                f"  Pricing: {info.pricing.per_request_cents} cents/request, "
                f"{info.pricing.per_gb_cents} cents/GB ({info.pricing.currency})"
            )

        except RuntimeError as exc:
            return f"Error: {_sanitize_error(str(exc))}"
        except Exception as exc:
            return f"Error: {type(exc).__name__} -- {_sanitize_error(str(exc))}"
        finally:
            if client is not None:
                client.close()


# ---------------------------------------------------------------------------
# Tool 5: PayPal Top-Up
# ---------------------------------------------------------------------------


class DominusNodeTopupPaypalTool(BaseTool):
    """Top up your Dominus Node wallet balance via PayPal.

    Creates a PayPal order and returns an approval URL to complete payment.
    Minimum $5 (500 cents), maximum $1,000 (100,000 cents).
    """

    name: str = "dominusnode_topup_paypal"
    description: str = (
        "Top up your Dominus Node wallet balance via PayPal. "
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


# ---------------------------------------------------------------------------
# Agentic Wallet — shared helpers
# ---------------------------------------------------------------------------

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

_DOMAIN_RE = re.compile(
    r"^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$"
)


def _validate_label(label: str) -> Optional[str]:
    """Return an error message if *label* is invalid, else None."""
    if not label or not isinstance(label, str):
        return "label is required and must be a non-empty string"
    if len(label) > 100:
        return "label must be 100 characters or fewer"
    if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in label):
        return "label contains invalid control characters"
    return None


def _validate_wallet_id(wallet_id: str) -> Optional[str]:
    """Return an error message if *wallet_id* is invalid, else None."""
    if not wallet_id or not isinstance(wallet_id, str):
        return "wallet_id is required and must be a non-empty string"
    if not _UUID_RE.match(wallet_id):
        return "wallet_id must be a valid UUID"
    return None


def _validate_domains(domains: list) -> Optional[str]:
    """Return an error message if *domains* is invalid, else None."""
    if not isinstance(domains, list):
        return "allowed_domains must be a list of strings"
    if len(domains) > 100:
        return "allowed_domains must have 100 or fewer entries"
    for d in domains:
        if not isinstance(d, str):
            return "Each allowed_domains entry must be a string"
        if len(d) > 253:
            return "Each allowed_domains entry must be 253 characters or fewer"
        if not _DOMAIN_RE.match(d):
            return f"Invalid domain format: {d}"
    return None


def _api_request_sync(
    base_url: str,
    api_key: str,
    method: str,
    path: str,
    body: Optional[dict] = None,
) -> dict:
    """Make an authenticated request to the Dominus Node REST API."""
    url = f"{base_url}{path}"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    with httpx.Client(timeout=30.0, follow_redirects=False, max_redirects=0) as client:
        if method == "GET":
            resp = client.get(url, headers=headers)
        elif method == "POST":
            resp = client.post(url, headers=headers, json=body or {})
        elif method == "DELETE":
            resp = client.delete(url, headers=headers)
        elif method == "PATCH":
            resp = client.patch(url, headers=headers, json=body or {})
        else:
            raise ValueError(f"Unsupported HTTP method: {method}")
        if len(resp.content) > _MAX_RESPONSE_BODY_BYTES:
            raise RuntimeError("Response body exceeds 10 MB size limit")
        resp.raise_for_status()
        data = resp.json()
        _strip_dangerous_keys(data)
        return data


# ---------------------------------------------------------------------------
# Agentic Wallet — Pydantic input schemas
# ---------------------------------------------------------------------------


class CreateAgenticWalletInput(BaseModel):
    """Input schema for creating an agentic wallet."""
    label: str = Field(description="A human-readable label for the wallet (max 100 chars).")
    spending_limit_cents: int = Field(description="Per-transaction spending limit in cents (1 – 2,147,483,647).")
    daily_limit_cents: Optional[int] = Field(default=None, description="Optional daily spending limit in cents (1 – 1,000,000).")
    allowed_domains: Optional[list] = Field(default=None, description="Optional list of allowed domains (max 100 entries, each ≤ 253 chars).")


class FundAgenticWalletInput(BaseModel):
    """Input schema for funding an agentic wallet."""
    wallet_id: str = Field(description="UUID of the agentic wallet to fund.")
    amount_cents: int = Field(description="Amount in cents to transfer from main wallet (1 – 2,147,483,647).")


class WalletIdInput(BaseModel):
    """Input schema for operations that only need a wallet ID."""
    wallet_id: str = Field(description="UUID of the agentic wallet.")


class AgenticTransactionsInput(BaseModel):
    """Input schema for listing agentic wallet transactions."""
    wallet_id: str = Field(description="UUID of the agentic wallet.")
    limit: Optional[int] = Field(default=None, description="Maximum number of transactions to return (1 – 100).")


class UpdateWalletPolicyInput(BaseModel):
    """Input schema for updating an agentic wallet's policy."""
    wallet_id: str = Field(description="UUID of the agentic wallet.")
    daily_limit_cents: Optional[int] = Field(default=None, description="New daily spending limit in cents (1 – 1,000,000), or None to keep unchanged.")
    allowed_domains: Optional[list] = Field(default=None, description="New allowed domains list (max 100 entries), or None to keep unchanged.")


# ---------------------------------------------------------------------------
# Tool 6: Create Agentic Wallet
# ---------------------------------------------------------------------------


class DominusNodeCreateAgenticWalletTool(BaseTool):
    """Create a new agentic sub-wallet with a spending limit.

    Agentic wallets are server-side custodial sub-wallets funded from the
    main wallet, designed for AI agents with per-transaction spending caps.
    """

    name: str = "dominusnode_create_agentic_wallet"
    description: str = (
        "Create a new agentic sub-wallet with a spending limit. "
        "Input: label (string), spending_limit_cents (integer), "
        "optional daily_limit_cents and allowed_domains."
    )
    args_schema: Type[BaseModel] = CreateAgenticWalletInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)

    def _run(
        self,
        label: str = "",
        spending_limit_cents: int = 0,
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[list] = None,
        **kwargs: Any,
    ) -> str:
        err = _validate_label(label)
        if err:
            return f"Error: {err}"

        if (
            not isinstance(spending_limit_cents, int)
            or spending_limit_cents <= 0
            or spending_limit_cents > 2_147_483_647
        ):
            return "Error: spending_limit_cents must be a positive integer <= 2,147,483,647"

        if daily_limit_cents is not None:
            if (
                not isinstance(daily_limit_cents, int)
                or daily_limit_cents < 1
                or daily_limit_cents > 1_000_000
            ):
                return "Error: daily_limit_cents must be an integer between 1 and 1,000,000"

        if allowed_domains is not None:
            derr = _validate_domains(allowed_domains)
            if derr:
                return f"Error: {derr}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        body: dict = {
            "label": label,
            "spendingLimitCents": spending_limit_cents,
        }
        if daily_limit_cents is not None:
            body["dailyLimitCents"] = daily_limit_cents
        if allowed_domains is not None:
            body["allowedDomains"] = allowed_domains

        try:
            result = _api_request_sync(url, key, "POST", "/api/agent-wallet", body)
            return (
                f"Agentic Wallet Created\n"
                f"  ID: {result.get('id', 'unknown')}\n"
                f"  Label: {result.get('label', label)}\n"
                f"  Spending Limit: {spending_limit_cents} cents\n"
                f"  Status: {result.get('status', 'active')}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 7: Fund Agentic Wallet
# ---------------------------------------------------------------------------


class DominusNodeFundAgenticWalletTool(BaseTool):
    """Transfer funds from the main wallet to an agentic sub-wallet."""

    name: str = "dominusnode_fund_agentic_wallet"
    description: str = (
        "Transfer funds from the main wallet to an agentic sub-wallet. "
        "Input: wallet_id (UUID), amount_cents (positive integer)."
    )
    args_schema: Type[BaseModel] = FundAgenticWalletInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)

    def _run(self, wallet_id: str = "", amount_cents: int = 0, **kwargs: Any) -> str:
        err = _validate_wallet_id(wallet_id)
        if err:
            return f"Error: {err}"

        if (
            not isinstance(amount_cents, int)
            or amount_cents <= 0
            or amount_cents > 2_147_483_647
        ):
            return "Error: amount_cents must be a positive integer <= 2,147,483,647"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(
                url, key, "POST",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/fund",
                {"amountCents": amount_cents},
            )
            return (
                f"Agentic Wallet Funded\n"
                f"  Wallet ID: {wallet_id}\n"
                f"  Amount: {amount_cents} cents (${amount_cents / 100:.2f})\n"
                f"  New Balance: {result.get('balanceCents', 'unknown')} cents"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 8: Agentic Wallet Balance
# ---------------------------------------------------------------------------


class DominusNodeAgenticWalletBalanceTool(BaseTool):
    """Check the balance and details of an agentic sub-wallet."""

    name: str = "dominusnode_agentic_wallet_balance"
    description: str = (
        "Check the balance and details of an agentic sub-wallet. "
        "Input: wallet_id (UUID)."
    )
    args_schema: Type[BaseModel] = WalletIdInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)

    def _run(self, wallet_id: str = "", **kwargs: Any) -> str:
        err = _validate_wallet_id(wallet_id)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "GET", f"/api/agent-wallet/{quote(wallet_id, safe='')}")
            balance = result.get("balanceCents", 0)
            return (
                f"Agentic Wallet: {result.get('label', 'unknown')}\n"
                f"  ID: {result.get('id', wallet_id)}\n"
                f"  Balance: {balance} cents (${balance / 100:.2f})\n"
                f"  Spending Limit: {result.get('spendingLimitCents', 'unknown')} cents\n"
                f"  Status: {result.get('status', 'unknown')}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 9: List Agentic Wallets
# ---------------------------------------------------------------------------


class DominusNodeListAgenticWalletsTool(BaseTool):
    """List all agentic sub-wallets for the authenticated user."""

    name: str = "dominusnode_list_agentic_wallets"
    description: str = (
        "List all agentic sub-wallets for the current user. No input required."
    )
    args_schema: Type[BaseModel] = BalanceInput  # reuse empty schema

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "GET", "/api/agent-wallet")
            wallets = result.get("wallets", result) if isinstance(result, dict) else result
            if isinstance(wallets, list):
                if not wallets:
                    return "No agentic wallets found."
                lines = [f"Agentic Wallets ({len(wallets)}):"]
                for w in wallets:
                    lines.append(
                        f"  - {w.get('label', 'unknown')} (ID: {w.get('id', '?')}, "
                        f"Balance: {w.get('balanceCents', 0)} cents, "
                        f"Status: {w.get('status', '?')})"
                    )
                return "\n".join(lines)
            return str(result)
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 10: Agentic Wallet Transactions
# ---------------------------------------------------------------------------


class DominusNodeAgenticTransactionsTool(BaseTool):
    """List recent transactions for an agentic sub-wallet."""

    name: str = "dominusnode_agentic_transactions"
    description: str = (
        "List recent transactions for an agentic sub-wallet. "
        "Input: wallet_id (UUID), optional limit (1-100)."
    )
    args_schema: Type[BaseModel] = AgenticTransactionsInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)

    def _run(self, wallet_id: str = "", limit: Optional[int] = None, **kwargs: Any) -> str:
        err = _validate_wallet_id(wallet_id)
        if err:
            return f"Error: {err}"

        if limit is not None:
            if not isinstance(limit, int) or limit < 1 or limit > 100:
                return "Error: limit must be an integer between 1 and 100"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        qs = f"?limit={limit}" if limit else ""
        try:
            result = _api_request_sync(
                url, key, "GET",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/transactions{qs}",
            )
            txns = result.get("transactions", result) if isinstance(result, dict) else result
            if isinstance(txns, list):
                if not txns:
                    return f"No transactions found for wallet {wallet_id}."
                lines = [f"Transactions for wallet {wallet_id} ({len(txns)}):"]
                for t in txns:
                    lines.append(
                        f"  - {t.get('type', '?')}: {t.get('amountCents', 0)} cents "
                        f"({t.get('createdAt', '?')})"
                    )
                return "\n".join(lines)
            return str(result)
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 11: Freeze Agentic Wallet
# ---------------------------------------------------------------------------


class DominusNodeFreezeAgenticWalletTool(BaseTool):
    """Freeze an agentic sub-wallet to prevent further spending."""

    name: str = "dominusnode_freeze_agentic_wallet"
    description: str = (
        "Freeze an agentic sub-wallet to prevent further spending. "
        "Input: wallet_id (UUID)."
    )
    args_schema: Type[BaseModel] = WalletIdInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)

    def _run(self, wallet_id: str = "", **kwargs: Any) -> str:
        err = _validate_wallet_id(wallet_id)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            _api_request_sync(url, key, "POST", f"/api/agent-wallet/{quote(wallet_id, safe='')}/freeze")
            return f"Agentic wallet {wallet_id} has been frozen."
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 12: Unfreeze Agentic Wallet
# ---------------------------------------------------------------------------


class DominusNodeUnfreezeAgenticWalletTool(BaseTool):
    """Unfreeze a previously frozen agentic sub-wallet."""

    name: str = "dominusnode_unfreeze_agentic_wallet"
    description: str = (
        "Unfreeze a previously frozen agentic sub-wallet to re-enable spending. "
        "Input: wallet_id (UUID)."
    )
    args_schema: Type[BaseModel] = WalletIdInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)

    def _run(self, wallet_id: str = "", **kwargs: Any) -> str:
        err = _validate_wallet_id(wallet_id)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            _api_request_sync(url, key, "POST", f"/api/agent-wallet/{quote(wallet_id, safe='')}/unfreeze")
            return f"Agentic wallet {wallet_id} has been unfrozen."
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 13: Delete Agentic Wallet
# ---------------------------------------------------------------------------


class DominusNodeDeleteAgenticWalletTool(BaseTool):
    """Delete an agentic sub-wallet (must be active, not frozen)."""

    name: str = "dominusnode_delete_agentic_wallet"
    description: str = (
        "Delete an agentic sub-wallet. The wallet must be active (not frozen). "
        "Remaining balance is returned to the main wallet. Input: wallet_id (UUID)."
    )
    args_schema: Type[BaseModel] = WalletIdInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)

    def _run(self, wallet_id: str = "", **kwargs: Any) -> str:
        err = _validate_wallet_id(wallet_id)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            _api_request_sync(url, key, "DELETE", f"/api/agent-wallet/{quote(wallet_id, safe='')}")
            return f"Agentic wallet {wallet_id} has been deleted."
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 14: Update Wallet Policy
# ---------------------------------------------------------------------------


class DominusNodeUpdateWalletPolicyTool(BaseTool):
    """Update the policy (daily limit, allowed domains) of an agentic sub-wallet."""

    name: str = "dominusnode_update_wallet_policy"
    description: str = (
        "Update the policy of an agentic sub-wallet. "
        "Input: wallet_id (UUID), optional daily_limit_cents (1-1,000,000), "
        "optional allowed_domains (list of domain strings)."
    )
    args_schema: Type[BaseModel] = UpdateWalletPolicyInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)

    def _run(
        self,
        wallet_id: str = "",
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[list] = None,
        **kwargs: Any,
    ) -> str:
        err = _validate_wallet_id(wallet_id)
        if err:
            return f"Error: {err}"

        body: dict = {}

        if daily_limit_cents is not None:
            if (
                not isinstance(daily_limit_cents, int)
                or daily_limit_cents < 1
                or daily_limit_cents > 1_000_000
            ):
                return "Error: daily_limit_cents must be an integer between 1 and 1,000,000"
            body["dailyLimitCents"] = daily_limit_cents

        if allowed_domains is not None:
            derr = _validate_domains(allowed_domains)
            if derr:
                return f"Error: {derr}"
            body["allowedDomains"] = allowed_domains

        if not body:
            return "Error: At least one of daily_limit_cents or allowed_domains must be provided"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(
                url, key, "PATCH",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/policy",
                body,
            )
            return (
                f"Wallet Policy Updated\n"
                f"  Wallet ID: {wallet_id}\n"
                f"  Daily Limit: {result.get('dailyLimitCents', 'unchanged')} cents\n"
                f"  Allowed Domains: {result.get('allowedDomains', 'unchanged')}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"
