"""Dominus Node Langflow toolkit -- 26 proxy, wallet, team, and payment management tools.

Provides a Langflow-compatible toolkit class that exposes 26 LangChain
StructuredTool objects for interacting with the Dominus Node rotating
proxy-as-a-service platform.

Tools cover:
  - Proxied HTTP fetching through rotating proxies
  - Wallet balance and usage monitoring
  - Proxy configuration and session listing
  - Agentic wallet management (create, fund, freeze, unfreeze, delete)
  - Team management (create, list, fund, keys, usage, update, role changes)
  - PayPal top-up

Security:
  - Full SSRF prevention (private IP blocking, DNS rebinding, Teredo/6to4,
    IPv4-mapped/compatible IPv6, hex/octal/decimal normalization, zone ID
    stripping, .localhost/.local/.internal/.arpa TLD blocking, embedded
    credential blocking)
  - OFAC sanctioned country validation (CU, IR, KP, RU, SY)
  - Credential scrubbing in all error outputs
  - Prototype pollution prevention on all parsed JSON
  - HTTP method restriction (GET/HEAD/OPTIONS only for proxied fetch)
  - 10 MB response cap, 4000 char truncation, 30 s timeout
  - Redirect following disabled to prevent open redirect abuse

Example::

    from dominusnode_langflow import DominusNodeToolkit

    toolkit = DominusNodeToolkit(api_key="dn_live_...")
    tools = toolkit.get_tools()  # list of StructuredTool

Requires: httpx, langchain-core
"""

from __future__ import annotations

import ipaddress
import json
import math
import os
import re
import socket
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set
from urllib.parse import quote, urlparse

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# SSRF Prevention -- blocked hostnames
# ---------------------------------------------------------------------------

BLOCKED_HOSTNAMES: Set[str] = {
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "0.0.0.0",
    "[::]",
}

# ---------------------------------------------------------------------------
# SSRF Prevention -- blocked IP networks
# ---------------------------------------------------------------------------

_BLOCKED_IPV4_NETWORKS = [
    ipaddress.IPv4Network("0.0.0.0/8"),
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("100.64.0.0/10"),       # CGNAT
    ipaddress.IPv4Network("127.0.0.0/8"),
    ipaddress.IPv4Network("169.254.0.0/16"),       # link-local
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.0.0.0/24"),
    ipaddress.IPv4Network("192.0.2.0/24"),         # TEST-NET-1
    ipaddress.IPv4Network("192.168.0.0/16"),
    ipaddress.IPv4Network("198.18.0.0/15"),        # benchmarking
    ipaddress.IPv4Network("198.51.100.0/24"),      # TEST-NET-2
    ipaddress.IPv4Network("203.0.113.0/24"),       # TEST-NET-3
    ipaddress.IPv4Network("224.0.0.0/4"),          # multicast
    ipaddress.IPv4Network("240.0.0.0/4"),          # reserved
    ipaddress.IPv4Network("255.255.255.255/32"),
]

_BLOCKED_IPV6_NETWORKS = [
    ipaddress.IPv6Network("::1/128"),              # loopback
    ipaddress.IPv6Network("::/128"),               # unspecified
    ipaddress.IPv6Network("::ffff:0:0/96"),        # IPv4-mapped
    ipaddress.IPv6Network("64:ff9b::/96"),         # NAT64
    ipaddress.IPv6Network("100::/64"),             # discard
    ipaddress.IPv6Network("fe80::/10"),            # link-local
    ipaddress.IPv6Network("fc00::/7"),             # ULA (includes fd00::/8)
    ipaddress.IPv6Network("ff00::/8"),             # multicast
]

# ---------------------------------------------------------------------------
# SSRF Prevention -- IP normalization and validation
# ---------------------------------------------------------------------------


def _normalize_ipv4(hostname: str) -> Optional[str]:
    """Normalize non-standard IPv4 representations to dotted-decimal.

    Handles hex (0x7f000001), octal (0177.0.0.1), and decimal integer
    (2130706433) forms to prevent SSRF bypasses.
    """
    # Single decimal integer (e.g., 2130706433 = 127.0.0.1)
    if re.match(r"^\d+$", hostname):
        n = int(hostname)
        if 0 <= n <= 0xFFFFFFFF:
            return (
                f"{(n >> 24) & 0xFF}.{(n >> 16) & 0xFF}"
                f".{(n >> 8) & 0xFF}.{n & 0xFF}"
            )

    # Hex notation (e.g., 0x7f000001)
    if re.match(r"^0x[0-9a-fA-F]+$", hostname, re.IGNORECASE):
        n = int(hostname, 16)
        if 0 <= n <= 0xFFFFFFFF:
            return (
                f"{(n >> 24) & 0xFF}.{(n >> 16) & 0xFF}"
                f".{(n >> 8) & 0xFF}.{n & 0xFF}"
            )

    # Octal or mixed-radix octets (e.g., 0177.0.0.1)
    parts = hostname.split(".")
    if len(parts) == 4:
        octets = []
        for part in parts:
            try:
                if re.match(r"^0x[0-9a-fA-F]+$", part, re.IGNORECASE):
                    val = int(part, 16)
                elif re.match(r"^0\d+$", part):
                    val = int(part, 8)
                elif re.match(r"^\d+$", part):
                    val = int(part, 10)
                else:
                    return None
                if val < 0 or val > 255:
                    return None
                octets.append(val)
            except ValueError:
                return None
        return ".".join(str(o) for o in octets)

    return None


def _extract_teredo_ipv4(addr: ipaddress.IPv6Address) -> Optional[ipaddress.IPv4Address]:
    """Extract the embedded IPv4 server/client from a Teredo address (2001:0000::/32).

    Teredo format: 2001:0000:SSSS:SSSS:flags:port:CCCC:CCCC
    where SSSS:SSSS is the Teredo server IPv4 and CCCC:CCCC (XORed with 0xFFFF)
    is the client IPv4.  Both must be checked.
    """
    packed = addr.packed  # 16 bytes
    # Server IPv4 at bytes 4-7
    server_ip = ipaddress.IPv4Address(packed[4:8])
    # Client IPv4 at bytes 12-15 (XOR with 0xFFFFFFFF)
    client_bytes = bytes(b ^ 0xFF for b in packed[12:16])
    client_ip = ipaddress.IPv4Address(client_bytes)
    # Return whichever is private (or server if both are)
    for ip in (server_ip, client_ip):
        if any(ip in net for net in _BLOCKED_IPV4_NETWORKS):
            return ip
    return None


