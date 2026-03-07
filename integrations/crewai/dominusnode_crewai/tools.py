"""CrewAI tool implementations for Dominus Node proxy service (53 tools).

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
import math
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


class TopupStripeInput(BaseModel):
    """Input schema for the Dominus Node Stripe top-up tool."""

    amount_cents: int = Field(
        description="Amount in cents to top up via Stripe (min 500 = $5, max 100000 = $1,000).",
    )


# Valid crypto currencies for NOWPayments
_VALID_CRYPTO_CURRENCIES = frozenset({
    "BTC", "ETH", "LTC", "XMR", "ZEC", "USDC", "SOL", "USDT", "DAI", "BNB", "LINK",
})


class TopupCryptoInput(BaseModel):
    """Input schema for the Dominus Node crypto top-up tool."""

    amount_usd: float = Field(
        description="Amount in USD to top up via crypto (min 5, max 1000).",
    )
    currency: str = Field(
        description="Cryptocurrency to pay with: BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, or LINK.",
    )


class EmptyInput(BaseModel):
    """Input schema for tools that require no parameters."""

    pass


class ProxyStatusInput(BaseModel):
    """Input schema for the proxy status tool."""

    pass


class ListSessionsInput(BaseModel):
    """Input schema for the list sessions tool."""

    pass


class TransactionsInput(BaseModel):
    """Input schema for the wallet transactions tool."""

    limit: Optional[int] = Field(default=None, description="Maximum number of transactions to return (1-100).")


class ForecastInput(BaseModel):
    """Input schema for the wallet forecast tool."""

    pass


class CheckPaymentInput(BaseModel):
    """Input schema for checking a crypto payment status."""

    payment_id: str = Field(description="The crypto payment/invoice ID to check.")


class UsageInput(BaseModel):
    """Input schema for the usage check tool."""

    since: Optional[str] = Field(default=None, description="Start date in ISO 8601 format (e.g., '2025-01-01').")
    until: Optional[str] = Field(default=None, description="End date in ISO 8601 format (e.g., '2025-01-31').")


class DailyUsageInput(BaseModel):
    """Input schema for the daily usage tool."""

    days: Optional[int] = Field(default=None, description="Number of days of daily usage to return (1-90).")


class TopHostsInput(BaseModel):
    """Input schema for the top hosts tool."""

    limit: Optional[int] = Field(default=None, description="Maximum number of top hosts to return (1-100).")


class RegisterInput(BaseModel):
    """Input schema for user registration."""

    email: str = Field(description="Email address for the new account.")
    password: str = Field(description="Password (8-128 characters).")


class LoginInput(BaseModel):
    """Input schema for user login."""

    email: str = Field(description="Email address.")
    password: str = Field(description="Password.")


class AccountInfoInput(BaseModel):
    """Input schema for the account info tool."""

    pass


class VerifyEmailInput(BaseModel):
    """Input schema for email verification."""

    token: str = Field(description="The email verification token.")


class ResendVerificationInput(BaseModel):
    """Input schema for resending email verification."""

    pass


class UpdatePasswordInput(BaseModel):
    """Input schema for updating password."""

    current_password: str = Field(description="Current password.")
    new_password: str = Field(description="New password (8-128 characters).")


class ListKeysInput(BaseModel):
    """Input schema for listing API keys."""

    pass


class CreateKeyInput(BaseModel):
    """Input schema for creating an API key."""

    label: str = Field(description="A human-readable label for the key (max 100 chars).")


class RevokeKeyInput(BaseModel):
    """Input schema for revoking an API key."""

    key_id: str = Field(description="UUID of the API key to revoke.")


class GetPlanInput(BaseModel):
    """Input schema for getting current plan."""

    pass


class ListPlansInput(BaseModel):
    """Input schema for listing available plans."""

    pass


class ChangePlanInput(BaseModel):
    """Input schema for changing the user's plan."""

    plan_id: str = Field(description="UUID of the plan to switch to.")


class CreateTeamInput(BaseModel):
    """Input schema for creating a team."""

    name: str = Field(description="Team name (max 100 chars).")
    max_members: Optional[int] = Field(default=None, description="Optional maximum number of team members (1-100).")


class TeamIdInput(BaseModel):
    """Input schema for operations that only need a team ID."""

    team_id: str = Field(description="UUID of the team.")


class UpdateTeamInput(BaseModel):
    """Input schema for updating team settings."""

    team_id: str = Field(description="UUID of the team.")
    name: Optional[str] = Field(default=None, description="New team name (max 100 chars).")
    max_members: Optional[int] = Field(default=None, description="New max member count (1-100).")


class TeamFundInput(BaseModel):
    """Input schema for funding a team wallet."""

    team_id: str = Field(description="UUID of the team.")
    amount_cents: int = Field(description="Amount to transfer in cents (100-1,000,000).")


class TeamCreateKeyInput(BaseModel):
    """Input schema for creating a team API key."""

    team_id: str = Field(description="UUID of the team.")
    label: str = Field(description="A human-readable label for the key (max 100 chars).")


class TeamRevokeKeyInput(BaseModel):
    """Input schema for revoking a team API key."""

    team_id: str = Field(description="UUID of the team.")
    key_id: str = Field(description="UUID of the API key to revoke.")


class TeamUsageInput(BaseModel):
    """Input schema for team usage/transactions."""

    team_id: str = Field(description="UUID of the team.")
    limit: Optional[int] = Field(default=None, description="Maximum number of records to return (1-100).")


class TeamAddMemberInput(BaseModel):
    """Input schema for adding a team member."""

    team_id: str = Field(description="UUID of the team.")
    email: str = Field(description="Email address of the user to add.")
    role: str = Field(default="member", description="Role: 'member' or 'admin'.")


class TeamRemoveMemberInput(BaseModel):
    """Input schema for removing a team member."""

    team_id: str = Field(description="UUID of the team.")
    user_id: str = Field(description="UUID of the user to remove.")


class UpdateTeamMemberRoleInput(BaseModel):
    """Input schema for updating a team member's role."""

    team_id: str = Field(description="UUID of the team.")
    user_id: str = Field(description="UUID of the user.")
    role: str = Field(description="New role: 'member' or 'admin'.")


class TeamInviteMemberInput(BaseModel):
    """Input schema for inviting a member to a team."""

    team_id: str = Field(description="UUID of the team.")
    email: str = Field(description="Email address to invite.")
    role: str = Field(default="member", description="Role for the invitee: 'member' or 'admin'.")


class TeamInviteIdInput(BaseModel):
    """Input schema for cancelling a team invite."""

    team_id: str = Field(description="UUID of the team.")
    invite_id: str = Field(description="UUID of the invite to cancel.")


# ---------------------------------------------------------------------------
# Helper: create an authenticated SDK client
# ---------------------------------------------------------------------------


