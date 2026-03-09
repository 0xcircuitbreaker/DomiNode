"""Dominus Node PydanticAI toolkit -- 53 proxy, wallet, team, and payment tools.

Provides a PydanticAI-compatible toolkit class that exposes 53 tool functions
for interacting with the Dominus Node rotating proxy-as-a-service platform.

Tools cover:
  - Proxied HTTP fetching through rotating proxies (3 tools)
  - Wallet balance, transactions, forecast, and top-ups (8 tools)
  - Usage monitoring and analytics (3 tools)
  - Account lifecycle: register, login, verify, password (6 tools)
  - API key management (3 tools)
  - Subscription plan management (3 tools)
  - Agentic wallet management (9 tools)
  - Team management (17 tools)
  - x402 micropayment protocol information (1 tool)

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

    from dominusnode_pydanticai import DominusNodeToolkit

    toolkit = DominusNodeToolkit(api_key="dn_live_...")
    tools = toolkit.get_tools()

    # Register tools with a PydanticAI agent
    from pydantic_ai import Agent
    agent = Agent('openai:gpt-4o', tools=tools)

Requires: httpx (``pip install httpx``), pydantic (``pip install pydantic``)
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import os
import re
import socket
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Set
from urllib.parse import quote, urlparse

import httpx

__version__ = "1.0.0"
__all__ = ["DominusNodeToolkit"]

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

_CREDENTIAL_RE = re.compile(r"dn_(live|test|proxy)_[a-zA-Z0-9]+")


def _sanitize_error(message: str) -> str:
    """Remove Dominus Node API key patterns from error messages."""
    return _CREDENTIAL_RE.sub("***", message)


def _count_leading_zero_bits(data: bytes) -> int:
    """Count leading zero bits in a byte array."""
    count = 0
    for byte in data:
        if byte == 0:
            count += 8
        else:
            mask = 0x80
            while mask and not (byte & mask):
                count += 1
                mask >>= 1
            break
    return count


def _solve_pow(base_url: str) -> Optional[dict]:
    """Solve a Proof-of-Work challenge for CAPTCHA-free registration."""
    try:
        pow_url = f"{base_url.rstrip('/')}/api/auth/pow/challenge"
        with httpx.Client(timeout=30.0, follow_redirects=False) as client:
            resp = client.post(pow_url, headers={"Content-Type": "application/json"})
            if resp.status_code >= 400:
                return None
            challenge = resp.json()
        prefix = challenge.get("prefix", "")
        difficulty = challenge.get("difficulty", 20)
        challenge_id = challenge.get("challengeId", "")
        if not prefix or not challenge_id:
            return None
        nonce = 0
        while nonce < 100_000_000:
            h = hashlib.sha256((prefix + str(nonce)).encode()).digest()
            if _count_leading_zero_bits(h) >= difficulty:
                return {"challengeId": challenge_id, "nonce": str(nonce)}
            nonce += 1
        return None
    except Exception:
        return None


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


_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

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


def _validate_email(email: Any) -> Optional[str]:
    """Validate an email address, returning an error message or None."""
    if not email or not isinstance(email, str):
        return "email is required and must be a string"
    trimmed = email.strip()
    if not trimmed or not _EMAIL_RE.match(trimmed):
        return "Invalid email address"
    if len(trimmed) > 254:
        return "Email address too long (max 254 characters)"
    return None


def _validate_password(password: Any, field_name: str = "password") -> Optional[str]:
    """Validate a password string, returning an error message or None."""
    if not password or not isinstance(password, str):
        return f"{field_name} is required and must be a string"
    if len(password) < 8:
        return f"{field_name} must be at least 8 characters"
    if len(password) > 128:
        return f"{field_name} must be 128 characters or fewer"
    return None


def _validate_token(token: Any, field_name: str = "token") -> Optional[str]:
    """Validate a token string, returning an error message or None."""
    if not token or not isinstance(token, str):
        return f"{field_name} is required and must be a string"
    if not token.strip():
        return f"{field_name} is required and must be a non-empty string"
    if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in token):
        return f"{field_name} contains invalid control characters"
    return None


# ===========================================================================
# DominusNodeToolkit -- main toolkit class
# ===========================================================================


class DominusNodeToolkit:
    """PydanticAI toolkit providing Dominus Node rotating proxy tools.

    Authenticates using a Dominus Node API key and exposes 53 tool functions for
    proxy, wallet, usage, account, API keys, plans, agentic wallets, teams,
    and payment management. Use ``get_tools()`` to retrieve a list of plain
    callable functions suitable for registration with a PydanticAI agent.

    Args:
        api_key: Dominus Node API key (``dn_live_...`` or ``dn_test_...``).
            Falls back to ``DOMINUSNODE_API_KEY`` environment variable.
        base_url: Base URL of the Dominus Node REST API.
        proxy_host: Hostname of the Dominus Node proxy gateway.
        proxy_port: Port of the Dominus Node proxy gateway.
        timeout: HTTP request timeout in seconds.

    Example::

        from dominusnode_pydanticai import DominusNodeToolkit
        from pydantic_ai import Agent

        toolkit = DominusNodeToolkit(api_key="dn_live_abc123")
        agent = Agent('openai:gpt-4o', tools=toolkit.get_tools())
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

        auth_headers = {
            "User-Agent": "dominusnode-pydanticai/1.0.0",
            "Content-Type": "application/json",
        }
        if self.agent_secret:
            auth_headers["X-DominusNode-Agent"] = "mcp"
            auth_headers["X-DominusNode-Agent-Secret"] = self.agent_secret

        with httpx.Client(
            timeout=self.timeout,
            follow_redirects=False,
        ) as client:
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
            req_headers = {
                "User-Agent": "dominusnode-pydanticai/1.0.0",
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

    # ------------------------------------------------------------------
    # Unauthenticated request helper
    # ------------------------------------------------------------------

    def _raw_request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Make an unauthenticated API request (for register, login, verify-email).

        Args:
            method: HTTP method (GET, POST, etc.).
            path: API path (e.g., ``/api/auth/register``).
            body: Optional JSON body.

        Returns:
            Parsed JSON response (with dangerous keys stripped).

        Raises:
            RuntimeError: On API errors or oversized responses.
        """
        with httpx.Client(
            timeout=self.timeout,
            follow_redirects=False,
        ) as client:
            req_headers = {
                "User-Agent": "dominusnode-pydanticai/1.0.0",
                "Content-Type": "application/json",
            }
            if self.agent_secret:
                req_headers["X-DominusNode-Agent"] = "mcp"
                req_headers["X-DominusNode-Agent-Secret"] = self.agent_secret

            kwargs: Dict[str, Any] = {"headers": req_headers}
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

    # ==================================================================
    # Tool 1: proxied_fetch
    # ==================================================================

    def proxied_fetch(
        self,
        url: str,
        method: str = "GET",
        country: str | None = None,
        proxy_type: str = "dc",
    ) -> dict:
        """Fetch a URL through the Dominus Node rotating proxy network.

        Args:
            url: Target URL to fetch.
            method: HTTP method (GET, HEAD, or OPTIONS only).
            country: Optional ISO 3166-1 alpha-2 country code for geo-targeting.
            proxy_type: Proxy type: ``dc`` (datacenter, $3/GB) or
                ``residential`` ($5/GB). Default: ``dc``.

        Returns:
            Dict with status, headers, and body (truncated to 4000 chars).
        """
        # Validate URL for SSRF
        try:
            validate_url(url)
        except ValueError as e:
            return {"error": str(e)}

        # OFAC country check
        if country:
            upper = country.upper()
            if upper in SANCTIONED_COUNTRIES:
                return {"error": f"Country '{upper}' is blocked (OFAC sanctioned country)"}

        # Restrict HTTP methods
        method_upper = (method or "GET").upper()
        if method_upper not in _ALLOWED_FETCH_METHODS:
            return {
                "error": (
                    f"HTTP method '{method_upper}' is not allowed. "
                    "Only GET, HEAD, OPTIONS are permitted."
                )
            }

        # Validate proxy_type
        if proxy_type not in ("dc", "residential", "auto"):
            return {"error": "proxy_type must be 'dc', 'residential', or 'auto'"}

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
                    return {"error": "Response body too large (>10 MB)"}

                body = resp.text[:MAX_RESPONSE_CHARS]
                resp_headers = dict(resp.headers)
                # Scrub sensitive response headers
                for h in ("set-cookie", "www-authenticate", "proxy-authenticate"):
                    resp_headers.pop(h, None)

                return {
                    "status": resp.status_code,
                    "headers": resp_headers,
                    "body": body,
                }
        except Exception as e:
            return {
                "error": f"Proxy fetch failed: {_sanitize_error(str(e))}",
                "hint": "Ensure the Dominus Node proxy gateway is running and accessible.",
            }

    # ==================================================================
    # Tool 2: check_balance
    # ==================================================================

    def check_balance(self) -> dict:
        """Check the current wallet balance.

        Returns:
            Dict with wallet balance information.
        """
        try:
            return self._request_with_retry("GET", "/api/wallet")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 3: check_usage
    # ==================================================================

    def check_usage(self, period: str = "month") -> dict:
        """Check proxy usage statistics.

        Args:
            period: Time period -- ``day``, ``week``, or ``month`` (default).

        Returns:
            Dict with usage statistics.
        """
        if period not in ("day", "week", "month"):
            return {"error": "period must be 'day', 'week', or 'month'"}
        try:
            date_range = _period_to_date_range(period)
            return self._request_with_retry(
                "GET",
                f"/api/usage?since={quote(date_range['since'], safe='')}"
                f"&until={quote(date_range['until'], safe='')}",
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 4: get_proxy_config
    # ==================================================================

    def get_proxy_config(self) -> dict:
        """Get proxy configuration information.

        Returns:
            Dict with proxy configuration (endpoints, geo-targeting options).
        """
        try:
            return self._request_with_retry("GET", "/api/proxy/config")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 5: list_sessions
    # ==================================================================

    def list_sessions(self) -> dict:
        """List active proxy sessions.

        Returns:
            Dict with active session information.
        """
        try:
            return self._request_with_retry("GET", "/api/sessions/active")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 6: create_agentic_wallet
    # ==================================================================

    def create_agentic_wallet(
        self,
        label: str,
        spending_limit_cents: int,
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[list] = None,
    ) -> dict:
        """Create a new agentic sub-wallet with a spending limit.

        Args:
            label: Human-readable label for the wallet (max 100 chars).
            spending_limit_cents: Per-transaction spending limit in cents.
            daily_limit_cents: Optional daily budget cap in cents (1 to 1,000,000).
            allowed_domains: Optional list of allowed domains (max 100, each <= 253 chars).

        Returns:
            Dict with the created wallet details.
        """
        err = _validate_label(label, "label")
        if err:
            return {"error": err}

        err = _validate_positive_int(spending_limit_cents, "spending_limit_cents")
        if err:
            return {"error": err}

        if daily_limit_cents is not None:
            err = _validate_positive_int(
                daily_limit_cents, "daily_limit_cents", max_value=1_000_000
            )
            if err:
                return {"error": err}

        if allowed_domains is not None:
            err = _validate_domains(allowed_domains)
            if err:
                return {"error": err}

        try:
            body: Dict[str, Any] = {
                "label": label,
                "spendingLimitCents": spending_limit_cents,
            }
            if daily_limit_cents is not None:
                body["dailyLimitCents"] = daily_limit_cents
            if allowed_domains is not None:
                body["allowedDomains"] = allowed_domains
            return self._request_with_retry("POST", "/api/agent-wallet", body)
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 7: fund_agentic_wallet
    # ==================================================================

    def fund_agentic_wallet(self, wallet_id: str, amount_cents: int) -> dict:
        """Fund an agentic wallet from the main wallet.

        Args:
            wallet_id: ID of the agentic wallet to fund.
            amount_cents: Amount to transfer in cents.

        Returns:
            Dict with the updated wallet details.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        err = _validate_positive_int(amount_cents, "amount_cents")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "POST",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/fund",
                {"amountCents": amount_cents},
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 8: agentic_wallet_balance
    # ==================================================================

    def agentic_wallet_balance(self, wallet_id: str) -> dict:
        """Check the balance of an agentic wallet.

        Args:
            wallet_id: ID of the agentic wallet.

        Returns:
            Dict with wallet balance details.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        try:
            return self._request_with_retry(
                "GET",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}",
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 9: list_agentic_wallets
    # ==================================================================

    def list_agentic_wallets(self) -> dict:
        """List all agentic wallets.

        Returns:
            Dict with a list of all agentic wallets.
        """
        try:
            return self._request_with_retry("GET", "/api/agent-wallet")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 10: agentic_transactions
    # ==================================================================

    def agentic_transactions(self, wallet_id: str, limit: int = 20) -> dict:
        """Get transaction history for an agentic wallet.

        Args:
            wallet_id: ID of the agentic wallet.
            limit: Maximum number of transactions to return (1-100, default 20).

        Returns:
            Dict with transaction history.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
            return {"error": "limit must be an integer between 1 and 100"}

        qs = f"?limit={limit}" if limit != 20 else ""

        try:
            return self._request_with_retry(
                "GET",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/transactions{qs}",
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 11: freeze_agentic_wallet
    # ==================================================================

    def freeze_agentic_wallet(self, wallet_id: str) -> dict:
        """Freeze an agentic wallet (prevent spending).

        Args:
            wallet_id: ID of the agentic wallet to freeze.

        Returns:
            Dict confirming the wallet is frozen.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        try:
            return self._request_with_retry(
                "POST",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/freeze",
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 12: unfreeze_agentic_wallet
    # ==================================================================

    def unfreeze_agentic_wallet(self, wallet_id: str) -> dict:
        """Unfreeze an agentic wallet (re-enable spending).

        Args:
            wallet_id: ID of the agentic wallet to unfreeze.

        Returns:
            Dict confirming the wallet is unfrozen.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        try:
            return self._request_with_retry(
                "POST",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/unfreeze",
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 13: delete_agentic_wallet
    # ==================================================================

    def delete_agentic_wallet(self, wallet_id: str) -> dict:
        """Delete an agentic wallet (must be unfrozen first; refunds balance).

        Args:
            wallet_id: ID of the agentic wallet to delete.

        Returns:
            Dict confirming deletion.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        try:
            return self._request_with_retry(
                "DELETE",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}",
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 14: create_team
    # ==================================================================

    def create_team(self, name: str, max_members: int | None = None) -> dict:
        """Create a new team with a shared wallet.

        Args:
            name: Team name (max 100 chars).
            max_members: Optional maximum number of team members (1-100).

        Returns:
            Dict with the created team details.
        """
        err = _validate_label(name, "name")
        if err:
            return {"error": err}

        body: Dict[str, Any] = {"name": name}

        if max_members is not None:
            err = _validate_positive_int(max_members, "max_members", max_value=100)
            if err:
                return {"error": err}
            body["maxMembers"] = max_members

        try:
            return self._request_with_retry("POST", "/api/teams", body)
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 15: list_teams
    # ==================================================================

    def list_teams(self) -> dict:
        """List all teams the user belongs to.

        Returns:
            Dict with a list of teams.
        """
        try:
            return self._request_with_retry("GET", "/api/teams")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 16: team_details
    # ==================================================================

    def team_details(self, team_id: str) -> dict:
        """Get details for a specific team.

        Args:
            team_id: UUID of the team.

        Returns:
            Dict with team details.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "GET", f"/api/teams/{quote(team_id, safe='')}"
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 17: team_fund
    # ==================================================================

    def team_fund(self, team_id: str, amount_cents: int) -> dict:
        """Fund a team's shared wallet from the user's personal wallet.

        Args:
            team_id: UUID of the team.
            amount_cents: Amount to transfer in cents (100 to 1,000,000).

        Returns:
            Dict with the updated team wallet details.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        err = _validate_positive_int(
            amount_cents, "amount_cents", min_value=100, max_value=1_000_000
        )
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "POST",
                f"/api/teams/{quote(team_id, safe='')}/wallet/fund",
                {"amountCents": amount_cents},
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 18: team_create_key
    # ==================================================================

    def team_create_key(self, team_id: str, label: str) -> dict:
        """Create a new API key for a team.

        Args:
            team_id: UUID of the team.
            label: Human-readable label for the key (max 100 chars).

        Returns:
            Dict with the created API key (shown once).
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        err = _validate_label(label, "label")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "POST",
                f"/api/teams/{quote(team_id, safe='')}/keys",
                {"label": label},
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 19: team_usage
    # ==================================================================

    def team_usage(self, team_id: str, limit: int = 20) -> dict:
        """Get usage/transaction history for a team.

        Args:
            team_id: UUID of the team.
            limit: Maximum number of records to return (1-100, default 20).

        Returns:
            Dict with team usage/transaction history.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
            return {"error": "limit must be an integer between 1 and 100"}

        qs = f"?limit={limit}" if limit != 20 else ""

        try:
            return self._request_with_retry(
                "GET",
                f"/api/teams/{quote(team_id, safe='')}/wallet/transactions{qs}",
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 20: update_team
    # ==================================================================

    def update_team(
        self,
        team_id: str,
        name: str | None = None,
        max_members: int | None = None,
    ) -> dict:
        """Update team settings (name and/or max_members).

        Args:
            team_id: UUID of the team.
            name: New team name (max 100 chars, optional).
            max_members: New max member count (1-100, optional).

        Returns:
            Dict with the updated team details.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        body: Dict[str, Any] = {}

        if name is not None:
            err = _validate_label(name, "name")
            if err:
                return {"error": err}
            body["name"] = name

        if max_members is not None:
            err = _validate_positive_int(max_members, "max_members", max_value=100)
            if err:
                return {"error": err}
            body["maxMembers"] = max_members

        if not body:
            return {"error": "At least one of name or max_members must be provided"}

        try:
            return self._request_with_retry(
                "PATCH",
                f"/api/teams/{quote(team_id, safe='')}",
                body,
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 21: update_team_member_role
    # ==================================================================

    def update_team_member_role(
        self, team_id: str, user_id: str, role: str
    ) -> dict:
        """Update the role of a team member.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the user whose role to change.
            role: New role (``member`` or ``admin``).

        Returns:
            Dict confirming the role update.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        err = _validate_uuid(user_id, "user_id")
        if err:
            return {"error": err}

        if not role or not isinstance(role, str):
            return {"error": "role is required and must be a string"}
        if role not in ("member", "admin"):
            return {"error": "role must be 'member' or 'admin'"}

        try:
            return self._request_with_retry(
                "PATCH",
                f"/api/teams/{quote(team_id, safe='')}/members/{quote(user_id, safe='')}",
                {"role": role},
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 22: x402_info
    # ==================================================================

    def x402_info(self) -> dict:
        """Get x402 micropayment protocol information.

        Returns details about x402 HTTP 402 Payment Required protocol support
        including facilitators, pricing, supported currencies, and payment
        options for AI agent micropayments.

        Returns:
            Dict with x402 protocol information.
        """
        try:
            return self._request_with_retry("GET", "/api/x402/info")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 23: topup_paypal
    # ==================================================================

    def topup_paypal(self, amount_cents: int) -> dict:
        """Create a PayPal top-up order for the user's wallet.

        Args:
            amount_cents: Amount to top up in cents (500 to 1,000,000).
                Minimum $5.00 (500 cents).

        Returns:
            Dict with ``orderId`` and ``approvalUrl`` for completing
            the PayPal payment flow.
        """
        err = _validate_positive_int(
            amount_cents, "amount_cents", min_value=500, max_value=1_000_000
        )
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "POST",
                "/api/wallet/topup/paypal",
                {"amountCents": amount_cents},
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 24: topup_stripe
    # ==================================================================

    def topup_stripe(self, amount_cents: int) -> dict:
        """Create a Stripe checkout session for wallet top-up.

        Args:
            amount_cents: Amount to top up in cents (500 to 100,000).
                Minimum $5.00 (500 cents), maximum $1,000.

        Returns:
            Dict with ``sessionId`` and ``checkoutUrl`` for completing
            the Stripe payment flow.
        """
        err = _validate_positive_int(
            amount_cents, "amount_cents", min_value=500, max_value=100_000
        )
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "POST",
                "/api/wallet/topup/stripe",
                {"amountCents": amount_cents},
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 25: topup_crypto
    # ==================================================================

    _VALID_CRYPTO_CURRENCIES: Set[str] = {
        "btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai",
        "bnb", "link",
    }

    def topup_crypto(self, amount_usd: float, currency: str) -> dict:
        """Create a crypto invoice for wallet top-up via NOWPayments.

        Args:
            amount_usd: Amount in USD (5 to 1,000).
            currency: Cryptocurrency to pay with.  One of: BTC, ETH, LTC,
                XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK.

        Returns:
            Dict with ``invoiceId`` and ``paymentUrl`` for completing
            the crypto payment.
        """
        if not isinstance(amount_usd, (int, float)) or isinstance(amount_usd, bool):
            return {"error": "amount_usd must be a number between 5 and 1000"}
        if not math.isfinite(amount_usd):
            return {"error": "amount_usd must be a number between 5 and 1000"}
        if amount_usd < 5 or amount_usd > 1000:
            return {"error": "amount_usd must be a number between 5 and 1000"}

        if not isinstance(currency, str) or currency.lower() not in self._VALID_CRYPTO_CURRENCIES:
            return {
                "error": (
                    "currency must be one of: "
                    "BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK"
                )
            }

        try:
            return self._request_with_retry(
                "POST",
                "/api/wallet/topup/crypto",
                {"amountUsd": amount_usd, "currency": currency.lower()},
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 26: update_wallet_policy
    # ==================================================================

    def update_wallet_policy(
        self,
        wallet_id: str,
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[list] = None,
    ) -> dict:
        """Update the policy of an agentic wallet.

        Args:
            wallet_id: ID of the agentic wallet.
            daily_limit_cents: Optional daily budget cap in cents (1 to 1,000,000).
            allowed_domains: Optional list of allowed domains (max 100, each <= 253 chars).

        Returns:
            Dict with the updated wallet policy.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        if daily_limit_cents is None and allowed_domains is None:
            return {"error": "At least one of daily_limit_cents or allowed_domains is required"}

        if daily_limit_cents is not None:
            err = _validate_positive_int(
                daily_limit_cents, "daily_limit_cents", max_value=1_000_000
            )
            if err:
                return {"error": err}

        if allowed_domains is not None:
            err = _validate_domains(allowed_domains)
            if err:
                return {"error": err}

        try:
            body: Dict[str, Any] = {}
            if daily_limit_cents is not None:
                body["dailyLimitCents"] = daily_limit_cents
            if allowed_domains is not None:
                body["allowedDomains"] = allowed_domains
            return self._request_with_retry(
                "PATCH",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/policy",
                body,
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 27: get_proxy_status
    # ==================================================================

    def get_proxy_status(self) -> dict:
        """Get the current status of the proxy gateway.

        Returns status information including uptime, active connections,
        and pool health.

        Returns:
            Dict with proxy gateway status information.
        """
        try:
            return self._request_with_retry("GET", "/api/proxy/status")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 28: get_transactions
    # ==================================================================

    def get_transactions(self, limit: int = 20) -> dict:
        """Get wallet transaction history showing top-ups, charges, and refunds.

        Args:
            limit: Maximum number of transactions to return (1-100, default 20).

        Returns:
            Dict with transaction history.
        """
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
            return {"error": "limit must be an integer between 1 and 100"}

        qs = f"?limit={limit}" if limit != 20 else ""

        try:
            return self._request_with_retry("GET", f"/api/wallet/transactions{qs}")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 29: get_forecast
    # ==================================================================

    def get_forecast(self) -> dict:
        """Get a spending forecast based on recent usage patterns.

        Shows estimated days until balance runs out and projected monthly cost.

        Returns:
            Dict with spending forecast information.
        """
        try:
            return self._request_with_retry("GET", "/api/wallet/forecast")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 30: check_payment
    # ==================================================================

    def check_payment(self, invoice_id: str) -> dict:
        """Check the status of a crypto top-up payment by invoice ID.

        Args:
            invoice_id: Crypto invoice ID (UUID) returned from topup_crypto.

        Returns:
            Dict with payment status (pending, confirming, completed, expired).
        """
        err = _validate_uuid(invoice_id, "invoice_id")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "GET",
                f"/api/wallet/topup/crypto/{quote(invoice_id, safe='')}/status",
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 31: get_daily_usage
    # ==================================================================

    def get_daily_usage(self, days: int = 7) -> dict:
        """Get daily bandwidth usage breakdown.

        Args:
            days: Number of days to look back (1-365, default 7).

        Returns:
            Dict with per-day bytes transferred and cost.
        """
        if not isinstance(days, int) or isinstance(days, bool) or days < 1 or days > 365:
            return {"error": "days must be an integer between 1 and 365"}

        try:
            return self._request_with_retry(
                "GET", f"/api/usage/daily?days={days}"
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 32: get_top_hosts
    # ==================================================================

    def get_top_hosts(self, limit: int = 10) -> dict:
        """Get the top hosts by bandwidth usage.

        Args:
            limit: Number of top hosts to return (1-100, default 10).

        Returns:
            Dict with top hosts and their bandwidth consumption.
        """
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
            return {"error": "limit must be an integer between 1 and 100"}

        try:
            return self._request_with_retry(
                "GET", f"/api/usage/top-hosts?limit={limit}"
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 33: register
    # ==================================================================

    def register(self, email: str, password: str) -> dict:
        """Register a new Dominus Node account.

        Does not require authentication. Returns user info and initial API key.

        Args:
            email: Email address for the new account.
            password: Password (8-128 characters).

        Returns:
            Dict with user info and API key.
        """
        err = _validate_email(email)
        if err:
            return {"error": err}

        err = _validate_password(password)
        if err:
            return {"error": err}

        try:
            body: dict = {"email": email.strip(), "password": password}
            pow_result = _solve_pow(self.base_url)
            if pow_result:
                body["pow"] = pow_result
            result = self._raw_request(
                "POST",
                "/api/auth/register",
                body,
            )
            if pow_result and isinstance(result, dict):
                result["_pow_verified"] = True
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 34: login
    # ==================================================================

    def login(self, email: str, password: str) -> dict:
        """Log in to an existing Dominus Node account.

        Does not require authentication. Returns JWT access and refresh tokens.

        Args:
            email: Account email address.
            password: Account password.

        Returns:
            Dict with access and refresh tokens.
        """
        err = _validate_email(email)
        if err:
            return {"error": err}

        err = _validate_password(password)
        if err:
            return {"error": err}

        try:
            return self._raw_request(
                "POST",
                "/api/auth/login",
                {"email": email.strip(), "password": password},
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 35: get_account_info
    # ==================================================================

    def get_account_info(self) -> dict:
        """Get account profile information.

        Returns email, plan, verification status, and creation date.

        Returns:
            Dict with account profile information.
        """
        try:
            return self._request_with_retry("GET", "/api/auth/me")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 36: verify_email
    # ==================================================================

    def verify_email(self, token: str) -> dict:
        """Verify an email address using a verification token.

        Does not require authentication. Uses the token from the verification
        email sent during registration.

        Args:
            token: Email verification token from the verification email.

        Returns:
            Dict confirming email verification.
        """
        err = _validate_token(token, "token")
        if err:
            return {"error": err}

        try:
            return self._raw_request(
                "POST",
                "/api/auth/verify-email",
                {"token": token.strip()},
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 37: resend_verification
    # ==================================================================

    def resend_verification(self) -> dict:
        """Resend the email verification link.

        Requires authentication.

        Returns:
            Dict confirming the verification email was sent.
        """
        try:
            return self._request_with_retry("POST", "/api/auth/resend-verification")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 38: update_password
    # ==================================================================

    def update_password(self, current_password: str, new_password: str) -> dict:
        """Change the account password.

        Requires current password for verification.

        Args:
            current_password: Current account password.
            new_password: New password (8-128 characters).

        Returns:
            Dict confirming the password change.
        """
        err = _validate_password(current_password, "current_password")
        if err:
            return {"error": err}

        err = _validate_password(new_password, "new_password")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "POST",
                "/api/auth/change-password",
                {"currentPassword": current_password, "newPassword": new_password},
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 39: list_keys
    # ==================================================================

    def list_keys(self) -> dict:
        """List all personal API keys.

        Returns keys with their labels, creation dates, and last-used timestamps.

        Returns:
            Dict with a list of API keys.
        """
        try:
            return self._request_with_retry("GET", "/api/keys")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 40: create_key
    # ==================================================================

    def create_key(self, label: str) -> dict:
        """Create a new personal API key.

        The key is shown only once -- save it immediately.
        Usage is billed against the personal wallet.

        Args:
            label: Label for the API key (1-100 characters).

        Returns:
            Dict with the created API key (shown once).
        """
        err = _validate_label(label, "label")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "POST", "/api/keys", {"label": label}
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 41: revoke_key
    # ==================================================================

    def revoke_key(self, key_id: str) -> dict:
        """Revoke (delete) a personal API key.

        This action is irreversible. Any applications using this key will
        lose access immediately.

        Args:
            key_id: API key ID (UUID) to revoke.

        Returns:
            Dict confirming the key revocation.
        """
        err = _validate_uuid(key_id, "key_id")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "DELETE", f"/api/keys/{quote(key_id, safe='')}"
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 42: get_plan
    # ==================================================================

    def get_plan(self) -> dict:
        """Get the current subscription plan.

        Returns plan tier, bandwidth limits, and pricing.

        Returns:
            Dict with current plan information.
        """
        try:
            return self._request_with_retry("GET", "/api/plans/user/plan")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 43: list_plans
    # ==================================================================

    def list_plans(self) -> dict:
        """List all available subscription plans.

        Returns plans with features, pricing, and bandwidth limits.

        Returns:
            Dict with available plans.
        """
        try:
            return self._request_with_retry("GET", "/api/plans")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 44: change_plan
    # ==================================================================

    def change_plan(self, plan_id: str) -> dict:
        """Change the subscription plan.

        Takes effect immediately. Use list_plans to see available options.

        Args:
            plan_id: Plan ID (UUID) to switch to.

        Returns:
            Dict confirming the plan change.
        """
        err = _validate_uuid(plan_id, "plan_id")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "PUT", "/api/plans/user/plan", {"planId": plan_id}
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 45: delete_team
    # ==================================================================

    def delete_team(self, team_id: str) -> dict:
        """Delete a team. Only the team owner can delete.

        All team keys are revoked and remaining balance is refunded.

        Args:
            team_id: UUID of the team to delete.

        Returns:
            Dict confirming the team deletion.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "DELETE", f"/api/teams/{quote(team_id, safe='')}"
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # Alias for naming consistency with other integrations
    team_delete = delete_team

    # ==================================================================
    # Tool 46: team_revoke_key
    # ==================================================================

    def team_revoke_key(self, team_id: str, key_id: str) -> dict:
        """Revoke a team API key.

        Only owners and admins can revoke keys. Applications using this key
        will lose access immediately.

        Args:
            team_id: UUID of the team.
            key_id: API key ID (UUID) to revoke.

        Returns:
            Dict confirming the key revocation.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        err = _validate_uuid(key_id, "key_id")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "DELETE",
                f"/api/teams/{quote(team_id, safe='')}/keys/{quote(key_id, safe='')}",
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 47: team_list_keys
    # ==================================================================

    def team_list_keys(self, team_id: str) -> dict:
        """List all API keys for a team.

        Returns keys with labels, creation dates, and last-used timestamps.

        Args:
            team_id: UUID of the team.

        Returns:
            Dict with a list of team API keys.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "GET", f"/api/teams/{quote(team_id, safe='')}/keys"
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 48: team_list_members
    # ==================================================================

    def team_list_members(self, team_id: str) -> dict:
        """List all members of a team with their roles and join dates.

        Args:
            team_id: UUID of the team.

        Returns:
            Dict with a list of team members.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "GET", f"/api/teams/{quote(team_id, safe='')}/members"
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 49: team_add_member
    # ==================================================================

    def team_add_member(
        self, team_id: str, user_id: str, role: str = "member"
    ) -> dict:
        """Add a user directly to a team by user ID.

        Only owners and admins can add members.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the user to add.
            role: Role for the new member (``member`` or ``admin``).

        Returns:
            Dict confirming the member was added.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        err = _validate_uuid(user_id, "user_id")
        if err:
            return {"error": err}

        if not role or not isinstance(role, str):
            return {"error": "role is required and must be a string"}
        if role not in ("member", "admin"):
            return {"error": "role must be 'member' or 'admin'"}

        try:
            return self._request_with_retry(
                "POST",
                f"/api/teams/{quote(team_id, safe='')}/members",
                {"userId": user_id, "role": role},
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 50: team_remove_member
    # ==================================================================

    def team_remove_member(self, team_id: str, user_id: str) -> dict:
        """Remove a member from a team.

        Only owners and admins can remove members.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the member to remove.

        Returns:
            Dict confirming the member was removed.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        err = _validate_uuid(user_id, "user_id")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "DELETE",
                f"/api/teams/{quote(team_id, safe='')}/members/{quote(user_id, safe='')}",
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 51: team_invite_member
    # ==================================================================

    def team_invite_member(
        self, team_id: str, email: str, role: str = "member"
    ) -> dict:
        """Invite a user to join a team by email address.

        The user will receive an invitation email.

        Args:
            team_id: UUID of the team.
            email: Email address of the user to invite.
            role: Role for the invited member (``member`` or ``admin``).

        Returns:
            Dict with the created invitation details.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        err = _validate_email(email)
        if err:
            return {"error": err}

        if not role or not isinstance(role, str):
            return {"error": "role is required and must be a string"}
        if role not in ("member", "admin"):
            return {"error": "role must be 'member' or 'admin'"}

        try:
            return self._request_with_retry(
                "POST",
                f"/api/teams/{quote(team_id, safe='')}/invites",
                {"email": email.strip(), "role": role},
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 52: team_list_invites
    # ==================================================================

    def team_list_invites(self, team_id: str) -> dict:
        """List all pending invitations for a team.

        Args:
            team_id: UUID of the team.

        Returns:
            Dict with a list of pending invitations.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "GET", f"/api/teams/{quote(team_id, safe='')}/invites"
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 53: team_cancel_invite
    # ==================================================================

    def team_cancel_invite(self, team_id: str, invite_id: str) -> dict:
        """Cancel a pending team invitation.

        Only owners and admins can cancel invites.

        Args:
            team_id: UUID of the team.
            invite_id: Invite ID (UUID) to cancel.

        Returns:
            Dict confirming the invitation was cancelled.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        err = _validate_uuid(invite_id, "invite_id")
        if err:
            return {"error": err}

        try:
            return self._request_with_retry(
                "DELETE",
                f"/api/teams/{quote(team_id, safe='')}/invites/{quote(invite_id, safe='')}",
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # get_tools -- PydanticAI tool registration
    # ==================================================================

    def get_tools(self) -> list:
        """Return tool functions for registration with PydanticAI agents.

        Each returned function is a plain callable with type hints and a
        Google-style docstring. PydanticAI uses these annotations to
        automatically generate tool schemas for the LLM.

        Returns:
            A list of callable tool functions.

        Example::

            from pydantic_ai import Agent
            toolkit = DominusNodeToolkit(api_key="dn_live_...")
            agent = Agent('openai:gpt-4o', tools=toolkit.get_tools())
        """
        toolkit = self

        def proxied_fetch(
            url: str,
            method: str = "GET",
            country: str | None = None,
            proxy_type: str = "dc",
        ) -> dict:
            """Fetch a URL through the Dominus Node rotating proxy network.

            Args:
                url: Target URL to fetch.
                method: HTTP method (GET, HEAD, or OPTIONS).
                country: ISO 3166-1 alpha-2 country code for geo-targeting.
                proxy_type: Proxy type: dc (datacenter) or residential.

            Returns:
                Dict with status, headers, and body.
            """
            return toolkit.proxied_fetch(
                url=url, method=method, country=country, proxy_type=proxy_type
            )

        def check_balance() -> dict:
            """Check the current Dominus Node wallet balance.

            Returns:
                Dict with wallet balance in cents and currency info.
            """
            return toolkit.check_balance()

        def check_usage(period: str = "month") -> dict:
            """Check proxy usage statistics for a time period.

            Args:
                period: Time period: day, week, or month (default).

            Returns:
                Dict with usage statistics including bytes transferred.
            """
            return toolkit.check_usage(period=period)

        def get_proxy_config() -> dict:
            """Get proxy configuration and geo-targeting options.

            Returns:
                Dict with proxy endpoints, supported countries, and pool types.
            """
            return toolkit.get_proxy_config()

        def list_sessions() -> dict:
            """List active proxy sessions.

            Returns:
                Dict with active session information.
            """
            return toolkit.list_sessions()

        def create_agentic_wallet(
            label: str, spending_limit_cents: int
        ) -> dict:
            """Create a new agentic sub-wallet with a per-transaction spending limit.

            Args:
                label: Human-readable label for the wallet (max 100 chars).
                spending_limit_cents: Per-transaction spending limit in cents.

            Returns:
                Dict with the created wallet details including id and balance.
            """
            return toolkit.create_agentic_wallet(
                label=label, spending_limit_cents=spending_limit_cents
            )

        def fund_agentic_wallet(wallet_id: str, amount_cents: int) -> dict:
            """Fund an agentic wallet from the main wallet.

            Args:
                wallet_id: ID of the agentic wallet to fund.
                amount_cents: Amount to transfer in cents.

            Returns:
                Dict with the updated wallet balance.
            """
            return toolkit.fund_agentic_wallet(
                wallet_id=wallet_id, amount_cents=amount_cents
            )

        def agentic_wallet_balance(wallet_id: str) -> dict:
            """Check the balance of an agentic wallet.

            Args:
                wallet_id: ID of the agentic wallet.

            Returns:
                Dict with wallet balance details.
            """
            return toolkit.agentic_wallet_balance(wallet_id=wallet_id)

        def list_agentic_wallets() -> dict:
            """List all agentic wallets.

            Returns:
                Dict with a list of all agentic wallets and their balances.
            """
            return toolkit.list_agentic_wallets()

        def agentic_transactions(wallet_id: str, limit: int = 20) -> dict:
            """Get transaction history for an agentic wallet.

            Args:
                wallet_id: ID of the agentic wallet.
                limit: Maximum number of transactions to return (1-100).

            Returns:
                Dict with transaction history.
            """
            return toolkit.agentic_transactions(
                wallet_id=wallet_id, limit=limit
            )

        def freeze_agentic_wallet(wallet_id: str) -> dict:
            """Freeze an agentic wallet to prevent spending.

            Args:
                wallet_id: ID of the agentic wallet to freeze.

            Returns:
                Dict confirming the wallet is frozen.
            """
            return toolkit.freeze_agentic_wallet(wallet_id=wallet_id)

        def unfreeze_agentic_wallet(wallet_id: str) -> dict:
            """Unfreeze an agentic wallet to re-enable spending.

            Args:
                wallet_id: ID of the agentic wallet to unfreeze.

            Returns:
                Dict confirming the wallet is unfrozen.
            """
            return toolkit.unfreeze_agentic_wallet(wallet_id=wallet_id)

        def delete_agentic_wallet(wallet_id: str) -> dict:
            """Delete an agentic wallet. Must be unfrozen first. Remaining balance is refunded.

            Args:
                wallet_id: ID of the agentic wallet to delete.

            Returns:
                Dict confirming deletion.
            """
            return toolkit.delete_agentic_wallet(wallet_id=wallet_id)

        def create_team(name: str, max_members: int | None = None) -> dict:
            """Create a new team with a shared wallet.

            Args:
                name: Team name (max 100 chars).
                max_members: Optional maximum number of team members (1-100).

            Returns:
                Dict with the created team details.
            """
            return toolkit.create_team(name=name, max_members=max_members)

        def list_teams() -> dict:
            """List all teams the user belongs to.

            Returns:
                Dict with a list of teams and membership info.
            """
            return toolkit.list_teams()

        def team_details(team_id: str) -> dict:
            """Get details for a specific team.

            Args:
                team_id: UUID of the team.

            Returns:
                Dict with team details including members, wallet, and settings.
            """
            return toolkit.team_details(team_id=team_id)

        def team_fund(team_id: str, amount_cents: int) -> dict:
            """Fund a team's shared wallet from the user's personal wallet.

            Args:
                team_id: UUID of the team.
                amount_cents: Amount to transfer in cents (100 to 1,000,000).

            Returns:
                Dict with the updated team wallet details.
            """
            return toolkit.team_fund(team_id=team_id, amount_cents=amount_cents)

        def team_create_key(team_id: str, label: str) -> dict:
            """Create a new API key for a team.

            Args:
                team_id: UUID of the team.
                label: Human-readable label for the key (max 100 chars).

            Returns:
                Dict with the created API key (shown once, store securely).
            """
            return toolkit.team_create_key(team_id=team_id, label=label)

        def team_usage(team_id: str, limit: int = 20) -> dict:
            """Get usage/transaction history for a team.

            Args:
                team_id: UUID of the team.
                limit: Maximum number of records to return (1-100).

            Returns:
                Dict with team usage/transaction history.
            """
            return toolkit.team_usage(team_id=team_id, limit=limit)

        def update_team(
            team_id: str,
            name: str | None = None,
            max_members: int | None = None,
        ) -> dict:
            """Update team settings (name and/or max_members).

            Args:
                team_id: UUID of the team.
                name: New team name (max 100 chars, optional).
                max_members: New max member count (1-100, optional).

            Returns:
                Dict with the updated team details.
            """
            return toolkit.update_team(
                team_id=team_id, name=name, max_members=max_members
            )

        def update_team_member_role(
            team_id: str, user_id: str, role: str
        ) -> dict:
            """Update the role of a team member.

            Args:
                team_id: UUID of the team.
                user_id: UUID of the user whose role to change.
                role: New role: member or admin.

            Returns:
                Dict confirming the role update.
            """
            return toolkit.update_team_member_role(
                team_id=team_id, user_id=user_id, role=role
            )

        def x402_info() -> dict:
            """Get x402 micropayment protocol information.

            Returns details about x402 HTTP 402 Payment Required protocol support
            including facilitators, pricing, and payment options.

            Returns:
                Dict with x402 protocol information.
            """
            return toolkit.x402_info()

        def topup_paypal(amount_cents: int) -> dict:
            """Create a PayPal top-up order for the user's wallet.

            Args:
                amount_cents: Amount to top up in cents. Minimum $5.00 (500 cents).

            Returns:
                Dict with orderId and approvalUrl for completing the PayPal payment.
            """
            return toolkit.topup_paypal(amount_cents=amount_cents)

        def topup_stripe(amount_cents: int) -> dict:
            """Create a Stripe checkout session for wallet top-up.

            Args:
                amount_cents: Amount to top up in cents. Minimum $5.00 (500), max $1,000 (100,000).

            Returns:
                Dict with sessionId and checkoutUrl for completing the Stripe payment.
            """
            return toolkit.topup_stripe(amount_cents=amount_cents)

        def topup_crypto(amount_usd: float, currency: str) -> dict:
            """Create a crypto invoice for wallet top-up via NOWPayments.

            Args:
                amount_usd: Amount in USD (5 to 1,000).
                currency: Cryptocurrency: BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK.

            Returns:
                Dict with invoiceId and paymentUrl for completing the crypto payment.
            """
            return toolkit.topup_crypto(amount_usd=amount_usd, currency=currency)

        def update_wallet_policy(
            wallet_id: str,
            daily_limit_cents: int | None = None,
            allowed_domains: list | None = None,
        ) -> dict:
            """Update the policy of an agentic wallet.

            Args:
                wallet_id: ID of the agentic wallet.
                daily_limit_cents: Optional daily budget cap in cents (1 to 1,000,000).
                allowed_domains: Optional list of allowed domains (max 100 entries).

            Returns:
                Dict with the updated wallet policy.
            """
            return toolkit.update_wallet_policy(
                wallet_id=wallet_id,
                daily_limit_cents=daily_limit_cents,
                allowed_domains=allowed_domains,
            )

        def get_proxy_status() -> dict:
            """Get the current status of the proxy gateway.

            Returns status including uptime, active connections, and pool health.

            Returns:
                Dict with proxy gateway status information.
            """
            return toolkit.get_proxy_status()

        def get_transactions(limit: int = 20) -> dict:
            """Get wallet transaction history showing top-ups, charges, and refunds.

            Args:
                limit: Number of transactions to return (1-100, default 20).

            Returns:
                Dict with transaction history.
            """
            return toolkit.get_transactions(limit=limit)

        def get_forecast() -> dict:
            """Get a spending forecast based on recent usage patterns.

            Shows estimated days until balance runs out and projected monthly cost.

            Returns:
                Dict with spending forecast information.
            """
            return toolkit.get_forecast()

        def check_payment(invoice_id: str) -> dict:
            """Check the status of a crypto top-up payment by invoice ID.

            Args:
                invoice_id: Crypto invoice ID (UUID) returned from topup_crypto.

            Returns:
                Dict with payment status (pending, confirming, completed, expired).
            """
            return toolkit.check_payment(invoice_id=invoice_id)

        def get_daily_usage(days: int = 7) -> dict:
            """Get daily bandwidth usage breakdown for the specified number of days.

            Args:
                days: Number of days to look back (1-365, default 7).

            Returns:
                Dict with per-day bytes transferred and cost.
            """
            return toolkit.get_daily_usage(days=days)

        def get_top_hosts(limit: int = 10) -> dict:
            """Get the top hosts by bandwidth usage.

            Args:
                limit: Number of top hosts to return (1-100, default 10).

            Returns:
                Dict with top hosts and their bandwidth consumption.
            """
            return toolkit.get_top_hosts(limit=limit)

        def register(email: str, password: str) -> dict:
            """Register a new Dominus Node account. Does not require authentication.

            Args:
                email: Email address for the new account.
                password: Password (8-128 characters).

            Returns:
                Dict with user info and initial API key.
            """
            return toolkit.register(email=email, password=password)

        def login(email: str, password: str) -> dict:
            """Log in to an existing Dominus Node account. Does not require authentication.

            Args:
                email: Account email address.
                password: Account password.

            Returns:
                Dict with JWT access and refresh tokens.
            """
            return toolkit.login(email=email, password=password)

        def get_account_info() -> dict:
            """Get account profile information.

            Returns email, plan, verification status, and creation date.

            Returns:
                Dict with account profile information.
            """
            return toolkit.get_account_info()

        def verify_email(token: str) -> dict:
            """Verify an email address using the verification token. Does not require authentication.

            Args:
                token: Email verification token from the verification email.

            Returns:
                Dict confirming email verification.
            """
            return toolkit.verify_email(token=token)

        def resend_verification() -> dict:
            """Resend the email verification link. Requires authentication.

            Returns:
                Dict confirming the verification email was sent.
            """
            return toolkit.resend_verification()

        def update_password(current_password: str, new_password: str) -> dict:
            """Change your account password. Requires current password for verification.

            Args:
                current_password: Current account password.
                new_password: New password (8-128 characters).

            Returns:
                Dict confirming the password change.
            """
            return toolkit.update_password(
                current_password=current_password, new_password=new_password
            )

        def list_keys() -> dict:
            """List all personal API keys with labels, creation dates, and last-used timestamps.

            Returns:
                Dict with a list of API keys.
            """
            return toolkit.list_keys()

        def create_key(label: str) -> dict:
            """Create a new personal API key. The key is shown only once -- save it immediately.

            Args:
                label: Label for the API key (1-100 characters).

            Returns:
                Dict with the created API key (shown once).
            """
            return toolkit.create_key(label=label)

        def revoke_key(key_id: str) -> dict:
            """Revoke (delete) a personal API key. This action is irreversible.

            Args:
                key_id: API key ID (UUID) to revoke.

            Returns:
                Dict confirming the key revocation.
            """
            return toolkit.revoke_key(key_id=key_id)

        def get_plan() -> dict:
            """Get your current subscription plan including tier, bandwidth limits, and pricing.

            Returns:
                Dict with current plan information.
            """
            return toolkit.get_plan()

        def list_plans() -> dict:
            """List all available subscription plans with features, pricing, and bandwidth limits.

            Returns:
                Dict with available plans.
            """
            return toolkit.list_plans()

        def change_plan(plan_id: str) -> dict:
            """Change your subscription plan. Takes effect immediately.

            Args:
                plan_id: Plan ID (UUID) to switch to. Use list_plans to see options.

            Returns:
                Dict confirming the plan change.
            """
            return toolkit.change_plan(plan_id=plan_id)

        def delete_team(team_id: str) -> dict:
            """Delete a team. Only the team owner can delete.

            All team keys are revoked and remaining balance is refunded.

            Args:
                team_id: UUID of the team to delete.

            Returns:
                Dict confirming the team deletion.
            """
            return toolkit.delete_team(team_id=team_id)

        def team_revoke_key(team_id: str, key_id: str) -> dict:
            """Revoke a team API key. Only owners and admins can revoke keys.

            Args:
                team_id: UUID of the team.
                key_id: API key ID (UUID) to revoke.

            Returns:
                Dict confirming the key revocation.
            """
            return toolkit.team_revoke_key(team_id=team_id, key_id=key_id)

        def team_list_keys(team_id: str) -> dict:
            """List all API keys for a team with labels, creation dates, and last-used timestamps.

            Args:
                team_id: UUID of the team.

            Returns:
                Dict with a list of team API keys.
            """
            return toolkit.team_list_keys(team_id=team_id)

        def team_list_members(team_id: str) -> dict:
            """List all members of a team with their roles and join dates.

            Args:
                team_id: UUID of the team.

            Returns:
                Dict with a list of team members.
            """
            return toolkit.team_list_members(team_id=team_id)

        def team_add_member(
            team_id: str, user_id: str, role: str = "member"
        ) -> dict:
            """Add a user directly to a team by user ID. Only owners and admins can add members.

            Args:
                team_id: UUID of the team.
                user_id: UUID of the user to add.
                role: Role for the new member: member or admin.

            Returns:
                Dict confirming the member was added.
            """
            return toolkit.team_add_member(
                team_id=team_id, user_id=user_id, role=role
            )

        def team_remove_member(team_id: str, user_id: str) -> dict:
            """Remove a member from a team. Only owners and admins can remove members.

            Args:
                team_id: UUID of the team.
                user_id: UUID of the member to remove.

            Returns:
                Dict confirming the member was removed.
            """
            return toolkit.team_remove_member(
                team_id=team_id, user_id=user_id
            )

        def team_invite_member(
            team_id: str, email: str, role: str = "member"
        ) -> dict:
            """Invite a user to join a team by email. The user will receive an invitation email.

            Args:
                team_id: UUID of the team.
                email: Email address of the user to invite.
                role: Role for the invited member: member or admin.

            Returns:
                Dict with the created invitation details.
            """
            return toolkit.team_invite_member(
                team_id=team_id, email=email, role=role
            )

        def team_list_invites(team_id: str) -> dict:
            """List all pending invitations for a team.

            Args:
                team_id: UUID of the team.

            Returns:
                Dict with a list of pending invitations.
            """
            return toolkit.team_list_invites(team_id=team_id)

        def team_cancel_invite(team_id: str, invite_id: str) -> dict:
            """Cancel a pending team invitation. Only owners and admins can cancel invites.

            Args:
                team_id: UUID of the team.
                invite_id: Invite ID (UUID) to cancel.

            Returns:
                Dict confirming the invitation was cancelled.
            """
            return toolkit.team_cancel_invite(
                team_id=team_id, invite_id=invite_id
            )

        return [
            # Proxy (3)
            proxied_fetch,
            get_proxy_config,
            get_proxy_status,
            # Sessions (1)
            list_sessions,
            # Wallet (8)
            check_balance,
            get_transactions,
            get_forecast,
            topup_paypal,
            topup_stripe,
            topup_crypto,
            check_payment,
            x402_info,
            # Usage (3)
            check_usage,
            get_daily_usage,
            get_top_hosts,
            # Account (6)
            register,
            login,
            get_account_info,
            verify_email,
            resend_verification,
            update_password,
            # API Keys (3)
            list_keys,
            create_key,
            revoke_key,
            # Plans (3)
            get_plan,
            list_plans,
            change_plan,
            # Agentic Wallets (9)
            create_agentic_wallet,
            fund_agentic_wallet,
            agentic_wallet_balance,
            list_agentic_wallets,
            agentic_transactions,
            freeze_agentic_wallet,
            unfreeze_agentic_wallet,
            delete_agentic_wallet,
            update_wallet_policy,
            # Teams (17)
            create_team,
            list_teams,
            team_details,
            team_fund,
            team_create_key,
            team_revoke_key,
            team_list_keys,
            team_usage,
            update_team,
            update_team_member_role,
            team_list_members,
            team_add_member,
            team_remove_member,
            team_invite_member,
            team_list_invites,
            team_cancel_invite,
            delete_team,
        ]