def _extract_6to4_ipv4(addr: ipaddress.IPv6Address) -> Optional[ipaddress.IPv4Address]:
    """Extract the embedded IPv4 from a 6to4 address (2002::/16).

    6to4 format: 2002:AABB:CCDD::... where AA.BB.CC.DD is the IPv4.
    """
    packed = addr.packed
    return ipaddress.IPv4Address(packed[2:6])


def _is_private_ip(hostname: str) -> bool:
    """Check if a hostname/IP resolves to a private/reserved IP range.

    Handles:
      - Standard dotted-decimal IPv4
      - Hex, octal, and decimal-encoded IPv4
      - IPv6 with bracket stripping and zone ID removal
      - IPv4-mapped IPv6 (::ffff:x.x.x.x)
      - IPv4-compatible IPv6 (::x.x.x.x)
      - Teredo tunneling (2001:0000::/32)
      - 6to4 tunneling (2002::/16)
    """
    ip = hostname.strip("[]")

    # Strip IPv6 zone ID
    zone_idx = ip.find("%")
    if zone_idx != -1:
        ip = ip[:zone_idx]

    # Try normalizing non-standard IPv4 first
    normalized = _normalize_ipv4(ip)
    check_ip = normalized if normalized else ip

    # Try parsing as a standard IP address via ipaddress module
    try:
        addr = ipaddress.ip_address(check_ip)
    except ValueError:
        # Not a raw IP literal -- check well-known hostnames
        lower = hostname.lower()
        if lower in ("localhost", "localhost.localdomain"):
            return True
        if lower.endswith(".localhost"):
            return True
        # Hex-encoded IPv4 (e.g. 0x7f000001)
        if lower.startswith("0x"):
            try:
                num = int(lower, 16)
                if 0 <= num <= 0xFFFFFFFF:
                    a = ipaddress.IPv4Address(num)
                    return any(a in net for net in _BLOCKED_IPV4_NETWORKS)
            except (ValueError, ipaddress.AddressValueError):
                pass
        # Decimal-encoded IPv4 (e.g. 2130706433)
        if lower.isdigit():
            try:
                num = int(lower)
                if 0 <= num <= 0xFFFFFFFF:
                    a = ipaddress.IPv4Address(num)
                    return any(a in net for net in _BLOCKED_IPV4_NETWORKS)
            except (ValueError, ipaddress.AddressValueError):
                pass
        return False

    if isinstance(addr, ipaddress.IPv4Address):
        return any(addr in net for net in _BLOCKED_IPV4_NETWORKS)

    if isinstance(addr, ipaddress.IPv6Address):
        # Check against IPv6 blocked networks
        if any(addr in net for net in _BLOCKED_IPV6_NETWORKS):
            return True

        # IPv4-mapped IPv6 (::ffff:x.x.x.x)
        mapped = addr.ipv4_mapped
        if mapped is not None:
            return any(mapped in net for net in _BLOCKED_IPV4_NETWORKS)

        # IPv4-compatible IPv6 (::x.x.x.x) -- deprecated but still a bypass vector
        # These are addresses like ::127.0.0.1 or ::10.0.0.1
        packed = addr.packed
        if all(b == 0 for b in packed[:12]):
            embedded = ipaddress.IPv4Address(packed[12:16])
            return any(embedded in net for net in _BLOCKED_IPV4_NETWORKS)

        # Teredo tunneling (2001:0000::/32)
        if addr in ipaddress.IPv6Network("2001:0000::/32"):
            private_v4 = _extract_teredo_ipv4(addr)
            if private_v4 is not None:
                return True
            # Even if both IPs are "public", Teredo is suspicious -- block it
            return True

        # 6to4 tunneling (2002::/16) -- block unconditionally
        if addr in ipaddress.IPv6Network("2002::/16"):
            return True

    return False


# ---------------------------------------------------------------------------
# SSRF Prevention -- full URL validation
# ---------------------------------------------------------------------------


def validate_url(url: str) -> str:
    """Validate a URL for SSRF safety.

    Args:
        url: The URL to validate.

    Returns:
        The validated URL string.

    Raises:
        ValueError: If the URL is invalid or targets a private/blocked address.
    """
    if not url or not isinstance(url, str):
        raise ValueError("URL must be a non-empty string")

    if len(url) > 2048:
        raise ValueError("URL exceeds maximum length of 2048 characters")

    try:
        parsed = urlparse(url)
    except Exception:
        raise ValueError(f"Invalid URL: {url}")

    if parsed.scheme not in ("http", "https"):
        raise ValueError(
            f"Only http: and https: protocols are supported, got {parsed.scheme}:"
        )

    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise ValueError("URL must contain a hostname")

    # Block well-known loopback hostnames
    if hostname in BLOCKED_HOSTNAMES:
        raise ValueError("Requests to localhost/loopback addresses are blocked")

    # Block private/reserved IPs
    if _is_private_ip(hostname):
        raise ValueError("Requests to private/internal IP addresses are blocked")

    # Block dangerous TLD suffixes
    if hostname.endswith(".localhost"):
        raise ValueError("Requests to .localhost addresses are blocked")

    if (
        hostname.endswith(".local")
        or hostname.endswith(".internal")
        or hostname.endswith(".arpa")
    ):
        raise ValueError("Requests to internal network hostnames are blocked")

    # Block embedded credentials in URL
    if parsed.username or parsed.password:
        raise ValueError("URLs with embedded credentials are not allowed")

    # DNS rebinding protection: resolve hostname and check all resolved IPs
    try:
        ipaddress.ip_address(hostname.strip("[]"))
    except ValueError:
        # It is a hostname, not a raw IP -- resolve and check
        try:
            infos = socket.getaddrinfo(
                hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM
            )
            for _family, _type, _proto, _canonname, sockaddr in infos:
                addr_str = sockaddr[0]
                # Strip zone ID from resolved addresses
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
# Sanctioned countries (OFAC)
# ---------------------------------------------------------------------------

SANCTIONED_COUNTRIES: Set[str] = {"CU", "IR", "KP", "RU", "SY"}

# ---------------------------------------------------------------------------
# Max response size
# ---------------------------------------------------------------------------

MAX_RESPONSE_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_RESPONSE_CHARS = 4000

# ---------------------------------------------------------------------------
# Credential sanitization
# ---------------------------------------------------------------------------

_CREDENTIAL_RE = re.compile(r"dn_(live|test)_[a-zA-Z0-9]+")


def _sanitize_error(message: str) -> str:
    """Remove Dominus Node API key patterns from error messages."""
    return _CREDENTIAL_RE.sub("***", message)