def _make_client(
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    proxy_host: Optional[str] = None,
    agent_secret: Optional[str] = None,
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
    secret = agent_secret or os.environ.get("DOMINUSNODE_AGENT_SECRET")

    client = DominusNodeClient(base_url=url, api_key=key, proxy_host=host, agent_secret=secret)
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
    agent_secret: Optional[str] = Field(default=None, exclude=True)

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
                agent_secret=self.agent_secret,
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
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        client: Optional[DominusNodeClient] = None
        try:
            client = _make_client(
                api_key=self.api_key,
                base_url=self.base_url,
                proxy_host=self.proxy_host,
                agent_secret=self.agent_secret,
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
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        client: Optional[DominusNodeClient] = None
        try:
            client = _make_client(
                api_key=self.api_key,
                base_url=self.base_url,
                proxy_host=self.proxy_host,
                agent_secret=self.agent_secret,
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
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        client: Optional[DominusNodeClient] = None
        try:
            client = _make_client(
                api_key=self.api_key,
                base_url=self.base_url,
                proxy_host=self.proxy_host,
                agent_secret=self.agent_secret,
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
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, amount_cents: int = 0, **kwargs: Any) -> str:
        if not isinstance(amount_cents, int) or amount_cents < 500 or amount_cents > 100000:
            return "Error: amount_cents must be an integer between 500 ($5) and 100000 ($1,000)."

        client: Optional[DominusNodeClient] = None
        try:
            client = _make_client(
                api_key=self.api_key,
                base_url=self.base_url,
                proxy_host=self.proxy_host,
                agent_secret=self.agent_secret,
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
# Tool 6: Stripe Top-Up
# ---------------------------------------------------------------------------


class DominusNodeTopupStripeTool(BaseTool):
    """Top up your Dominus Node wallet balance via Stripe.

    Creates a Stripe checkout session and returns a checkout URL to complete
    payment. Minimum $5 (500 cents), maximum $1,000 (100,000 cents).
    """

    name: str = "dominusnode_topup_stripe"
    description: str = (
        "Top up your Dominus Node wallet balance via Stripe. "
        "Creates a Stripe checkout session and returns a checkout URL to "
        "complete payment. Input: amount_cents (integer, min 500 = $5, max 100000 = $1,000)."
    )
    args_schema: Type[BaseModel] = TopupStripeInput

    # -- Configuration (not exposed to the LLM) ----------------------------
    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    proxy_host: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, amount_cents: int = 0, **kwargs: Any) -> str:
        if not isinstance(amount_cents, int) or amount_cents < 500 or amount_cents > 100000:
            return "Error: amount_cents must be an integer between 500 ($5) and 100000 ($1,000)."

        client: Optional[DominusNodeClient] = None
        try:
            client = _make_client(
                api_key=self.api_key,
                base_url=self.base_url,
                proxy_host=self.proxy_host,
                agent_secret=self.agent_secret,
            )

            result = client.wallet.topup_stripe(amount_cents=amount_cents)

            return (
                f"Stripe Checkout Session Created\n"
                f"Session ID: {result.session_id}\n"
                f"Amount: ${amount_cents / 100:.2f}\n"
                f"Checkout URL: {result.url}\n\n"
                f"Open the checkout URL in a browser to complete payment."
            )

        except RuntimeError as exc:
            return f"Error: {_sanitize_error(str(exc))}"
        except Exception as exc:
            return f"Error: {type(exc).__name__} -- {_sanitize_error(str(exc))}"
        finally:
            if client is not None:
                client.close()


# ---------------------------------------------------------------------------
# Tool 7: Crypto Top-Up
# ---------------------------------------------------------------------------


class DominusNodeTopupCryptoTool(BaseTool):
    """Top up your Dominus Node wallet balance via cryptocurrency.

    Creates a crypto payment invoice via NOWPayments and returns a payment URL.
    Supports BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, and LINK.
    Minimum $5, maximum $1,000.
    """

    name: str = "dominusnode_topup_crypto"
    description: str = (
        "Top up your Dominus Node wallet balance via cryptocurrency. "
        "Creates a crypto invoice and returns a payment URL. "
        "Input: amount_usd (number, min 5, max 1000) and currency "
        "(BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, or LINK)."
    )
    args_schema: Type[BaseModel] = TopupCryptoInput

    # -- Configuration (not exposed to the LLM) ----------------------------
    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    proxy_host: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, amount_usd: float = 0, currency: str = "", **kwargs: Any) -> str:
        if not isinstance(amount_usd, (int, float)) or isinstance(amount_usd, bool):
            return "Error: amount_usd must be a number between 5 ($5) and 1000 ($1,000)."
        if not math.isfinite(amount_usd):
            return "Error: amount_usd must be a number between 5 ($5) and 1000 ($1,000)."
        if amount_usd < 5 or amount_usd > 1000:
            return "Error: amount_usd must be a number between 5 ($5) and 1000 ($1,000)."

        currency_upper = currency.upper().strip() if isinstance(currency, str) else ""
        if currency_upper not in _VALID_CRYPTO_CURRENCIES:
            return (
                f"Error: currency must be one of: "
                f"{', '.join(sorted(_VALID_CRYPTO_CURRENCIES))}."
            )

        client: Optional[DominusNodeClient] = None
        try:
            client = _make_client(
                api_key=self.api_key,
                base_url=self.base_url,
                proxy_host=self.proxy_host,
                agent_secret=self.agent_secret,
            )

            result = client.wallet.topup_crypto(
                amount_usd=amount_usd,
                currency=currency_upper.lower(),
            )

            return (
                f"Crypto Payment Invoice Created\n"
                f"Invoice ID: {result.invoice_id}\n"
                f"Amount: ${amount_usd:.2f}\n"
                f"Currency: {currency_upper}\n"
                f"Payment URL: {result.payment_url}\n\n"
                f"Open the payment URL in a browser to complete payment."
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


def _validate_team_id(team_id: str) -> Optional[str]:
    """Return an error message if *team_id* is invalid, else None."""
    if not team_id or not isinstance(team_id, str):
        return "team_id is required and must be a non-empty string"
    if not _UUID_RE.match(team_id):
        return "team_id must be a valid UUID"
    return None


def _validate_user_id(user_id: str) -> Optional[str]:
    """Return an error message if *user_id* is invalid, else None."""
    if not user_id or not isinstance(user_id, str):
        return "user_id is required and must be a non-empty string"
    if not _UUID_RE.match(user_id):
        return "user_id must be a valid UUID"
    return None


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _validate_email(email: str) -> Optional[str]:
    """Return an error message if *email* is invalid, else None."""
    if not email or not isinstance(email, str):
        return "email is required and must be a non-empty string"
    if len(email) > 254:
        return "email must be 254 characters or fewer"
    if not _EMAIL_RE.match(email):
        return "email format is invalid"
    if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in email):
        return "email contains invalid control characters"
    return None


def _validate_password(password: str) -> Optional[str]:
    """Return an error message if *password* is invalid, else None."""
    if not password or not isinstance(password, str):
        return "password is required and must be a non-empty string"
    if len(password) < 8:
        return "password must be at least 8 characters"
    if len(password) > 128:
        return "password must be 128 characters or fewer"
    return None


def _validate_positive_int(
    value: Any, name: str, *, min_value: int = 1, max_value: int = 2_147_483_647,
) -> Optional[str]:
    """Return an error message if *value* is not a valid positive int, else None."""
    if not isinstance(value, int) or isinstance(value, bool):
        return f"{name} must be an integer between {min_value} and {max_value}"
    if value < min_value or value > max_value:
        return f"{name} must be an integer between {min_value} and {max_value}"
    return None


def _api_request_unauth(
    base_url: str,
    method: str,
    path: str,
    body: Optional[dict] = None,
) -> dict:
    """Make an unauthenticated request to the Dominus Node REST API."""
    url = f"{base_url}{path}"
    headers = {"Content-Type": "application/json"}
    with httpx.Client(timeout=30.0, follow_redirects=False, max_redirects=0) as client:
        if method == "GET":
            resp = client.get(url, headers=headers)
        elif method == "POST":
            resp = client.post(url, headers=headers, json=body or {})
        else:
            raise ValueError(f"Unsupported HTTP method: {method}")
        if len(resp.content) > _MAX_RESPONSE_BODY_BYTES:
            raise RuntimeError("Response body exceeds 10 MB size limit")
        resp.raise_for_status()
        data = resp.json()
        _strip_dangerous_keys(data)
        return data


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
    agent_secret: Optional[str] = None,
) -> dict:
    """Make an authenticated request to the Dominus Node REST API."""
    url = f"{base_url}{path}"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    secret = agent_secret or os.environ.get("DOMINUSNODE_AGENT_SECRET")
    if secret:
        headers["X-DominusNode-Agent"] = "mcp"
        headers["X-DominusNode-Agent-Secret"] = secret
    with httpx.Client(timeout=30.0, follow_redirects=False, max_redirects=0) as client:
        if method == "GET":
            resp = client.get(url, headers=headers)
        elif method == "POST":
            resp = client.post(url, headers=headers, json=body or {})
        elif method == "DELETE":
            resp = client.delete(url, headers=headers)
        elif method == "PUT":
            resp = client.put(url, headers=headers, json=body or {})
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
# Tool 8: Create Agentic Wallet
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
    agent_secret: Optional[str] = Field(default=None, exclude=True)

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
            result = _api_request_sync(url, key, "POST", "/api/agent-wallet", body, agent_secret=self.agent_secret)
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
# Tool 9: Fund Agentic Wallet
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
    agent_secret: Optional[str] = Field(default=None, exclude=True)

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
                agent_secret=self.agent_secret,
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
# Tool 10: Agentic Wallet Balance
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
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, wallet_id: str = "", **kwargs: Any) -> str:
        err = _validate_wallet_id(wallet_id)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "GET", f"/api/agent-wallet/{quote(wallet_id, safe='')}", agent_secret=self.agent_secret)
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
# Tool 11: List Agentic Wallets
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
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "GET", "/api/agent-wallet", agent_secret=self.agent_secret)
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
# Tool 12: Agentic Wallet Transactions
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
    agent_secret: Optional[str] = Field(default=None, exclude=True)

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
                agent_secret=self.agent_secret,
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
# Tool 13: Freeze Agentic Wallet
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
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, wallet_id: str = "", **kwargs: Any) -> str:
        err = _validate_wallet_id(wallet_id)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            _api_request_sync(url, key, "POST", f"/api/agent-wallet/{quote(wallet_id, safe='')}/freeze", agent_secret=self.agent_secret)
            return f"Agentic wallet {wallet_id} has been frozen."
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 14: Unfreeze Agentic Wallet
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
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, wallet_id: str = "", **kwargs: Any) -> str:
        err = _validate_wallet_id(wallet_id)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            _api_request_sync(url, key, "POST", f"/api/agent-wallet/{quote(wallet_id, safe='')}/unfreeze", agent_secret=self.agent_secret)
            return f"Agentic wallet {wallet_id} has been unfrozen."
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 15: Delete Agentic Wallet
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
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, wallet_id: str = "", **kwargs: Any) -> str:
        err = _validate_wallet_id(wallet_id)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            _api_request_sync(url, key, "DELETE", f"/api/agent-wallet/{quote(wallet_id, safe='')}", agent_secret=self.agent_secret)
            return f"Agentic wallet {wallet_id} has been deleted."
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 16: Update Wallet Policy
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
    agent_secret: Optional[str] = Field(default=None, exclude=True)

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
                agent_secret=self.agent_secret,
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