# ---------------------------------------------------------------------------
# Prototype pollution prevention
# ---------------------------------------------------------------------------

_DANGEROUS_KEYS = frozenset({"__proto__", "constructor", "prototype"})


def _strip_dangerous_keys(obj: Any, depth: int = 0) -> None:
    """Recursively remove prototype pollution keys from parsed JSON."""
    if depth > 50 or obj is None or not isinstance(obj, (dict, list)):
        return
    if isinstance(obj, list):
        for item in obj:
            _strip_dangerous_keys(item, depth + 1)
        return
    keys_to_remove = [k for k in obj if k in _DANGEROUS_KEYS]
    for k in keys_to_remove:
        del obj[k]
    for v in obj.values():
        if isinstance(v, (dict, list)):
            _strip_dangerous_keys(v, depth + 1)


# ---------------------------------------------------------------------------
# Allowed HTTP methods for proxied fetch
# ---------------------------------------------------------------------------

_ALLOWED_FETCH_METHODS: Set[str] = {"GET", "HEAD", "OPTIONS"}

# ---------------------------------------------------------------------------
# UUID regex for ID validation
# ---------------------------------------------------------------------------

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Period to date range helper
# ---------------------------------------------------------------------------


def _period_to_date_range(period: str) -> Dict[str, str]:
    """Convert a human-readable period to ISO date range parameters."""
    now = datetime.now(timezone.utc)
    until = now.isoformat()

    if period == "day":
        since = (now - timedelta(days=1)).isoformat()
    elif period == "week":
        since = (now - timedelta(weeks=1)).isoformat()
    else:  # month (default)
        since = (now - timedelta(days=30)).isoformat()

    return {"since": since, "until": until}


# ---------------------------------------------------------------------------
# Input validation helpers
# ---------------------------------------------------------------------------


def _validate_label(label: Any, field_name: str = "label") -> Optional[str]:
    """Validate a label string, returning an error message or None."""
    if not label or not isinstance(label, str):
        return f"{field_name} is required and must be a string"
    if len(label) > 100:
        return f"{field_name} must be 100 characters or fewer"
    if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in label):
        return f"{field_name} contains invalid control characters"
    return None


def _validate_positive_int(
    value: Any,
    field_name: str,
    max_value: int = 2_147_483_647,
    min_value: int = 1,
) -> Optional[str]:
    """Validate that value is an integer within range, returning error or None."""
    if not isinstance(value, int) or isinstance(value, bool):
        return f"{field_name} must be an integer"
    if value < min_value or value > max_value:
        return f"{field_name} must be between {min_value} and {max_value}"
    return None


def _validate_uuid(value: Any, field_name: str) -> Optional[str]:
    """Validate that value is a valid UUID string, returning error or None."""
    if not value or not isinstance(value, str):
        return f"{field_name} is required and must be a string"
    if not _UUID_RE.match(value):
        return f"{field_name} must be a valid UUID"
    return None


_DOMAIN_RE = re.compile(
    r"^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$"
)


def _validate_domains(domains: Any) -> Optional[str]:
    """Validate allowed_domains list, returning error message or None."""
    if not isinstance(domains, list):
        return "allowed_domains must be a list of strings"
    if len(domains) > 100:
        return "allowed_domains must have at most 100 entries"
    for i, d in enumerate(domains):
        if not isinstance(d, str) or not d:
            return f"allowed_domains[{i}] must be a non-empty string"
        if len(d) > 253:
            return f"allowed_domains[{i}] exceeds 253 characters"
        if not _DOMAIN_RE.match(d):
            return f"allowed_domains[{i}] is not a valid domain"
    return None


# ===========================================================================
# Pydantic input schemas for StructuredTool
# ===========================================================================


class ProxiedFetchInput(BaseModel):
    """Input schema for the proxied_fetch tool."""
    url: str = Field(description="Target URL to fetch through the proxy")
    method: str = Field(
        default="GET",
        description="HTTP method (GET, HEAD, or OPTIONS only)",
    )
    country: Optional[str] = Field(
        default=None,
        description="ISO 3166-1 alpha-2 country code for geo-targeting",
    )
    proxy_type: str = Field(
        default="dc",
        description="Proxy type: dc (datacenter, $3/GB) or residential ($5/GB)",
    )


class CheckUsageInput(BaseModel):
    """Input schema for the check_usage tool."""
    period: str = Field(
        default="month",
        description="Time period: day, week, or month",
    )


class CreateAgenticWalletInput(BaseModel):
    """Input schema for the create_agentic_wallet tool."""
    label: str = Field(description="Human-readable label for the wallet (max 100 chars)")
    spending_limit_cents: int = Field(
        description="Per-transaction spending limit in cents",
    )


class FundAgenticWalletInput(BaseModel):
    """Input schema for the fund_agentic_wallet tool."""
    wallet_id: str = Field(description="ID of the agentic wallet to fund")
    amount_cents: int = Field(description="Amount to transfer in cents")


class AgenticWalletBalanceInput(BaseModel):
    """Input schema for the agentic_wallet_balance tool."""
    wallet_id: str = Field(description="ID of the agentic wallet")


class ListAgenticWalletsInput(BaseModel):
    """Input schema for the list_agentic_wallets tool (no params)."""
    pass


class AgenticTransactionsInput(BaseModel):
    """Input schema for the agentic_transactions tool."""
    wallet_id: str = Field(description="ID of the agentic wallet")
    limit: int = Field(
        default=20,
        description="Max number of transactions to return (1-100)",
    )


class FreezeAgenticWalletInput(BaseModel):
    """Input schema for the freeze_agentic_wallet tool."""
    wallet_id: str = Field(description="ID of the agentic wallet to freeze")


class UnfreezeAgenticWalletInput(BaseModel):
    """Input schema for the unfreeze_agentic_wallet tool."""
    wallet_id: str = Field(description="ID of the agentic wallet to unfreeze")


class DeleteAgenticWalletInput(BaseModel):
    """Input schema for the delete_agentic_wallet tool."""
    wallet_id: str = Field(description="ID of the agentic wallet to delete")


class CreateTeamInput(BaseModel):
    """Input schema for the create_team tool."""
    name: str = Field(description="Team name (max 100 chars)")
    max_members: Optional[int] = Field(
        default=None,
        description="Max number of team members (1-100)",
    )


class TeamDetailsInput(BaseModel):
    """Input schema for the team_details tool."""
    team_id: str = Field(description="UUID of the team")


class TeamFundInput(BaseModel):
    """Input schema for the team_fund tool."""
    team_id: str = Field(description="UUID of the team")
    amount_cents: int = Field(
        description="Amount to transfer in cents (100 to 1,000,000)",
    )