# ---------------------------------------------------------------------------
# Tool 17: Proxy Status
# ---------------------------------------------------------------------------


class DominusNodeProxyStatusTool(BaseTool):
    """Get the current status of the proxy gateway."""

    name: str = "dominusnode_proxy_status"
    description: str = (
        "Get the current status of the Dominus Node proxy gateway including "
        "health, pool availability, and uptime information."
    )
    args_schema: Type[BaseModel] = ProxyStatusInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "GET", "/api/proxy/status", agent_secret=self.agent_secret)
            return (
                f"Proxy Status:\n"
                f"  Status: {result.get('status', 'unknown')}\n"
                f"  Active Pools: {result.get('activePools', 'unknown')}\n"
                f"  Uptime: {result.get('uptime', 'unknown')}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 18: List Sessions
# ---------------------------------------------------------------------------


class DominusNodeListSessionsTool(BaseTool):
    """List active proxy sessions."""

    name: str = "dominusnode_list_sessions"
    description: str = (
        "List all currently active proxy sessions for the authenticated user."
    )
    args_schema: Type[BaseModel] = ListSessionsInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "GET", "/api/sessions/active", agent_secret=self.agent_secret)
            sessions = result.get("sessions", result) if isinstance(result, dict) else result
            if isinstance(sessions, list):
                if not sessions:
                    return "No active sessions."
                lines = [f"Active Sessions ({len(sessions)}):"]
                for s in sessions:
                    lines.append(
                        f"  - Session {s.get('id', '?')}: "
                        f"type={s.get('proxyType', '?')}, "
                        f"country={s.get('country', '?')}, "
                        f"bytes={s.get('bytesUsed', 0)}"
                    )
                return "\n".join(lines)
            return str(result)
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 19: Get Transactions
# ---------------------------------------------------------------------------


class DominusNodeGetTransactionsTool(BaseTool):
    """Get wallet transaction history."""

    name: str = "dominusnode_get_transactions"
    description: str = (
        "Get transaction history for the user's main wallet. "
        "Optionally specify a limit (1-100)."
    )
    args_schema: Type[BaseModel] = TransactionsInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, limit: Optional[int] = None, **kwargs: Any) -> str:
        if limit is not None:
            if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
                return "Error: limit must be an integer between 1 and 100"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        qs = f"?limit={limit}" if limit else ""
        try:
            result = _api_request_sync(url, key, "GET", f"/api/wallet/transactions{qs}", agent_secret=self.agent_secret)
            txns = result.get("transactions", result) if isinstance(result, dict) else result
            if isinstance(txns, list):
                if not txns:
                    return "No transactions found."
                lines = [f"Wallet Transactions ({len(txns)}):"]
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
# Tool 20: Get Forecast
# ---------------------------------------------------------------------------