class TeamCreateKeyInput(BaseModel):
    """Input schema for the team_create_key tool."""
    team_id: str = Field(description="UUID of the team")
    label: str = Field(description="Human-readable label for the key (max 100 chars)")


class TeamUsageInput(BaseModel):
    """Input schema for the team_usage tool."""
    team_id: str = Field(description="UUID of the team")
    limit: int = Field(
        default=20,
        description="Max number of records to return (1-100)",
    )


class UpdateTeamInput(BaseModel):
    """Input schema for the update_team tool."""
    team_id: str = Field(description="UUID of the team")
    name: Optional[str] = Field(
        default=None,
        description="New team name (max 100 chars)",
    )
    max_members: Optional[int] = Field(
        default=None,
        description="New max member count (1-100)",
    )


class UpdateTeamMemberRoleInput(BaseModel):
    """Input schema for the update_team_member_role tool."""
    team_id: str = Field(description="UUID of the team")
    user_id: str = Field(description="UUID of the user whose role to change")
    role: str = Field(description="New role: member or admin")


class TopupPaypalInput(BaseModel):
    """Input schema for the topup_paypal tool."""
    amount_cents: int = Field(
        description="Amount to top up in cents (500 to 1,000,000). Minimum $5.00.",
    )


class TopupStripeInput(BaseModel):
    """Input schema for the topup_stripe tool."""
    amount_cents: int = Field(
        description="Amount to top up in cents (500 to 100,000). Minimum $5.00, maximum $1,000.",
    )


class TopupCryptoInput(BaseModel):
    """Input schema for the topup_crypto tool."""
    amount_usd: float = Field(
        description="Amount to top up in USD (5 to 1,000).",
    )
    currency: str = Field(
        description="Cryptocurrency: btc, eth, ltc, xmr, zec, usdc, sol, usdt, dai, bnb, or link.",
    )


class UpdateWalletPolicyInput(BaseModel):
    """Input schema for the update_wallet_policy tool."""
    wallet_id: str = Field(description="ID of the agentic wallet")
    daily_limit_cents: Optional[int] = Field(
        default=None,
        description="Daily budget cap in cents (1 to 1,000,000)",
    )
    allowed_domains: Optional[List[str]] = Field(
        default=None,
        description="List of allowed domains (max 100, each <= 253 chars)",
    )


class EmptyInput(BaseModel):
    """Empty input schema for tools that take no parameters."""
    pass


# ===========================================================================
# DominusNodeToolkit -- main toolkit class
# ===========================================================================