class DominusNodeGetForecastTool(BaseTool):
    """Get wallet balance forecast based on recent usage patterns."""

    name: str = "dominusnode_get_forecast"
    description: str = (
        "Get a forecast of when the wallet balance will run out based on "
        "recent usage patterns."
    )
    args_schema: Type[BaseModel] = ForecastInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "GET", "/api/wallet/forecast", agent_secret=self.agent_secret)
            return (
                f"Wallet Forecast:\n"
                f"  Current Balance: {result.get('balanceCents', 'unknown')} cents\n"
                f"  Daily Burn Rate: {result.get('dailyBurnCents', 'unknown')} cents/day\n"
                f"  Days Remaining: {result.get('daysRemaining', 'unknown')}\n"
                f"  Depletion Date: {result.get('depletionDate', 'unknown')}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 21: Check Payment
# ---------------------------------------------------------------------------


class DominusNodeCheckPaymentTool(BaseTool):
    """Check the status of a crypto payment."""

    name: str = "dominusnode_check_payment"
    description: str = (
        "Check the status of a crypto payment by its invoice/payment ID."
    )
    args_schema: Type[BaseModel] = CheckPaymentInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, payment_id: str = "", **kwargs: Any) -> str:
        if not payment_id or not isinstance(payment_id, str):
            return "Error: payment_id is required and must be a non-empty string"
        if len(payment_id) > 200:
            return "Error: payment_id must be 200 characters or fewer"
        if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in payment_id):
            return "Error: payment_id contains invalid control characters"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(
                url, key, "GET",
                f"/api/wallet/topup/crypto/{quote(payment_id, safe='')}/status",
                agent_secret=self.agent_secret,
            )
            return (
                f"Payment Status:\n"
                f"  Payment ID: {payment_id}\n"
                f"  Status: {result.get('status', 'unknown')}\n"
                f"  Amount: {result.get('amountUsd', 'unknown')} USD\n"
                f"  Currency: {result.get('currency', 'unknown')}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 22: Check Usage
# ---------------------------------------------------------------------------


class DominusNodeCheckUsageTool(BaseTool):
    """Check bandwidth usage for the authenticated user."""

    name: str = "dominusnode_check_usage"
    description: str = (
        "Check bandwidth usage for the authenticated user. "
        "Optionally specify 'since' and 'until' dates in ISO 8601 format."
    )
    args_schema: Type[BaseModel] = UsageInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, since: Optional[str] = None, until: Optional[str] = None, **kwargs: Any) -> str:
        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        params: list[str] = []
        if since:
            if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in since):
                return "Error: since contains invalid control characters"
            params.append(f"since={quote(since, safe='')}")
        if until:
            if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in until):
                return "Error: until contains invalid control characters"
            params.append(f"until={quote(until, safe='')}")
        qs = f"?{'&'.join(params)}" if params else ""

        try:
            result = _api_request_sync(url, key, "GET", f"/api/usage{qs}", agent_secret=self.agent_secret)
            return (
                f"Usage Summary:\n"
                f"  Total Bytes: {result.get('totalBytes', 0)}\n"
                f"  Total Requests: {result.get('totalRequests', 0)}\n"
                f"  DC Bytes: {result.get('dcBytes', 0)}\n"
                f"  Residential Bytes: {result.get('residentialBytes', 0)}\n"
                f"  Cost (cents): {result.get('costCents', 0)}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 23: Get Daily Usage
# ---------------------------------------------------------------------------


class DominusNodeGetDailyUsageTool(BaseTool):
    """Get daily bandwidth usage breakdown."""

    name: str = "dominusnode_get_daily_usage"
    description: str = (
        "Get daily bandwidth usage breakdown. Optionally specify the number "
        "of days to include (1-90)."
    )
    args_schema: Type[BaseModel] = DailyUsageInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, days: Optional[int] = None, **kwargs: Any) -> str:
        if days is not None:
            if not isinstance(days, int) or isinstance(days, bool) or days < 1 or days > 90:
                return "Error: days must be an integer between 1 and 90"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        qs = f"?days={days}" if days else ""
        try:
            result = _api_request_sync(url, key, "GET", f"/api/usage/daily{qs}", agent_secret=self.agent_secret)
            daily = result.get("days", result) if isinstance(result, dict) else result
            if isinstance(daily, list):
                if not daily:
                    return "No daily usage data available."
                lines = [f"Daily Usage ({len(daily)} days):"]
                for d in daily:
                    lines.append(
                        f"  - {d.get('date', '?')}: {d.get('totalBytes', 0)} bytes, "
                        f"{d.get('requests', 0)} requests, {d.get('costCents', 0)} cents"
                    )
                return "\n".join(lines)
            return str(result)
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 24: Get Top Hosts
# ---------------------------------------------------------------------------


class DominusNodeGetTopHostsTool(BaseTool):
    """Get top hosts by bandwidth usage."""

    name: str = "dominusnode_get_top_hosts"
    description: str = (
        "Get the top hosts (domains) by bandwidth usage. "
        "Optionally specify a limit (1-100)."
    )
    args_schema: Type[BaseModel] = TopHostsInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, limit: Optional[int] = None, **kwargs: Any) -> str:
        if limit is not None:
            if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
                return "Error: limit must be an integer between 1 and 100"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        qs = f"?limit={limit}" if limit else ""
        try:
            result = _api_request_sync(url, key, "GET", f"/api/usage/top-hosts{qs}", agent_secret=self.agent_secret)
            hosts = result.get("hosts", result) if isinstance(result, dict) else result
            if isinstance(hosts, list):
                if not hosts:
                    return "No host usage data available."
                lines = [f"Top Hosts ({len(hosts)}):"]
                for h in hosts:
                    lines.append(
                        f"  - {h.get('host', '?')}: {h.get('totalBytes', 0)} bytes, "
                        f"{h.get('requests', 0)} requests"
                    )
                return "\n".join(lines)
            return str(result)
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 25: Register (unauthenticated)
# ---------------------------------------------------------------------------