class DominusNodeToolkit:
    """Langflow-compatible toolkit providing Dominus Node rotating proxy tools.

    Authenticates using a Dominus Node API key and exposes 26 tools as LangChain
    StructuredTool objects compatible with Langflow's visual tool system.

    Args:
        api_key: Dominus Node API key (``dn_live_...`` or ``dn_test_...``).
            Falls back to ``DOMINUSNODE_API_KEY`` environment variable.
        base_url: Base URL of the Dominus Node REST API.
        proxy_host: Hostname of the Dominus Node proxy gateway.
        proxy_port: Port of the Dominus Node proxy gateway.
        timeout: HTTP request timeout in seconds.

    Example::

        toolkit = DominusNodeToolkit(api_key="dn_live_abc123")
        tools = toolkit.get_tools()  # list of StructuredTool
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = "https://api.dominusnode.com",
        proxy_host: str = "proxy.dominusnode.com",
        proxy_port: int = 8080,
        timeout: float = 30.0,
        agent_secret: str | None = None,
    ):
        self.api_key = api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        self.base_url = base_url.rstrip("/")
        self.proxy_host = os.environ.get("DOMINUSNODE_PROXY_HOST", proxy_host)
        self.proxy_port = int(os.environ.get("DOMINUSNODE_PROXY_PORT", str(proxy_port)))
        self.timeout = timeout
        self.agent_secret: str | None = agent_secret or os.environ.get("DOMINUSNODE_AGENT_SECRET")
        self._token: str | None = None

    # ------------------------------------------------------------------
    # Authentication
    # ------------------------------------------------------------------

    def _authenticate(self) -> str:
        """Authenticate with the Dominus Node API using the API key.

        Returns:
            The JWT bearer token.

        Raises:
            RuntimeError: If authentication fails.
        """
        if not self.api_key:
            raise RuntimeError(
                "Dominus Node API key is required. Pass api_key or set "
                "DOMINUSNODE_API_KEY environment variable."
            )

        with httpx.Client(
            timeout=self.timeout,
            follow_redirects=False,
        ) as client:
            auth_headers = {
                "User-Agent": "dominusnode-langflow/1.0.0",
                "Content-Type": "application/json",
            }
            if self.agent_secret:
                auth_headers["X-DominusNode-Agent"] = "mcp"
                auth_headers["X-DominusNode-Agent-Secret"] = self.agent_secret

            resp = client.post(
                f"{self.base_url}/api/auth/verify-key",
                json={"apiKey": self.api_key},
                headers=auth_headers,
            )

            if resp.status_code != 200:
                body = _sanitize_error(resp.text[:500])
                raise RuntimeError(
                    f"Authentication failed ({resp.status_code}): {body}"
                )

            data = resp.json()
            token = data.get("token")
            if not token:
                raise RuntimeError("Authentication response missing token")
            self._token = token
            return token

    def _ensure_auth(self) -> None:
        """Ensure the toolkit is authenticated, authenticating if needed."""
        if self._token is None:
            self._authenticate()

    # ------------------------------------------------------------------
    # API request helper
    # ------------------------------------------------------------------

    def _api_request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Make an authenticated API request to the Dominus Node REST API.

        Args:
            method: HTTP method (GET, POST, PATCH, DELETE).
            path: API path (e.g., ``/api/wallet``).
            body: Optional JSON body.

        Returns:
            Parsed JSON response (with dangerous keys stripped).

        Raises:
            RuntimeError: On auth failure, API errors, or oversized responses.
        """
        if self._token is None:
            raise RuntimeError("Not authenticated")

        with httpx.Client(
            timeout=self.timeout,
            follow_redirects=False,
        ) as client:
            req_headers: Dict[str, str] = {
                "User-Agent": "dominusnode-langflow/1.0.0",
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._token}",
            }
            if self.agent_secret:
                req_headers["X-DominusNode-Agent"] = "mcp"
                req_headers["X-DominusNode-Agent-Secret"] = self.agent_secret

            kwargs: Dict[str, Any] = {
                "headers": req_headers,
            }

            if body is not None and method.upper() not in ("GET", "HEAD", "OPTIONS"):
                kwargs["json"] = body

            resp = client.request(method, f"{self.base_url}{path}", **kwargs)

            if len(resp.content) > MAX_RESPONSE_BYTES:
                raise RuntimeError("Response body too large")

            if resp.status_code >= 400:
                try:
                    err_data = resp.json()
                    msg = err_data.get("error", resp.text)
                except Exception:
                    msg = resp.text
                msg = str(msg)[:500]
                raise RuntimeError(
                    f"API error {resp.status_code}: {_sanitize_error(msg)}"
                )

            if resp.text:
                data = resp.json()
                _strip_dangerous_keys(data)
                return data
            return {}

    def _request_with_retry(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Make an API request, retrying once on 401 (token expired)."""
        self._ensure_auth()
        try:
            return self._api_request(method, path, body)
        except RuntimeError as e:
            if "401" in str(e):
                self._token = None
                self._ensure_auth()
                return self._api_request(method, path, body)
            raise

    # ==================================================================
    # Tool 1: proxied_fetch
    # ==================================================================

    def proxied_fetch(
        self,
        url: str,
        method: str = "GET",
        country: str | None = None,
        proxy_type: str = "dc",
    ) -> str:
        """Fetch a URL through the Dominus Node rotating proxy network.

        Args:
            url: Target URL to fetch.
            method: HTTP method (GET, HEAD, or OPTIONS only).
            country: Optional ISO 3166-1 alpha-2 country code for geo-targeting.
            proxy_type: Proxy type: ``dc`` (datacenter, $3/GB) or
                ``residential`` ($5/GB). Default: ``dc``.

        Returns:
            JSON string with status, headers, and body (truncated to 4000 chars).
        """
        # Validate URL for SSRF
        try:
            validate_url(url)
        except ValueError as e:
            return json.dumps({"error": str(e)})

        # OFAC country check
        if country:
            upper = country.upper()
            if upper in SANCTIONED_COUNTRIES:
                return json.dumps(
                    {"error": f"Country '{upper}' is blocked (OFAC sanctioned country)"}
                )

        # Restrict HTTP methods
        method_upper = (method or "GET").upper()
        if method_upper not in _ALLOWED_FETCH_METHODS:
            return json.dumps({
                "error": (
                    f"HTTP method '{method_upper}' is not allowed. "
                    "Only GET, HEAD, OPTIONS are permitted."
                )
            })

        # Validate proxy_type
        if proxy_type not in ("dc", "residential", "auto"):
            return json.dumps({
                "error": "proxy_type must be 'dc', 'residential', or 'auto'"
            })

        try:
            # Build proxy username for routing
            parts: list[str] = []
            if proxy_type and proxy_type != "auto":
                parts.append(proxy_type)
            if country:
                parts.append(f"country-{country.upper()}")
            username = "-".join(parts) if parts else "auto"

            proxy_url = (
                f"http://{username}:{self.api_key}"
                f"@{self.proxy_host}:{self.proxy_port}"
            )

            with httpx.Client(
                proxy=proxy_url,
                timeout=self.timeout,
                follow_redirects=False,
                max_redirects=0,
            ) as proxy_client:
                resp = proxy_client.request(
                    method=method_upper,
                    url=url,
                )

                # Enforce response size limit
                if len(resp.content) > MAX_RESPONSE_BYTES:
                    return json.dumps({"error": "Response body too large (>10 MB)"})

                body = resp.text[:MAX_RESPONSE_CHARS]
                resp_headers = dict(resp.headers)
                # Scrub sensitive response headers
                for h in ("set-cookie", "www-authenticate", "proxy-authenticate"):
                    resp_headers.pop(h, None)

                return json.dumps({
                    "status": resp.status_code,
                    "headers": resp_headers,
                    "body": body,
                })
        except Exception as e:
            return json.dumps({
                "error": f"Proxy fetch failed: {_sanitize_error(str(e))}",
                "hint": "Ensure the Dominus Node proxy gateway is running and accessible.",
            })

    # ==================================================================
    # Tool 2: check_balance
    # ==================================================================

    def check_balance(self) -> str:
        """Check the current wallet balance.

        Returns:
            JSON string with wallet balance information.
        """
        try:
            result = self._request_with_retry("GET", "/api/wallet")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 3: check_usage
    # ==================================================================

    def check_usage(self, period: str = "month") -> str:
        """Check proxy usage statistics.

        Args:
            period: Time period -- ``day``, ``week``, or ``month`` (default).

        Returns:
            JSON string with usage statistics.
        """
        if period not in ("day", "week", "month"):
            return json.dumps({"error": "period must be 'day', 'week', or 'month'"})
        try:
            date_range = _period_to_date_range(period)
            result = self._request_with_retry(
                "GET",
                f"/api/usage?since={quote(date_range['since'], safe='')}"
                f"&until={quote(date_range['until'], safe='')}",
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 4: get_proxy_config
    # ==================================================================

    def get_proxy_config(self) -> str:
        """Get proxy configuration information.

        Returns:
            JSON string with proxy configuration (endpoints, geo-targeting options).
        """
        try:
            result = self._request_with_retry("GET", "/api/proxy/config")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 5: list_sessions
    # ==================================================================

    def list_sessions(self) -> str:
        """List active proxy sessions.

        Returns:
            JSON string with active session information.
        """
        try:
            result = self._request_with_retry("GET", "/api/sessions/active")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 6: create_agentic_wallet
    # ==================================================================

    def create_agentic_wallet(
        self,
        label: str,
        spending_limit_cents: int,
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[list] = None,
    ) -> str:
        """Create a new agentic sub-wallet with a spending limit.

        Args:
            label: Human-readable label for the wallet (max 100 chars).
            spending_limit_cents: Per-transaction spending limit in cents.
            daily_limit_cents: Optional daily budget cap in cents (1 to 1,000,000).
            allowed_domains: Optional list of allowed domains (max 100, each <= 253 chars).

        Returns:
            JSON string with the created wallet details.
        """
        err = _validate_label(label, "label")
        if err:
            return json.dumps({"error": err})

        err = _validate_positive_int(spending_limit_cents, "spending_limit_cents")
        if err:
            return json.dumps({"error": err})

        if daily_limit_cents is not None:
            err = _validate_positive_int(
                daily_limit_cents, "daily_limit_cents", max_value=1_000_000
            )
            if err:
                return json.dumps({"error": err})

        if allowed_domains is not None:
            err = _validate_domains(allowed_domains)
            if err:
                return json.dumps({"error": err})

        try:
            body: Dict[str, Any] = {
                "label": label,
                "spendingLimitCents": spending_limit_cents,
            }
            if daily_limit_cents is not None:
                body["dailyLimitCents"] = daily_limit_cents
            if allowed_domains is not None:
                body["allowedDomains"] = allowed_domains
            result = self._request_with_retry("POST", "/api/agent-wallet", body)
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 7: fund_agentic_wallet
    # ==================================================================

    def fund_agentic_wallet(self, wallet_id: str, amount_cents: int) -> str:
        """Fund an agentic wallet from the main wallet.

        Args:
            wallet_id: ID of the agentic wallet to fund.
            amount_cents: Amount to transfer in cents.

        Returns:
            JSON string with the updated wallet details.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return json.dumps({"error": "wallet_id is required and must be a string"})

        err = _validate_positive_int(amount_cents, "amount_cents")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "POST",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/fund",
                {"amountCents": amount_cents},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 8: agentic_wallet_balance
    # ==================================================================

    def agentic_wallet_balance(self, wallet_id: str) -> str:
        """Check the balance of an agentic wallet.

        Args:
            wallet_id: ID of the agentic wallet.

        Returns:
            JSON string with wallet balance details.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return json.dumps({"error": "wallet_id is required and must be a string"})

        try:
            result = self._request_with_retry(
                "GET",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}",
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 9: list_agentic_wallets
    # ==================================================================

    def list_agentic_wallets(self) -> str:
        """List all agentic wallets.

        Returns:
            JSON string with a list of all agentic wallets.
        """
        try:
            result = self._request_with_retry("GET", "/api/agent-wallet")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 10: agentic_transactions
    # ==================================================================

    def agentic_transactions(self, wallet_id: str, limit: int = 20) -> str:
        """Get transaction history for an agentic wallet.

        Args:
            wallet_id: ID of the agentic wallet.
            limit: Maximum number of transactions to return (1-100, default 20).

        Returns:
            JSON string with transaction history.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return json.dumps({"error": "wallet_id is required and must be a string"})

        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
            return json.dumps(
                {"error": "limit must be an integer between 1 and 100"}
            )

        qs = f"?limit={limit}" if limit != 20 else ""

        try:
            result = self._request_with_retry(
                "GET",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/transactions{qs}",
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 11: freeze_agentic_wallet
    # ==================================================================

    def freeze_agentic_wallet(self, wallet_id: str) -> str:
        """Freeze an agentic wallet (prevent spending).

        Args:
            wallet_id: ID of the agentic wallet to freeze.

        Returns:
            JSON string confirming the wallet is frozen.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return json.dumps({"error": "wallet_id is required and must be a string"})

        try:
            result = self._request_with_retry(
                "POST",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/freeze",
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 12: unfreeze_agentic_wallet
    # ==================================================================

    def unfreeze_agentic_wallet(self, wallet_id: str) -> str:
        """Unfreeze an agentic wallet (re-enable spending).

        Args:
            wallet_id: ID of the agentic wallet to unfreeze.

        Returns:
            JSON string confirming the wallet is unfrozen.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return json.dumps({"error": "wallet_id is required and must be a string"})

        try:
            result = self._request_with_retry(
                "POST",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/unfreeze",
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 13: delete_agentic_wallet
    # ==================================================================

    def delete_agentic_wallet(self, wallet_id: str) -> str:
        """Delete an agentic wallet (must be unfrozen first; refunds balance).

        Args:
            wallet_id: ID of the agentic wallet to delete.

        Returns:
            JSON string confirming deletion.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return json.dumps({"error": "wallet_id is required and must be a string"})

        try:
            result = self._request_with_retry(
                "DELETE",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}",
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 14: create_team
    # ==================================================================

    def create_team(self, name: str, max_members: int | None = None) -> str:
        """Create a new team with a shared wallet.

        Args:
            name: Team name (max 100 chars).
            max_members: Optional maximum number of team members (1-100).

        Returns:
            JSON string with the created team details.
        """
        err = _validate_label(name, "name")
        if err:
            return json.dumps({"error": err})

        body: Dict[str, Any] = {"name": name}

        if max_members is not None:
            err = _validate_positive_int(max_members, "max_members", max_value=100)
            if err:
                return json.dumps({"error": err})
            body["maxMembers"] = max_members

        try:
            result = self._request_with_retry("POST", "/api/teams", body)
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 15: list_teams
    # ==================================================================

    def list_teams(self) -> str:
        """List all teams the user belongs to.

        Returns:
            JSON string with a list of teams.
        """
        try:
            result = self._request_with_retry("GET", "/api/teams")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 16: team_details
    # ==================================================================

    def team_details(self, team_id: str) -> str:
        """Get details for a specific team.

        Args:
            team_id: UUID of the team.

        Returns:
            JSON string with team details.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "GET", f"/api/teams/{quote(team_id, safe='')}"
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 17: team_fund
    # ==================================================================

    def team_fund(self, team_id: str, amount_cents: int) -> str:
        """Fund a team's shared wallet from the user's personal wallet.

        Args:
            team_id: UUID of the team.
            amount_cents: Amount to transfer in cents (100 to 1,000,000).

        Returns:
            JSON string with the updated team wallet details.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        err = _validate_positive_int(
            amount_cents, "amount_cents", min_value=100, max_value=1_000_000
        )
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "POST",
                f"/api/teams/{quote(team_id, safe='')}/wallet/fund",
                {"amountCents": amount_cents},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 18: team_create_key
    # ==================================================================

    def team_create_key(self, team_id: str, label: str) -> str:
        """Create a new API key for a team.

        Args:
            team_id: UUID of the team.
            label: Human-readable label for the key (max 100 chars).

        Returns:
            JSON string with the created API key (shown once).
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        err = _validate_label(label, "label")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "POST",
                f"/api/teams/{quote(team_id, safe='')}/keys",
                {"label": label},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 19: team_usage
    # ==================================================================

    def team_usage(self, team_id: str, limit: int = 20) -> str:
        """Get usage/transaction history for a team.

        Args:
            team_id: UUID of the team.
            limit: Maximum number of records to return (1-100, default 20).

        Returns:
            JSON string with team usage/transaction history.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
            return json.dumps(
                {"error": "limit must be an integer between 1 and 100"}
            )

        qs = f"?limit={limit}" if limit != 20 else ""

        try:
            result = self._request_with_retry(
                "GET",
                f"/api/teams/{quote(team_id, safe='')}/wallet/transactions{qs}",
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 20: update_team
    # ==================================================================

    def update_team(
        self,
        team_id: str,
        name: str | None = None,
        max_members: int | None = None,
    ) -> str:
        """Update team settings (name and/or max_members).

        Args:
            team_id: UUID of the team.
            name: New team name (max 100 chars, optional).
            max_members: New max member count (1-100, optional).

        Returns:
            JSON string with the updated team details.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        body: Dict[str, Any] = {}

        if name is not None:
            err = _validate_label(name, "name")
            if err:
                return json.dumps({"error": err})
            body["name"] = name

        if max_members is not None:
            err = _validate_positive_int(max_members, "max_members", max_value=100)
            if err:
                return json.dumps({"error": err})
            body["maxMembers"] = max_members

        if not body:
            return json.dumps(
                {"error": "At least one of name or max_members must be provided"}
            )

        try:
            result = self._request_with_retry(
                "PATCH",
                f"/api/teams/{quote(team_id, safe='')}",
                body,
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 21: update_team_member_role
    # ==================================================================

    def update_team_member_role(
        self, team_id: str, user_id: str, role: str
    ) -> str:
        """Update the role of a team member.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the user whose role to change.
            role: New role (``member`` or ``admin``).

        Returns:
            JSON string confirming the role update.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        err = _validate_uuid(user_id, "user_id")
        if err:
            return json.dumps({"error": err})

        if not role or not isinstance(role, str):
            return json.dumps({"error": "role is required and must be a string"})
        if role not in ("member", "admin"):
            return json.dumps({"error": "role must be 'member' or 'admin'"})

        try:
            result = self._request_with_retry(
                "PATCH",
                f"/api/teams/{quote(team_id, safe='')}/members/{quote(user_id, safe='')}",
                {"role": role},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 22: x402_info
    # ==================================================================

    def x402_info(self) -> str:
        """Get x402 micropayment protocol information.

        Returns details about x402 HTTP 402 Payment Required protocol support
        including facilitators, pricing, supported currencies, and payment
        options for AI agent micropayments.

        Returns:
            JSON string with x402 protocol information.
        """
        try:
            result = self._request_with_retry("GET", "/api/x402/info")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 23: topup_paypal
    # ==================================================================

    def topup_paypal(self, amount_cents: int) -> str:
        """Create a PayPal top-up order for the user's wallet.

        Args:
            amount_cents: Amount to top up in cents (500 to 1,000,000).
                Minimum $5.00 (500 cents).

        Returns:
            JSON string with ``orderId`` and ``approvalUrl`` for completing
            the PayPal payment flow.
        """
        err = _validate_positive_int(
            amount_cents, "amount_cents", min_value=500, max_value=1_000_000
        )
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "POST",
                "/api/wallet/topup/paypal",
                {"amountCents": amount_cents},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 24: topup_stripe
    # ==================================================================

    def topup_stripe(self, amount_cents: int) -> str:
        """Create a Stripe checkout session to top up the user's wallet.

        Args:
            amount_cents: Amount to top up in cents (500 to 100,000).
                Minimum $5.00 (500 cents), maximum $1,000 (100,000 cents).

        Returns:
            JSON string with ``sessionId`` and ``checkoutUrl`` for completing
            the Stripe payment flow.
        """
        err = _validate_positive_int(
            amount_cents, "amount_cents", min_value=500, max_value=100_000
        )
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "POST",
                "/api/wallet/topup/stripe",
                {"amountCents": amount_cents},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 25: topup_crypto
    # ==================================================================

    _VALID_CRYPTO_CURRENCIES = {
        "btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb", "link",
    }

    def topup_crypto(self, amount_usd: float, currency: str) -> str:
        """Create a crypto payment invoice to top up the user's wallet.

        Args:
            amount_usd: Amount in USD (5 to 1,000).
            currency: Cryptocurrency to pay with (btc, eth, ltc, xmr, zec,
                usdc, sol, usdt, dai, bnb, link).

        Returns:
            JSON string with invoice details including payment address and amount.
        """
        if isinstance(amount_usd, bool):
            return json.dumps({"error": "amount_usd must be a number between 5 and 1,000"})
        if not isinstance(amount_usd, (int, float)) or not math.isfinite(amount_usd):
            return json.dumps({"error": "amount_usd must be a number between 5 and 1,000"})
        if amount_usd < 5 or amount_usd > 1000:
            return json.dumps({"error": "amount_usd must be a number between 5 and 1,000"})

        cur = str(currency).lower()
        if cur not in self._VALID_CRYPTO_CURRENCIES:
            return json.dumps({
                "error": f"currency must be one of: {', '.join(sorted(self._VALID_CRYPTO_CURRENCIES))}"
            })

        try:
            result = self._request_with_retry(
                "POST",
                "/api/wallet/topup/crypto",
                {"amountUsd": amount_usd, "currency": cur},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Tool 26: update_wallet_policy
    # ==================================================================

    def update_wallet_policy(
        self,
        wallet_id: str,
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[list] = None,
    ) -> str:
        """Update the policy of an agentic wallet.

        Args:
            wallet_id: ID of the agentic wallet.
            daily_limit_cents: Optional daily budget cap in cents (1 to 1,000,000).
            allowed_domains: Optional list of allowed domains (max 100, each <= 253 chars).

        Returns:
            JSON string with the updated wallet policy.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return json.dumps({"error": "wallet_id is required and must be a string"})

        if daily_limit_cents is None and allowed_domains is None:
            return json.dumps({"error": "At least one of daily_limit_cents or allowed_domains is required"})

        if daily_limit_cents is not None:
            err = _validate_positive_int(
                daily_limit_cents, "daily_limit_cents", max_value=1_000_000
            )
            if err:
                return json.dumps({"error": err})

        if allowed_domains is not None:
            err = _validate_domains(allowed_domains)
            if err:
                return json.dumps({"error": err})

        try:
            body: Dict[str, Any] = {}
            if daily_limit_cents is not None:
                body["dailyLimitCents"] = daily_limit_cents
            if allowed_domains is not None:
                body["allowedDomains"] = allowed_domains
            result = self._request_with_retry(
                "PATCH",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/policy",
                body,
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # get_tools -- Langflow-compatible tool list
    # ==================================================================

    def get_tools(self) -> List[StructuredTool]:
        """Return Langflow-compatible StructuredTool objects.

        Returns a list of 26 LangChain StructuredTool instances that can be
        used directly in Langflow visual pipelines or with any LangChain agent.

        Returns:
            List of 26 StructuredTool objects.
        """
        return [
            StructuredTool.from_function(
                func=self.proxied_fetch,
                name="dominusnode_proxied_fetch",
                description=(
                    "Fetch a URL through Dominus Node's rotating proxy network. "
                    "Supports geo-targeting by country and datacenter or residential proxy types. "
                    "Only GET, HEAD, and OPTIONS methods are allowed."
                ),
                args_schema=ProxiedFetchInput,
            ),
            StructuredTool.from_function(
                func=self.check_balance,
                name="dominusnode_check_balance",
                description="Check the current Dominus Node wallet balance in cents.",
                args_schema=EmptyInput,
            ),
            StructuredTool.from_function(
                func=self.check_usage,
                name="dominusnode_check_usage",
                description=(
                    "Check Dominus Node proxy usage statistics for a given period "
                    "(day, week, or month)."
                ),
                args_schema=CheckUsageInput,
            ),
            StructuredTool.from_function(
                func=self.get_proxy_config,
                name="dominusnode_get_proxy_config",
                description=(
                    "Get Dominus Node proxy configuration including endpoints "
                    "and geo-targeting options."
                ),
                args_schema=EmptyInput,
            ),
            StructuredTool.from_function(
                func=self.list_sessions,
                name="dominusnode_list_sessions",
                description="List active Dominus Node proxy sessions.",
                args_schema=EmptyInput,
            ),
            StructuredTool.from_function(
                func=self.create_agentic_wallet,
                name="dominusnode_create_agentic_wallet",
                description=(
                    "Create a new agentic sub-wallet with a per-transaction "
                    "spending limit. Used for AI agent budget isolation."
                ),
                args_schema=CreateAgenticWalletInput,
            ),
            StructuredTool.from_function(
                func=self.fund_agentic_wallet,
                name="dominusnode_fund_agentic_wallet",
                description="Fund an agentic wallet from the main wallet.",
                args_schema=FundAgenticWalletInput,
            ),
            StructuredTool.from_function(
                func=self.agentic_wallet_balance,
                name="dominusnode_agentic_wallet_balance",
                description="Check the balance of a specific agentic wallet.",
                args_schema=AgenticWalletBalanceInput,
            ),
            StructuredTool.from_function(
                func=self.list_agentic_wallets,
                name="dominusnode_list_agentic_wallets",
                description="List all agentic wallets owned by the user.",
                args_schema=EmptyInput,
            ),
            StructuredTool.from_function(
                func=self.agentic_transactions,
                name="dominusnode_agentic_transactions",
                description="Get transaction history for a specific agentic wallet.",
                args_schema=AgenticTransactionsInput,
            ),
            StructuredTool.from_function(
                func=self.freeze_agentic_wallet,
                name="dominusnode_freeze_agentic_wallet",
                description="Freeze an agentic wallet to prevent spending.",
                args_schema=FreezeAgenticWalletInput,
            ),
            StructuredTool.from_function(
                func=self.unfreeze_agentic_wallet,
                name="dominusnode_unfreeze_agentic_wallet",
                description="Unfreeze a frozen agentic wallet to re-enable spending.",
                args_schema=UnfreezeAgenticWalletInput,
            ),
            StructuredTool.from_function(
                func=self.delete_agentic_wallet,
                name="dominusnode_delete_agentic_wallet",
                description=(
                    "Delete an agentic wallet (must be unfrozen first). "
                    "Remaining balance is refunded to the main wallet."
                ),
                args_schema=DeleteAgenticWalletInput,
            ),
            StructuredTool.from_function(
                func=self.create_team,
                name="dominusnode_create_team",
                description="Create a new team with a shared wallet for collaborative proxy usage.",
                args_schema=CreateTeamInput,
            ),
            StructuredTool.from_function(
                func=self.list_teams,
                name="dominusnode_list_teams",
                description="List all teams the user belongs to.",
                args_schema=EmptyInput,
            ),
            StructuredTool.from_function(
                func=self.team_details,
                name="dominusnode_team_details",
                description="Get details for a specific team including members and wallet info.",
                args_schema=TeamDetailsInput,
            ),
            StructuredTool.from_function(
                func=self.team_fund,
                name="dominusnode_team_fund",
                description="Fund a team's shared wallet from the user's personal wallet.",
                args_schema=TeamFundInput,
            ),
            StructuredTool.from_function(
                func=self.team_create_key,
                name="dominusnode_team_create_key",
                description="Create a new API key for a team (shown once).",
                args_schema=TeamCreateKeyInput,
            ),
            StructuredTool.from_function(
                func=self.team_usage,
                name="dominusnode_team_usage",
                description="Get usage and transaction history for a team.",
                args_schema=TeamUsageInput,
            ),
            StructuredTool.from_function(
                func=self.update_team,
                name="dominusnode_update_team",
                description="Update team settings such as name and maximum member count.",
                args_schema=UpdateTeamInput,
            ),
            StructuredTool.from_function(
                func=self.update_team_member_role,
                name="dominusnode_update_team_member_role",
                description="Update a team member's role to 'member' or 'admin'.",
                args_schema=UpdateTeamMemberRoleInput,
            ),
            StructuredTool.from_function(
                func=self.x402_info,
                name="dominusnode_x402_info",
                description=(
                    "Get x402 micropayment protocol information including supported "
                    "facilitators, pricing, and payment options for AI agent micropayments."
                ),
                args_schema=EmptyInput,
            ),
            StructuredTool.from_function(
                func=self.topup_paypal,
                name="dominusnode_topup_paypal",
                description=(
                    "Create a PayPal wallet top-up order. "
                    "Returns an approval URL for completing the payment. "
                    "Minimum $5.00 (500 cents)."
                ),
                args_schema=TopupPaypalInput,
            ),
            StructuredTool.from_function(
                func=self.topup_stripe,
                name="dominusnode_topup_stripe",
                description=(
                    "Create a Stripe checkout session to top up your wallet. "
                    "Returns a checkout URL for completing the payment. "
                    "Minimum $5 (500 cents), maximum $1,000 (100,000 cents)."
                ),
                args_schema=TopupStripeInput,
            ),
            StructuredTool.from_function(
                func=self.topup_crypto,
                name="dominusnode_topup_crypto",
                description=(
                    "Create a crypto payment invoice to top up your wallet. "
                    "Supports BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK. "
                    "Minimum $5, maximum $1,000."
                ),
                args_schema=TopupCryptoInput,
            ),
            StructuredTool.from_function(
                func=self.update_wallet_policy,
                name="dominusnode_update_wallet_policy",
                description=(
                    "Update the policy of an agentic wallet. "
                    "Set daily budget caps and allowed domain restrictions."
                ),
                args_schema=UpdateWalletPolicyInput,
            ),
        ]