class DominusNodeRegisterTool(BaseTool):
    """Register a new Dominus Node account."""

    name: str = "dominusnode_register"
    description: str = (
        "Register a new Dominus Node account. "
        "Input: email and password (8-128 characters). "
        "This is an unauthenticated operation."
    )
    args_schema: Type[BaseModel] = RegisterInput

    base_url: Optional[str] = Field(default=None, exclude=True)

    def _run(self, email: str = "", password: str = "", **kwargs: Any) -> str:
        err = _validate_email(email)
        if err:
            return f"Error: {err}"

        err = _validate_password(password)
        if err:
            return f"Error: {err}"

        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")

        try:
            result = _api_request_unauth(url, "POST", "/api/auth/register", {"email": email, "password": password})
            return (
                f"Registration Successful\n"
                f"  User ID: {result.get('id', 'unknown')}\n"
                f"  Email: {result.get('email', email)}\n"
                f"  Status: {result.get('status', 'pending verification')}\n\n"
                f"Check your email for a verification link."
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 26: Login (unauthenticated)
# ---------------------------------------------------------------------------


class DominusNodeLoginTool(BaseTool):
    """Log in to a Dominus Node account and receive tokens."""

    name: str = "dominusnode_login"
    description: str = (
        "Log in to a Dominus Node account. Returns access and refresh tokens. "
        "Input: email and password. This is an unauthenticated operation."
    )
    args_schema: Type[BaseModel] = LoginInput

    base_url: Optional[str] = Field(default=None, exclude=True)

    def _run(self, email: str = "", password: str = "", **kwargs: Any) -> str:
        err = _validate_email(email)
        if err:
            return f"Error: {err}"

        err = _validate_password(password)
        if err:
            return f"Error: {err}"

        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")

        try:
            result = _api_request_unauth(url, "POST", "/api/auth/login", {"email": email, "password": password})
            # Check for MFA challenge
            if result.get("mfaRequired"):
                return (
                    f"MFA Required\n"
                    f"  Challenge ID: {result.get('challengeId', 'unknown')}\n"
                    f"  MFA Type: {result.get('mfaType', 'totp')}\n\n"
                    f"Provide the MFA code to complete login."
                )
            return (
                f"Login Successful\n"
                f"  Access Token: [redacted]\n"
                f"  Refresh Token: [redacted]\n"
                f"  Expires In: {result.get('expiresIn', 'unknown')} seconds"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 27: Get Account Info
# ---------------------------------------------------------------------------


class DominusNodeGetAccountInfoTool(BaseTool):
    """Get the authenticated user's account information."""

    name: str = "dominusnode_get_account_info"
    description: str = (
        "Get the authenticated user's account information including email, "
        "plan, and verification status."
    )
    args_schema: Type[BaseModel] = AccountInfoInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "GET", "/api/auth/me", agent_secret=self.agent_secret)
            return (
                f"Account Info:\n"
                f"  ID: {result.get('id', 'unknown')}\n"
                f"  Email: {result.get('email', 'unknown')}\n"
                f"  Email Verified: {result.get('emailVerified', 'unknown')}\n"
                f"  Plan: {result.get('plan', 'unknown')}\n"
                f"  Status: {result.get('status', 'unknown')}\n"
                f"  Created: {result.get('createdAt', 'unknown')}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 28: Verify Email (unauthenticated)
# ---------------------------------------------------------------------------


class DominusNodeVerifyEmailTool(BaseTool):
    """Verify email address with a verification token."""

    name: str = "dominusnode_verify_email"
    description: str = (
        "Verify an email address using the token received via email. "
        "This is an unauthenticated operation."
    )
    args_schema: Type[BaseModel] = VerifyEmailInput

    base_url: Optional[str] = Field(default=None, exclude=True)

    def _run(self, token: str = "", **kwargs: Any) -> str:
        if not token or not isinstance(token, str):
            return "Error: token is required and must be a non-empty string"
        if len(token) > 500:
            return "Error: token must be 500 characters or fewer"
        if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in token):
            return "Error: token contains invalid control characters"

        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")

        try:
            result = _api_request_unauth(url, "POST", "/api/auth/verify-email", {"token": token})
            return f"Email verification successful. {result.get('message', '')}"
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 29: Resend Verification
# ---------------------------------------------------------------------------


class DominusNodeResendVerificationTool(BaseTool):
    """Resend the email verification link."""

    name: str = "dominusnode_resend_verification"
    description: str = (
        "Resend the email verification link to the authenticated user's email address."
    )
    args_schema: Type[BaseModel] = ResendVerificationInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "POST", "/api/auth/resend-verification", agent_secret=self.agent_secret)
            return f"Verification email resent. {result.get('message', 'Check your inbox.')}"
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 30: Update Password
# ---------------------------------------------------------------------------


class DominusNodeUpdatePasswordTool(BaseTool):
    """Update the authenticated user's password."""

    name: str = "dominusnode_update_password"
    description: str = (
        "Update the authenticated user's password. "
        "Input: current_password and new_password (8-128 characters)."
    )
    args_schema: Type[BaseModel] = UpdatePasswordInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, current_password: str = "", new_password: str = "", **kwargs: Any) -> str:
        err = _validate_password(current_password)
        if err:
            return f"Error (current_password): {err}"

        err = _validate_password(new_password)
        if err:
            return f"Error (new_password): {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(
                url, key, "POST", "/api/auth/change-password",
                {"currentPassword": current_password, "newPassword": new_password},
                agent_secret=self.agent_secret,
            )
            return f"Password updated successfully. {result.get('message', '')}"
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 31: List API Keys
# ---------------------------------------------------------------------------


class DominusNodeListKeysTool(BaseTool):
    """List all API keys for the authenticated user."""

    name: str = "dominusnode_list_keys"
    description: str = (
        "List all API keys for the authenticated user."
    )
    args_schema: Type[BaseModel] = ListKeysInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "GET", "/api/keys", agent_secret=self.agent_secret)
            keys_list = result.get("keys", result) if isinstance(result, dict) else result
            if isinstance(keys_list, list):
                if not keys_list:
                    return "No API keys found."
                lines = [f"API Keys ({len(keys_list)}):"]
                for k in keys_list:
                    lines.append(
                        f"  - {k.get('label', 'unknown')} (ID: {k.get('id', '?')}, "
                        f"prefix: {k.get('prefix', '?')}, "
                        f"created: {k.get('createdAt', '?')})"
                    )
                return "\n".join(lines)
            return str(result)
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 32: Create API Key
# ---------------------------------------------------------------------------


class DominusNodeCreateKeyTool(BaseTool):
    """Create a new API key for the authenticated user."""

    name: str = "dominusnode_create_key"
    description: str = (
        "Create a new API key. Input: label (string, max 100 chars). "
        "Returns the full API key (shown only once)."
    )
    args_schema: Type[BaseModel] = CreateKeyInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, label: str = "", **kwargs: Any) -> str:
        err = _validate_label(label)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "POST", "/api/keys", {"label": label}, agent_secret=self.agent_secret)
            return (
                f"API Key Created\n"
                f"  ID: {result.get('id', 'unknown')}\n"
                f"  Label: {result.get('label', label)}\n"
                f"  Key: {result.get('key', '[see response]')}\n\n"
                f"Save this key securely -- it will not be shown again."
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 33: Revoke API Key
# ---------------------------------------------------------------------------


class DominusNodeRevokeKeyTool(BaseTool):
    """Revoke (delete) an API key."""

    name: str = "dominusnode_revoke_key"
    description: str = (
        "Revoke (delete) an API key. Input: key_id (UUID of the key to revoke)."
    )
    args_schema: Type[BaseModel] = RevokeKeyInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, key_id: str = "", **kwargs: Any) -> str:
        if not key_id or not isinstance(key_id, str):
            return "Error: key_id is required and must be a non-empty string"
        if not _UUID_RE.match(key_id):
            return "Error: key_id must be a valid UUID"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            _api_request_sync(url, key, "DELETE", f"/api/keys/{quote(key_id, safe='')}", agent_secret=self.agent_secret)
            return f"API key {key_id} has been revoked."
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 34: Get Plan
# ---------------------------------------------------------------------------


class DominusNodeGetPlanTool(BaseTool):
    """Get the current plan for the authenticated user."""

    name: str = "dominusnode_get_plan"
    description: str = (
        "Get the current subscription plan for the authenticated user."
    )
    args_schema: Type[BaseModel] = GetPlanInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "GET", "/api/plans/user/plan", agent_secret=self.agent_secret)
            return (
                f"Current Plan:\n"
                f"  Plan: {result.get('name', 'unknown')}\n"
                f"  ID: {result.get('id', 'unknown')}\n"
                f"  Bandwidth Limit: {result.get('bandwidthLimitGb', 'unknown')} GB\n"
                f"  Rate Limit: {result.get('requestsPerMinute', 'unknown')} req/min\n"
                f"  Features: {result.get('features', 'unknown')}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 35: List Plans
# ---------------------------------------------------------------------------


class DominusNodeListPlansTool(BaseTool):
    """List all available subscription plans."""

    name: str = "dominusnode_list_plans"
    description: str = (
        "List all available subscription plans with their features and pricing."
    )
    args_schema: Type[BaseModel] = ListPlansInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "GET", "/api/plans", agent_secret=self.agent_secret)
            plans = result.get("plans", result) if isinstance(result, dict) else result
            if isinstance(plans, list):
                if not plans:
                    return "No plans available."
                lines = [f"Available Plans ({len(plans)}):"]
                for p in plans:
                    lines.append(
                        f"  - {p.get('name', 'unknown')} (ID: {p.get('id', '?')}, "
                        f"bandwidth: {p.get('bandwidthLimitGb', '?')} GB, "
                        f"rate: {p.get('requestsPerMinute', '?')} req/min)"
                    )
                return "\n".join(lines)
            return str(result)
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 36: Change Plan
# ---------------------------------------------------------------------------


class DominusNodeChangePlanTool(BaseTool):
    """Change the authenticated user's subscription plan."""

    name: str = "dominusnode_change_plan"
    description: str = (
        "Change the authenticated user's subscription plan. "
        "Input: plan_id (UUID of the plan to switch to)."
    )
    args_schema: Type[BaseModel] = ChangePlanInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, plan_id: str = "", **kwargs: Any) -> str:
        if not plan_id or not isinstance(plan_id, str):
            return "Error: plan_id is required and must be a non-empty string"
        if not _UUID_RE.match(plan_id):
            return "Error: plan_id must be a valid UUID"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(
                url, key, "PUT", "/api/plans/user/plan",
                {"planId": plan_id},
                agent_secret=self.agent_secret,
            )
            return (
                f"Plan Changed\n"
                f"  New Plan: {result.get('name', 'unknown')}\n"
                f"  Plan ID: {result.get('id', plan_id)}\n"
                f"  Effective: {result.get('effectiveAt', 'immediately')}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 37: Create Team
# ---------------------------------------------------------------------------


class DominusNodeCreateTeamTool(BaseTool):
    """Create a new team with a shared wallet."""

    name: str = "dominusnode_create_team"
    description: str = (
        "Create a new team with a shared wallet. "
        "Input: name (string, max 100 chars), optional max_members (1-100)."
    )
    args_schema: Type[BaseModel] = CreateTeamInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, name: str = "", max_members: Optional[int] = None, **kwargs: Any) -> str:
        err = _validate_label(name)
        if err:
            return f"Error (name): {err}"

        body: dict = {"name": name}
        if max_members is not None:
            err = _validate_positive_int(max_members, "max_members", min_value=1, max_value=100)
            if err:
                return f"Error: {err}"
            body["maxMembers"] = max_members

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "POST", "/api/teams", body, agent_secret=self.agent_secret)
            return (
                f"Team Created\n"
                f"  ID: {result.get('id', 'unknown')}\n"
                f"  Name: {result.get('name', name)}\n"
                f"  Max Members: {result.get('maxMembers', 'unlimited')}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 38: List Teams
# ---------------------------------------------------------------------------


class DominusNodeListTeamsTool(BaseTool):
    """List all teams the user belongs to."""

    name: str = "dominusnode_list_teams"
    description: str = (
        "List all teams the authenticated user belongs to."
    )
    args_schema: Type[BaseModel] = EmptyInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, **kwargs: Any) -> str:
        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "GET", "/api/teams", agent_secret=self.agent_secret)
            teams = result.get("teams", result) if isinstance(result, dict) else result
            if isinstance(teams, list):
                if not teams:
                    return "No teams found."
                lines = [f"Teams ({len(teams)}):"]
                for t in teams:
                    lines.append(
                        f"  - {t.get('name', 'unknown')} (ID: {t.get('id', '?')}, "
                        f"role: {t.get('role', '?')}, "
                        f"members: {t.get('memberCount', '?')})"
                    )
                return "\n".join(lines)
            return str(result)
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 39: Team Details
# ---------------------------------------------------------------------------


class DominusNodeTeamDetailsTool(BaseTool):
    """Get details for a specific team."""

    name: str = "dominusnode_team_details"
    description: str = (
        "Get details for a specific team including members, wallet balance, "
        "and settings. Input: team_id (UUID)."
    )
    args_schema: Type[BaseModel] = TeamIdInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(url, key, "GET", f"/api/teams/{quote(team_id, safe='')}", agent_secret=self.agent_secret)
            return (
                f"Team Details:\n"
                f"  ID: {result.get('id', team_id)}\n"
                f"  Name: {result.get('name', 'unknown')}\n"
                f"  Members: {result.get('memberCount', 'unknown')}\n"
                f"  Max Members: {result.get('maxMembers', 'unlimited')}\n"
                f"  Wallet Balance: {result.get('walletBalanceCents', 'unknown')} cents\n"
                f"  Created: {result.get('createdAt', 'unknown')}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 40: Update Team
# ---------------------------------------------------------------------------


class DominusNodeUpdateTeamTool(BaseTool):
    """Update team settings (name and/or max_members)."""

    name: str = "dominusnode_update_team"
    description: str = (
        "Update team settings. Input: team_id (UUID), optional name (max 100 chars), "
        "optional max_members (1-100). At least one field must be provided."
    )
    args_schema: Type[BaseModel] = UpdateTeamInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", name: Optional[str] = None, max_members: Optional[int] = None, **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        body: dict = {}
        if name is not None:
            err = _validate_label(name)
            if err:
                return f"Error (name): {err}"
            body["name"] = name

        if max_members is not None:
            err = _validate_positive_int(max_members, "max_members", min_value=1, max_value=100)
            if err:
                return f"Error: {err}"
            body["maxMembers"] = max_members

        if not body:
            return "Error: At least one of name or max_members must be provided"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(
                url, key, "PATCH",
                f"/api/teams/{quote(team_id, safe='')}",
                body,
                agent_secret=self.agent_secret,
            )
            return (
                f"Team Updated\n"
                f"  ID: {team_id}\n"
                f"  Name: {result.get('name', 'unchanged')}\n"
                f"  Max Members: {result.get('maxMembers', 'unchanged')}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 41: Delete Team
# ---------------------------------------------------------------------------


class DominusNodeTeamDeleteTool(BaseTool):
    """Delete a team."""

    name: str = "dominusnode_team_delete"
    description: str = (
        "Delete a team. This revokes all team keys and removes all members. "
        "Input: team_id (UUID)."
    )
    args_schema: Type[BaseModel] = TeamIdInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            _api_request_sync(url, key, "DELETE", f"/api/teams/{quote(team_id, safe='')}", agent_secret=self.agent_secret)
            return f"Team {team_id} has been deleted."
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 42: Team Fund
# ---------------------------------------------------------------------------


class DominusNodeTeamFundTool(BaseTool):
    """Fund a team's shared wallet from the user's personal wallet."""

    name: str = "dominusnode_team_fund"
    description: str = (
        "Transfer funds from the user's personal wallet to a team's shared wallet. "
        "Input: team_id (UUID), amount_cents (100-1,000,000)."
    )
    args_schema: Type[BaseModel] = TeamFundInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", amount_cents: int = 0, **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        err = _validate_positive_int(amount_cents, "amount_cents", min_value=100, max_value=1_000_000)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(
                url, key, "POST",
                f"/api/teams/{quote(team_id, safe='')}/wallet/fund",
                {"amountCents": amount_cents},
                agent_secret=self.agent_secret,
            )
            return (
                f"Team Wallet Funded\n"
                f"  Team ID: {team_id}\n"
                f"  Amount: {amount_cents} cents (${amount_cents / 100:.2f})\n"
                f"  New Balance: {result.get('balanceCents', 'unknown')} cents"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 43: Team Create Key
# ---------------------------------------------------------------------------


class DominusNodeTeamCreateKeyTool(BaseTool):
    """Create a new API key for a team."""

    name: str = "dominusnode_team_create_key"
    description: str = (
        "Create a new API key for a team. "
        "Input: team_id (UUID), label (string, max 100 chars). "
        "Returns the full API key (shown only once)."
    )
    args_schema: Type[BaseModel] = TeamCreateKeyInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", label: str = "", **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        err = _validate_label(label)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(
                url, key, "POST",
                f"/api/teams/{quote(team_id, safe='')}/keys",
                {"label": label},
                agent_secret=self.agent_secret,
            )
            return (
                f"Team API Key Created\n"
                f"  Team ID: {team_id}\n"
                f"  Key ID: {result.get('id', 'unknown')}\n"
                f"  Label: {result.get('label', label)}\n"
                f"  Key: {result.get('key', '[see response]')}\n\n"
                f"Save this key securely -- it will not be shown again."
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 44: Team Revoke Key
# ---------------------------------------------------------------------------


class DominusNodeTeamRevokeKeyTool(BaseTool):
    """Revoke (delete) an API key for a team."""

    name: str = "dominusnode_team_revoke_key"
    description: str = (
        "Revoke (delete) an API key for a team. "
        "Input: team_id (UUID), key_id (UUID)."
    )
    args_schema: Type[BaseModel] = TeamRevokeKeyInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", key_id: str = "", **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        if not key_id or not isinstance(key_id, str):
            return "Error: key_id is required and must be a non-empty string"
        if not _UUID_RE.match(key_id):
            return "Error: key_id must be a valid UUID"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            _api_request_sync(
                url, key, "DELETE",
                f"/api/teams/{quote(team_id, safe='')}/keys/{quote(key_id, safe='')}",
                agent_secret=self.agent_secret,
            )
            return f"Team API key {key_id} has been revoked."
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 45: Team List Keys
# ---------------------------------------------------------------------------


class DominusNodeTeamListKeysTool(BaseTool):
    """List all API keys for a team."""

    name: str = "dominusnode_team_list_keys"
    description: str = (
        "List all API keys for a team. Input: team_id (UUID)."
    )
    args_schema: Type[BaseModel] = TeamIdInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(
                url, key, "GET",
                f"/api/teams/{quote(team_id, safe='')}/keys",
                agent_secret=self.agent_secret,
            )
            keys_list = result.get("keys", result) if isinstance(result, dict) else result
            if isinstance(keys_list, list):
                if not keys_list:
                    return f"No API keys found for team {team_id}."
                lines = [f"Team API Keys ({len(keys_list)}):"]
                for k in keys_list:
                    lines.append(
                        f"  - {k.get('label', 'unknown')} (ID: {k.get('id', '?')}, "
                        f"prefix: {k.get('prefix', '?')}, "
                        f"created: {k.get('createdAt', '?')})"
                    )
                return "\n".join(lines)
            return str(result)
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 46: Team Usage
# ---------------------------------------------------------------------------


class DominusNodeTeamUsageTool(BaseTool):
    """Get usage/transaction history for a team."""

    name: str = "dominusnode_team_usage"
    description: str = (
        "Get usage and transaction history for a team's shared wallet. "
        "Input: team_id (UUID), optional limit (1-100)."
    )
    args_schema: Type[BaseModel] = TeamUsageInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", limit: Optional[int] = None, **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        if limit is not None:
            if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
                return "Error: limit must be an integer between 1 and 100"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        qs = f"?limit={limit}" if limit else ""
        try:
            result = _api_request_sync(
                url, key, "GET",
                f"/api/teams/{quote(team_id, safe='')}/wallet/transactions{qs}",
                agent_secret=self.agent_secret,
            )
            txns = result.get("transactions", result) if isinstance(result, dict) else result
            if isinstance(txns, list):
                if not txns:
                    return f"No transactions found for team {team_id}."
                lines = [f"Team Transactions ({len(txns)}):"]
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
# Tool 47: Team List Members
# ---------------------------------------------------------------------------


class DominusNodeTeamListMembersTool(BaseTool):
    """List all members of a team."""

    name: str = "dominusnode_team_list_members"
    description: str = (
        "List all members of a team. Input: team_id (UUID)."
    )
    args_schema: Type[BaseModel] = TeamIdInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(
                url, key, "GET",
                f"/api/teams/{quote(team_id, safe='')}/members",
                agent_secret=self.agent_secret,
            )
            members = result.get("members", result) if isinstance(result, dict) else result
            if isinstance(members, list):
                if not members:
                    return f"No members found for team {team_id}."
                lines = [f"Team Members ({len(members)}):"]
                for m in members:
                    lines.append(
                        f"  - {m.get('email', 'unknown')} (ID: {m.get('userId', '?')}, "
                        f"role: {m.get('role', '?')}, "
                        f"joined: {m.get('joinedAt', '?')})"
                    )
                return "\n".join(lines)
            return str(result)
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 48: Team Add Member
# ---------------------------------------------------------------------------


class DominusNodeTeamAddMemberTool(BaseTool):
    """Add a member to a team by email."""

    name: str = "dominusnode_team_add_member"
    description: str = (
        "Add a member to a team by email address. "
        "Input: team_id (UUID), email (string), optional role ('member' or 'admin')."
    )
    args_schema: Type[BaseModel] = TeamAddMemberInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", email: str = "", role: str = "member", **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        err = _validate_email(email)
        if err:
            return f"Error: {err}"

        if role not in ("member", "admin"):
            return "Error: role must be 'member' or 'admin'"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(
                url, key, "POST",
                f"/api/teams/{quote(team_id, safe='')}/members",
                {"email": email, "role": role},
                agent_secret=self.agent_secret,
            )
            return (
                f"Member Added to Team\n"
                f"  Team ID: {team_id}\n"
                f"  Email: {email}\n"
                f"  Role: {role}\n"
                f"  User ID: {result.get('userId', 'unknown')}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 49: Team Remove Member
# ---------------------------------------------------------------------------


class DominusNodeTeamRemoveMemberTool(BaseTool):
    """Remove a member from a team."""

    name: str = "dominusnode_team_remove_member"
    description: str = (
        "Remove a member from a team. "
        "Input: team_id (UUID), user_id (UUID)."
    )
    args_schema: Type[BaseModel] = TeamRemoveMemberInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", user_id: str = "", **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        err = _validate_user_id(user_id)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            _api_request_sync(
                url, key, "DELETE",
                f"/api/teams/{quote(team_id, safe='')}/members/{quote(user_id, safe='')}",
                agent_secret=self.agent_secret,
            )
            return f"Member {user_id} has been removed from team {team_id}."
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 50: Update Team Member Role
# ---------------------------------------------------------------------------


class DominusNodeUpdateTeamMemberRoleTool(BaseTool):
    """Update the role of a team member."""

    name: str = "dominusnode_update_team_member_role"
    description: str = (
        "Update the role of a team member. "
        "Input: team_id (UUID), user_id (UUID), role ('member' or 'admin')."
    )
    args_schema: Type[BaseModel] = UpdateTeamMemberRoleInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", user_id: str = "", role: str = "", **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        err = _validate_user_id(user_id)
        if err:
            return f"Error: {err}"

        if not role or not isinstance(role, str):
            return "Error: role is required and must be a string"
        if role not in ("member", "admin"):
            return "Error: role must be 'member' or 'admin'"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(
                url, key, "PATCH",
                f"/api/teams/{quote(team_id, safe='')}/members/{quote(user_id, safe='')}",
                {"role": role},
                agent_secret=self.agent_secret,
            )
            return (
                f"Team Member Role Updated\n"
                f"  Team ID: {team_id}\n"
                f"  User ID: {user_id}\n"
                f"  New Role: {result.get('role', role)}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 51: Team Invite Member
# ---------------------------------------------------------------------------


class DominusNodeTeamInviteMemberTool(BaseTool):
    """Invite a member to a team by email."""

    name: str = "dominusnode_team_invite_member"
    description: str = (
        "Send an invitation to join a team. "
        "Input: team_id (UUID), email (string), optional role ('member' or 'admin')."
    )
    args_schema: Type[BaseModel] = TeamInviteMemberInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", email: str = "", role: str = "member", **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        err = _validate_email(email)
        if err:
            return f"Error: {err}"

        if role not in ("member", "admin"):
            return "Error: role must be 'member' or 'admin'"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(
                url, key, "POST",
                f"/api/teams/{quote(team_id, safe='')}/invites",
                {"email": email, "role": role},
                agent_secret=self.agent_secret,
            )
            return (
                f"Team Invitation Sent\n"
                f"  Team ID: {team_id}\n"
                f"  Email: {email}\n"
                f"  Role: {role}\n"
                f"  Invite ID: {result.get('id', 'unknown')}"
            )
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 52: Team List Invites
# ---------------------------------------------------------------------------


class DominusNodeTeamListInvitesTool(BaseTool):
    """List all pending invitations for a team."""

    name: str = "dominusnode_team_list_invites"
    description: str = (
        "List all pending invitations for a team. Input: team_id (UUID)."
    )
    args_schema: Type[BaseModel] = TeamIdInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            result = _api_request_sync(
                url, key, "GET",
                f"/api/teams/{quote(team_id, safe='')}/invites",
                agent_secret=self.agent_secret,
            )
            invites = result.get("invites", result) if isinstance(result, dict) else result
            if isinstance(invites, list):
                if not invites:
                    return f"No pending invitations for team {team_id}."
                lines = [f"Team Invitations ({len(invites)}):"]
                for i in invites:
                    lines.append(
                        f"  - {i.get('email', 'unknown')} (ID: {i.get('id', '?')}, "
                        f"role: {i.get('role', '?')}, "
                        f"status: {i.get('status', '?')}, "
                        f"created: {i.get('createdAt', '?')})"
                    )
                return "\n".join(lines)
            return str(result)
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"


# ---------------------------------------------------------------------------
# Tool 53: Team Cancel Invite
# ---------------------------------------------------------------------------


class DominusNodeTeamCancelInviteTool(BaseTool):
    """Cancel a pending team invitation."""

    name: str = "dominusnode_team_cancel_invite"
    description: str = (
        "Cancel a pending team invitation. "
        "Input: team_id (UUID), invite_id (UUID)."
    )
    args_schema: Type[BaseModel] = TeamInviteIdInput

    api_key: Optional[str] = Field(default=None, exclude=True)
    base_url: Optional[str] = Field(default=None, exclude=True)
    agent_secret: Optional[str] = Field(default=None, exclude=True)

    def _run(self, team_id: str = "", invite_id: str = "", **kwargs: Any) -> str:
        err = _validate_team_id(team_id)
        if err:
            return f"Error: {err}"

        if not invite_id or not isinstance(invite_id, str):
            return "Error: invite_id is required and must be a non-empty string"
        if not _UUID_RE.match(invite_id):
            return "Error: invite_id must be a valid UUID"

        key = self.api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        url = self.base_url or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        if not key:
            return "Error: Dominus Node API key is required. Pass api_key= or set DOMINUSNODE_API_KEY."

        try:
            _api_request_sync(
                url, key, "DELETE",
                f"/api/teams/{quote(team_id, safe='')}/invites/{quote(invite_id, safe='')}",
                agent_secret=self.agent_secret,
            )
            return f"Invitation {invite_id} for team {team_id} has been cancelled."
        except httpx.HTTPStatusError as exc:
            return f"Error: API returned {exc.response.status_code} -- {_sanitize_error(exc.response.text[:200])}"
        except Exception as exc:
            return f"Error: {_sanitize_error(str(exc))}"
