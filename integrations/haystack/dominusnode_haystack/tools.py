"""Dominus Node Haystack toolkit -- 53 proxy, wallet, team, and payment tools.

Provides a Haystack-compatible toolkit class that exposes 53 Tool objects for
interacting with the Dominus Node rotating proxy-as-a-service platform.

Tools cover:
  - Proxied HTTP fetching through rotating proxies
  - Wallet balance, transactions, forecast, and usage monitoring
  - Proxy configuration, status, and session listing
  - Agentic wallet management (create, fund, freeze, unfreeze, delete)
  - Team management (create, list, fund, keys, usage, update, role changes,
    members, invites)
  - Account lifecycle (register, login, info, email verification, password)
  - API key management (list, create, revoke)
  - Plan management (get, list, change)
  - PayPal, Stripe, and crypto top-up

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

    from dominusnode_haystack import DominusNodeToolkit

    toolkit = DominusNodeToolkit(api_key="dn_live_...")
    tools = toolkit.get_tools()  # list of Haystack Tool objects

    # Use directly:
    result = toolkit.check_balance()  # returns dict

Requires: httpx (``pip install httpx``), haystack-ai (``pip install haystack-ai``)
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
from typing import Any, Dict, List, Optional, Set
from urllib.parse import quote, urlparse

import httpx

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


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _validate_email(value: Any, field_name: str = "email") -> Optional[str]:
    """Validate an email string, returning an error message or None."""
    if not value or not isinstance(value, str):
        return f"{field_name} is required and must be a string"
    if len(value) > 254:
        return f"{field_name} must be 254 characters or fewer"
    if not _EMAIL_RE.match(value):
        return f"{field_name} must be a valid email address"
    return None


def _validate_password(value: Any, field_name: str = "password") -> Optional[str]:
    """Validate a password string, returning an error message or None."""
    if not value or not isinstance(value, str):
        return f"{field_name} is required and must be a string"
    if len(value) < 8:
        return f"{field_name} must be at least 8 characters"
    if len(value) > 128:
        return f"{field_name} must be 128 characters or fewer"
    return None


def _validate_finite_int(
    value: Any,
    field_name: str,
    min_value: int = 1,
    max_value: int = 2_147_483_647,
) -> Optional[str]:
    """Validate integer with NaN/Infinity guards (Python: float('nan') etc.)."""
    if isinstance(value, bool):
        return f"{field_name} must be an integer"
    if isinstance(value, float):
        if not math.isfinite(value):
            return f"{field_name} must be a finite number"
        if value != int(value):
            return f"{field_name} must be an integer"
        value = int(value)
    if not isinstance(value, int):
        return f"{field_name} must be an integer"
    if value < min_value or value > max_value:
        return f"{field_name} must be between {min_value} and {max_value}"
    return None


def _validate_code(value: Any, field_name: str = "code") -> Optional[str]:
    """Validate a verification code string, returning error or None."""
    if not value or not isinstance(value, str):
        return f"{field_name} is required and must be a string"
    if len(value) > 100:
        return f"{field_name} must be 100 characters or fewer"
    if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in value):
        return f"{field_name} contains invalid control characters"
    return None


def _validate_plan_name(value: Any, field_name: str = "plan") -> Optional[str]:
    """Validate a plan name string, returning error or None."""
    if not value or not isinstance(value, str):
        return f"{field_name} is required and must be a string"
    if len(value) > 100:
        return f"{field_name} must be 100 characters or fewer"
    if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in value):
        return f"{field_name} contains invalid control characters"
    return None


def _validate_invoice_id(value: Any, field_name: str = "invoice_id") -> Optional[str]:
    """Validate an invoice ID string, returning error or None."""
    if not value or not isinstance(value, str):
        return f"{field_name} is required and must be a string"
    if len(value) > 200:
        return f"{field_name} must be 200 characters or fewer"
    if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in value):
        return f"{field_name} contains invalid control characters"
    return None


# ===========================================================================
# DominusNodeToolkit -- main toolkit class
# ===========================================================================


class DominusNodeToolkit:
    """Haystack toolkit providing Dominus Node rotating proxy tools.

    Authenticates using a Dominus Node API key and exposes 53 tools for proxy,
    wallet, team, account, key, plan, and payment management.  All tool
    methods return dicts suitable for Haystack pipeline consumption.

    Args:
        api_key: Dominus Node API key (``dn_live_...`` or ``dn_test_...``).
            Falls back to ``DOMINUSNODE_API_KEY`` environment variable.
        base_url: Base URL of the Dominus Node REST API.
        proxy_host: Hostname of the Dominus Node proxy gateway.
        proxy_port: Port of the Dominus Node proxy gateway.
        timeout: HTTP request timeout in seconds.

    Example::

        toolkit = DominusNodeToolkit(api_key="dn_live_abc123")
        tools = toolkit.get_tools()  # list of Haystack Tool objects

        # Or call directly:
        result = toolkit.check_balance()  # dict
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
                "User-Agent": "dominusnode-haystack/1.0.0",
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
            kwargs: Dict[str, Any] = {
                "headers": {
                    "User-Agent": "dominusnode-haystack/1.0.0",
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._token}",
                },
            }
            if self.agent_secret:
                kwargs["headers"]["X-DominusNode-Agent"] = "mcp"
                kwargs["headers"]["X-DominusNode-Agent-Secret"] = self.agent_secret

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
    # Public (unauthenticated) request helper
    # ------------------------------------------------------------------

    def _api_request_public(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Make an unauthenticated API request to the Dominus Node REST API.

        Used for public endpoints like register, login, and verify-email
        that do not require an API key or JWT token.

        Args:
            method: HTTP method (POST, GET, etc.).
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
            kwargs: Dict[str, Any] = {
                "headers": {
                    "User-Agent": "dominusnode-haystack/1.0.0",
                    "Content-Type": "application/json",
                },
            }
            if self.agent_secret:
                kwargs["headers"]["X-DominusNode-Agent"] = "mcp"
                kwargs["headers"]["X-DominusNode-Agent-Secret"] = self.agent_secret

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
        headers: Dict[str, str] | None = None,
    ) -> Dict[str, Any]:
        """Fetch a URL through the Dominus Node rotating proxy network.

        Args:
            url: Target URL to fetch.
            method: HTTP method (GET, HEAD, or OPTIONS only).
            country: Optional ISO 3166-1 alpha-2 country code for geo-targeting.
            proxy_type: Proxy type: ``dc`` (datacenter, $3/GB) or
                ``residential`` ($5/GB). Default: ``dc``.
            headers: Optional additional headers to send with the request.

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

        # Sanitize headers
        blocked_header_names = {
            "host", "connection", "content-length", "transfer-encoding",
            "proxy-authorization", "authorization", "user-agent",
        }
        safe_headers: Dict[str, str] = {}
        for key, value in (headers or {}).items():
            if key.lower() not in blocked_header_names:
                # CRLF injection prevention
                if "\r" in key or "\n" in key or "\0" in key:
                    continue
                if "\r" in str(value) or "\n" in str(value) or "\0" in str(value):
                    continue
                safe_headers[key] = str(value)

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
                    headers=safe_headers,
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

    def check_balance(self) -> Dict[str, Any]:
        """Check the current wallet balance.

        Returns:
            Dict with wallet balance information.
        """
        try:
            result = self._request_with_retry("GET", "/api/wallet")
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 3: check_usage
    # ==================================================================

    def check_usage(self, period: str = "month") -> Dict[str, Any]:
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
            result = self._request_with_retry(
                "GET",
                f"/api/usage?since={quote(date_range['since'], safe='')}"
                f"&until={quote(date_range['until'], safe='')}",
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 4: get_proxy_config
    # ==================================================================

    def get_proxy_config(self) -> Dict[str, Any]:
        """Get proxy configuration information.

        Returns:
            Dict with proxy configuration (endpoints, geo-targeting options).
        """
        try:
            result = self._request_with_retry("GET", "/api/proxy/config")
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 5: list_sessions
    # ==================================================================

    def list_sessions(self) -> Dict[str, Any]:
        """List active proxy sessions.

        Returns:
            Dict with active session information.
        """
        try:
            result = self._request_with_retry("GET", "/api/sessions/active")
            return result
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
    ) -> Dict[str, Any]:
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
            result = self._request_with_retry("POST", "/api/agent-wallet", body)
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 7: fund_agentic_wallet
    # ==================================================================

    def fund_agentic_wallet(self, wallet_id: str, amount_cents: int) -> Dict[str, Any]:
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
            result = self._request_with_retry(
                "POST",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/fund",
                {"amountCents": amount_cents},
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 8: agentic_wallet_balance
    # ==================================================================

    def agentic_wallet_balance(self, wallet_id: str) -> Dict[str, Any]:
        """Check the balance of an agentic wallet.

        Args:
            wallet_id: ID of the agentic wallet.

        Returns:
            Dict with wallet balance details.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        try:
            result = self._request_with_retry(
                "GET",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}",
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 9: list_agentic_wallets
    # ==================================================================

    def list_agentic_wallets(self) -> Dict[str, Any]:
        """List all agentic wallets.

        Returns:
            Dict with a list of all agentic wallets.
        """
        try:
            result = self._request_with_retry("GET", "/api/agent-wallet")
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 10: agentic_transactions
    # ==================================================================

    def agentic_transactions(self, wallet_id: str, limit: int = 20) -> Dict[str, Any]:
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
            result = self._request_with_retry(
                "GET",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/transactions{qs}",
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 11: freeze_agentic_wallet
    # ==================================================================

    def freeze_agentic_wallet(self, wallet_id: str) -> Dict[str, Any]:
        """Freeze an agentic wallet (prevent spending).

        Args:
            wallet_id: ID of the agentic wallet to freeze.

        Returns:
            Dict confirming the wallet is frozen.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        try:
            result = self._request_with_retry(
                "POST",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/freeze",
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 12: unfreeze_agentic_wallet
    # ==================================================================

    def unfreeze_agentic_wallet(self, wallet_id: str) -> Dict[str, Any]:
        """Unfreeze an agentic wallet (re-enable spending).

        Args:
            wallet_id: ID of the agentic wallet to unfreeze.

        Returns:
            Dict confirming the wallet is unfrozen.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        try:
            result = self._request_with_retry(
                "POST",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/unfreeze",
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 13: delete_agentic_wallet
    # ==================================================================

    def delete_agentic_wallet(self, wallet_id: str) -> Dict[str, Any]:
        """Delete an agentic wallet (must be unfrozen first; refunds balance).

        Args:
            wallet_id: ID of the agentic wallet to delete.

        Returns:
            Dict confirming deletion.
        """
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        try:
            result = self._request_with_retry(
                "DELETE",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}",
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 14: create_team
    # ==================================================================

    def create_team(self, name: str, max_members: int | None = None) -> Dict[str, Any]:
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
            result = self._request_with_retry("POST", "/api/teams", body)
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 15: list_teams
    # ==================================================================

    def list_teams(self) -> Dict[str, Any]:
        """List all teams the user belongs to.

        Returns:
            Dict with a list of teams.
        """
        try:
            result = self._request_with_retry("GET", "/api/teams")
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 16: team_details
    # ==================================================================

    def team_details(self, team_id: str) -> Dict[str, Any]:
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
            result = self._request_with_retry(
                "GET", f"/api/teams/{quote(team_id, safe='')}"
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 17: team_fund
    # ==================================================================

    def team_fund(self, team_id: str, amount_cents: int) -> Dict[str, Any]:
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
            result = self._request_with_retry(
                "POST",
                f"/api/teams/{quote(team_id, safe='')}/wallet/fund",
                {"amountCents": amount_cents},
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 18: team_create_key
    # ==================================================================

    def team_create_key(self, team_id: str, label: str) -> Dict[str, Any]:
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
            result = self._request_with_retry(
                "POST",
                f"/api/teams/{quote(team_id, safe='')}/keys",
                {"label": label},
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 19: team_usage
    # ==================================================================

    def team_usage(self, team_id: str, limit: int = 20) -> Dict[str, Any]:
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
            result = self._request_with_retry(
                "GET",
                f"/api/teams/{quote(team_id, safe='')}/wallet/transactions{qs}",
            )
            return result
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
    ) -> Dict[str, Any]:
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
            result = self._request_with_retry(
                "PATCH",
                f"/api/teams/{quote(team_id, safe='')}",
                body,
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 21: update_team_member_role
    # ==================================================================

    def update_team_member_role(
        self, team_id: str, user_id: str, role: str
    ) -> Dict[str, Any]:
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
            result = self._request_with_retry(
                "PATCH",
                f"/api/teams/{quote(team_id, safe='')}/members/{quote(user_id, safe='')}",
                {"role": role},
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 22: x402_info
    # ==================================================================

    def x402_info(self) -> Dict[str, Any]:
        """Get x402 micropayment protocol information.

        Returns details about x402 HTTP 402 Payment Required protocol support
        including facilitators, pricing, supported currencies, and payment
        options for AI agent micropayments.

        Returns:
            Dict with x402 protocol information.
        """
        try:
            result = self._request_with_retry("GET", "/api/x402/info")
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 23: topup_paypal
    # ==================================================================

    def topup_paypal(self, amount_cents: int) -> Dict[str, Any]:
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
            result = self._request_with_retry(
                "POST",
                "/api/wallet/topup/paypal",
                {"amountCents": amount_cents},
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 24: topup_stripe
    # ==================================================================

    def topup_stripe(self, amount_cents: int) -> Dict[str, Any]:
        """Create a Stripe checkout session for wallet top-up.

        Args:
            amount_cents: Amount to top up in cents (500 to 100,000).
                Minimum $5.00 (500 cents), maximum $1,000.00 (100,000 cents).

        Returns:
            Dict with checkout session details for completing
            the Stripe payment flow.
        """
        err = _validate_positive_int(
            amount_cents, "amount_cents", min_value=500, max_value=100_000
        )
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "POST",
                "/api/wallet/topup/stripe",
                {"amountCents": amount_cents},
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 25: topup_crypto
    # ==================================================================

    _VALID_CRYPTO_CURRENCIES = {
        "BTC", "ETH", "LTC", "XMR", "ZEC",
        "USDC", "SOL", "USDT", "DAI", "BNB", "LINK",
    }

    def topup_crypto(self, amount_usd: float, currency: str) -> Dict[str, Any]:
        """Create a crypto payment invoice for wallet top-up.

        Args:
            amount_usd: Amount in USD (5 to 1,000).
            currency: Cryptocurrency code (BTC/ETH/LTC/XMR/ZEC/USDC/SOL/
                USDT/DAI/BNB/LINK).

        Returns:
            Dict with invoice details for completing the crypto payment.
        """
        if not isinstance(amount_usd, (int, float)) or isinstance(amount_usd, bool):
            return {"error": "amount_usd must be a number between 5 and 1,000"}
        if not math.isfinite(amount_usd):
            return {"error": "amount_usd must be a number between 5 and 1,000"}
        if amount_usd < 5 or amount_usd > 1000:
            return {"error": "amount_usd must be a number between 5 and 1,000"}

        if not currency or not isinstance(currency, str):
            return {
                "error": "currency must be one of: BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK",
            }
        if currency.upper() not in self._VALID_CRYPTO_CURRENCIES:
            return {
                "error": "currency must be one of: BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK",
            }

        try:
            result = self._request_with_retry(
                "POST",
                "/api/wallet/topup/crypto",
                {"amountUsd": amount_usd, "currency": currency.lower()},
            )
            return result
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
    ) -> Dict[str, Any]:
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
            result = self._request_with_retry(
                "PATCH",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/policy",
                body,
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 27: get_proxy_status
    # ==================================================================

    def get_proxy_status(self) -> Dict[str, Any]:
        """Get the current status of the proxy gateway.

        Returns:
            Dict with proxy gateway status including uptime, active
            connections, and pool health.
        """
        try:
            result = self._request_with_retry("GET", "/api/proxy/status")
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 28: get_transactions
    # ==================================================================

    def get_transactions(self, limit: int = 20) -> Dict[str, Any]:
        """Get main wallet transaction history.

        Args:
            limit: Maximum number of transactions to return (1-100,
                default 20).

        Returns:
            Dict with transaction history including top-ups, usage
            charges, and refunds.
        """
        err = _validate_finite_int(limit, "limit", min_value=1, max_value=100)
        if err:
            return {"error": err}

        qs = f"?limit={int(limit)}" if limit != 20 else ""

        try:
            result = self._request_with_retry(
                "GET", f"/api/wallet/transactions{qs}"
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 29: get_forecast
    # ==================================================================

    def get_forecast(self) -> Dict[str, Any]:
        """Get a spending forecast based on recent usage patterns.

        Returns:
            Dict with projected balance depletion date, daily burn
            rate, and average daily bandwidth.
        """
        try:
            result = self._request_with_retry("GET", "/api/wallet/forecast")
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 30: check_payment
    # ==================================================================

    def check_payment(self, invoice_id: str) -> Dict[str, Any]:
        """Check the status of a crypto payment invoice.

        Args:
            invoice_id: Crypto invoice ID returned by topup_crypto.

        Returns:
            Dict with payment status, amount, currency, and timestamps.
        """
        err = _validate_invoice_id(invoice_id, "invoice_id")
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "GET",
                f"/api/wallet/topup/crypto/{quote(invoice_id, safe='')}/status",
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 31: get_daily_usage
    # ==================================================================

    def get_daily_usage(self, days: int = 7) -> Dict[str, Any]:
        """Get daily bandwidth usage breakdown.

        Args:
            days: Number of days to look back (1-90, default 7).

        Returns:
            Dict with per-day bytes, cost, and request count.
        """
        err = _validate_finite_int(days, "days", min_value=1, max_value=90)
        if err:
            return {"error": err}

        qs = f"?days={int(days)}" if days != 7 else ""

        try:
            result = self._request_with_retry(
                "GET", f"/api/usage/daily{qs}"
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 32: get_top_hosts
    # ==================================================================

    def get_top_hosts(self, limit: int = 10) -> Dict[str, Any]:
        """Get the top hosts by bandwidth usage.

        Args:
            limit: Number of top hosts to return (1-50, default 10).

        Returns:
            Dict with top hosts by bandwidth consumption.
        """
        err = _validate_finite_int(limit, "limit", min_value=1, max_value=50)
        if err:
            return {"error": err}

        qs = f"?limit={int(limit)}" if limit != 10 else ""

        try:
            result = self._request_with_retry(
                "GET", f"/api/usage/top-hosts{qs}"
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 33: register_account
    # ==================================================================

    def register_account(self, email: str, password: str) -> Dict[str, Any]:
        """Register a new Dominus Node account (unauthenticated).

        Args:
            email: Email address for the new account.
            password: Password (8-128 characters).

        Returns:
            Dict with user details and verification instructions.
        """
        err = _validate_email(email, "email")
        if err:
            return {"error": err}

        err = _validate_password(password, "password")
        if err:
            return {"error": err}

        try:
            body: dict = {"email": email, "password": password}
            pow_result = _solve_pow(self.base_url)
            if pow_result:
                body["pow"] = pow_result
            result = self._api_request_public(
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
    # Tool 34: login_account
    # ==================================================================

    def login_account(self, email: str, password: str) -> Dict[str, Any]:
        """Log in to a Dominus Node account (unauthenticated).

        Returns access and refresh tokens. Detects MFA requirement.

        Args:
            email: Account email address.
            password: Account password (8-128 characters).

        Returns:
            Dict with tokens or MFA challenge information.
        """
        err = _validate_email(email, "email")
        if err:
            return {"error": err}

        err = _validate_password(password, "password")
        if err:
            return {"error": err}

        try:
            result = self._api_request_public(
                "POST",
                "/api/auth/login",
                {"email": email, "password": password},
            )
            # Surface MFA requirement per SDK rules
            if isinstance(result, dict) and result.get("mfaRequired"):
                return {
                    "mfaRequired": True,
                    "message": "Multi-factor authentication is required. "
                    "Complete MFA verification to continue.",
                }
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 35: get_account_info
    # ==================================================================

    def get_account_info(self) -> Dict[str, Any]:
        """Get current account information.

        Returns:
            Dict with account details including email, plan,
            verification status, and creation date.
        """
        try:
            result = self._request_with_retry("GET", "/api/auth/me")
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 36: verify_email
    # ==================================================================

    def verify_email(self, email: str, code: str) -> Dict[str, Any]:
        """Verify email address using the code sent during registration (unauthenticated).

        Args:
            email: Email address to verify.
            code: Verification code from the email.

        Returns:
            Dict confirming email verification.
        """
        err = _validate_email(email, "email")
        if err:
            return {"error": err}

        err = _validate_code(code, "code")
        if err:
            return {"error": err}

        try:
            result = self._api_request_public(
                "POST",
                "/api/auth/verify-email",
                {"email": email, "code": code},
            )
            return result if result else {"message": "Email verified successfully"}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 37: resend_verification
    # ==================================================================

    def resend_verification(self) -> Dict[str, Any]:
        """Resend the email verification code (authenticated).

        Returns:
            Dict confirming the verification email was resent.
        """
        try:
            result = self._request_with_retry(
                "POST", "/api/auth/resend-verification"
            )
            return result if result else {"message": "Verification email resent"}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 38: update_password
    # ==================================================================

    def update_password(
        self, current_password: str, new_password: str
    ) -> Dict[str, Any]:
        """Change account password (authenticated).

        Args:
            current_password: Current password (8-128 characters).
            new_password: New password (8-128 characters).

        Returns:
            Dict confirming password update.
        """
        err = _validate_password(current_password, "current_password")
        if err:
            return {"error": err}

        err = _validate_password(new_password, "new_password")
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "POST",
                "/api/auth/change-password",
                {
                    "currentPassword": current_password,
                    "newPassword": new_password,
                },
            )
            return result if result else {"message": "Password updated successfully"}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 39: list_keys
    # ==================================================================

    def list_keys(self) -> Dict[str, Any]:
        """List all personal API keys.

        Returns:
            Dict with API keys including prefix, label, status, and
            creation date.
        """
        try:
            result = self._request_with_retry("GET", "/api/keys")
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 40: create_key
    # ==================================================================

    def create_key(self, label: str) -> Dict[str, Any]:
        """Create a new personal API key.

        The full key is shown only once -- save it immediately.

        Args:
            label: Human-readable label for the key (max 100 chars).

        Returns:
            Dict with the created API key details.
        """
        err = _validate_label(label, "label")
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "POST", "/api/keys", {"label": label}
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 41: revoke_key
    # ==================================================================

    def revoke_key(self, key_id: str) -> Dict[str, Any]:
        """Revoke (delete) a personal API key.

        Args:
            key_id: UUID of the API key to revoke.

        Returns:
            Dict confirming the key has been revoked.
        """
        err = _validate_uuid(key_id, "key_id")
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "DELETE", f"/api/keys/{quote(key_id, safe='')}"
            )
            return result if result else {"message": "API key revoked"}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 42: get_plan
    # ==================================================================

    def get_plan(self) -> Dict[str, Any]:
        """Get current plan details.

        Returns:
            Dict with plan name, limits, pricing, and features.
        """
        try:
            result = self._request_with_retry("GET", "/api/plans/user/plan")
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 43: list_plans
    # ==================================================================

    def list_plans(self) -> Dict[str, Any]:
        """List all available plans with pricing and limits.

        Returns:
            Dict with available plans.
        """
        try:
            result = self._request_with_retry("GET", "/api/plans")
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 44: change_plan
    # ==================================================================

    def change_plan(self, plan: str) -> Dict[str, Any]:
        """Change the current account plan.

        Use list_plans to see available options first.

        Args:
            plan: Plan name/ID to switch to.

        Returns:
            Dict with the updated plan details.
        """
        err = _validate_plan_name(plan, "plan")
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "PUT", "/api/plans/user/plan", {"planId": plan}
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 45: team_delete
    # ==================================================================

    def team_delete(self, team_id: str) -> Dict[str, Any]:
        """Delete a team (owner only). Remaining balance is refunded.

        Args:
            team_id: UUID of the team to delete.

        Returns:
            Dict confirming team deletion.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "DELETE", f"/api/teams/{quote(team_id, safe='')}"
            )
            return result if result else {"message": "Team deleted"}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 46: team_revoke_key
    # ==================================================================

    def team_revoke_key(self, team_id: str, key_id: str) -> Dict[str, Any]:
        """Revoke a shared API key for a team.

        Args:
            team_id: UUID of the team.
            key_id: UUID of the API key to revoke.

        Returns:
            Dict confirming the team key has been revoked.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        err = _validate_uuid(key_id, "key_id")
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "DELETE",
                f"/api/teams/{quote(team_id, safe='')}/keys/{quote(key_id, safe='')}",
            )
            return result if result else {"message": "Team API key revoked"}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 47: team_list_keys
    # ==================================================================

    def team_list_keys(self, team_id: str) -> Dict[str, Any]:
        """List all API keys for a team.

        Args:
            team_id: UUID of the team.

        Returns:
            Dict with team API keys.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "GET", f"/api/teams/{quote(team_id, safe='')}/keys"
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 48: team_list_members
    # ==================================================================

    def team_list_members(self, team_id: str) -> Dict[str, Any]:
        """List all members of a team with their roles.

        Args:
            team_id: UUID of the team.

        Returns:
            Dict with team members and their roles.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "GET", f"/api/teams/{quote(team_id, safe='')}/members"
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 49: team_add_member
    # ==================================================================

    def team_add_member(
        self, team_id: str, user_id: str, role: str = "member"
    ) -> Dict[str, Any]:
        """Add a member directly to a team by user ID.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the user to add.
            role: Role for the new member (``member`` or ``admin``).

        Returns:
            Dict with the added member details.
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
            result = self._request_with_retry(
                "POST",
                f"/api/teams/{quote(team_id, safe='')}/members",
                {"userId": user_id, "role": role},
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 50: team_remove_member
    # ==================================================================

    def team_remove_member(self, team_id: str, user_id: str) -> Dict[str, Any]:
        """Remove a member from a team.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the member to remove.

        Returns:
            Dict confirming member removal.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        err = _validate_uuid(user_id, "user_id")
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "DELETE",
                f"/api/teams/{quote(team_id, safe='')}/members/{quote(user_id, safe='')}",
            )
            return result if result else {"message": "Team member removed"}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 51: team_invite_member
    # ==================================================================

    def team_invite_member(
        self, team_id: str, email: str, role: str = "member"
    ) -> Dict[str, Any]:
        """Send an invitation to join a team by email.

        Args:
            team_id: UUID of the team.
            email: Email address of the person to invite.
            role: Role for the invited member (``member`` or ``admin``).

        Returns:
            Dict with invitation details including invite ID and expiry.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        err = _validate_email(email, "email")
        if err:
            return {"error": err}

        if not role or not isinstance(role, str):
            return {"error": "role is required and must be a string"}
        if role not in ("member", "admin"):
            return {"error": "role must be 'member' or 'admin'"}

        try:
            result = self._request_with_retry(
                "POST",
                f"/api/teams/{quote(team_id, safe='')}/invites",
                {"email": email, "role": role},
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 52: team_list_invites
    # ==================================================================

    def team_list_invites(self, team_id: str) -> Dict[str, Any]:
        """List all pending invitations for a team.

        Args:
            team_id: UUID of the team.

        Returns:
            Dict with pending team invitations.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "GET", f"/api/teams/{quote(team_id, safe='')}/invites"
            )
            return result
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 53: team_cancel_invite
    # ==================================================================

    def team_cancel_invite(self, team_id: str, invite_id: str) -> Dict[str, Any]:
        """Cancel a pending team invitation.

        Args:
            team_id: UUID of the team.
            invite_id: UUID of the invitation to cancel.

        Returns:
            Dict confirming the invitation has been cancelled.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        err = _validate_uuid(invite_id, "invite_id")
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "DELETE",
                f"/api/teams/{quote(team_id, safe='')}/invites/{quote(invite_id, safe='')}",
            )
            return result if result else {"message": "Team invitation cancelled"}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Haystack Tool list
    # ==================================================================

    def get_tools(self) -> List[Any]:
        """Return list of Haystack Tool objects for all 53 Dominus Node functions.

        Each Tool wraps one of the toolkit methods with a name, description,
        and JSON Schema parameter definition compatible with Haystack's
        tool-calling pipeline.

        Returns:
            A list of ``haystack.tools.Tool`` objects.
        """
        from haystack.tools import Tool

        return [
            Tool(
                name="dominusnode_proxied_fetch",
                description=(
                    "Fetch a URL through Dominus Node's rotating proxy network. "
                    "Supports geo-targeting and datacenter/residential pool selection. "
                    "Only GET, HEAD, OPTIONS methods are allowed."
                ),
                function=self.proxied_fetch,
                parameters={
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "Target URL to fetch"},
                        "method": {
                            "type": "string",
                            "description": "HTTP method (GET/HEAD/OPTIONS)",
                            "default": "GET",
                        },
                        "country": {
                            "type": "string",
                            "description": "ISO 3166-1 alpha-2 country code for geo-targeting",
                        },
                        "proxy_type": {
                            "type": "string",
                            "description": "Proxy type: dc (datacenter, $3/GB) or residential ($5/GB)",
                            "default": "dc",
                        },
                    },
                    "required": ["url"],
                },
            ),
            Tool(
                name="dominusnode_check_balance",
                description="Check the current Dominus Node wallet balance in cents.",
                function=self.check_balance,
                parameters={
                    "type": "object",
                    "properties": {},
                },
            ),
            Tool(
                name="dominusnode_check_usage",
                description="Check Dominus Node proxy usage statistics for a given time period.",
                function=self.check_usage,
                parameters={
                    "type": "object",
                    "properties": {
                        "period": {
                            "type": "string",
                            "description": "Time period: day, week, or month",
                            "default": "month",
                        },
                    },
                },
            ),
            Tool(
                name="dominusnode_get_proxy_config",
                description="Get Dominus Node proxy configuration including endpoints and geo-targeting options.",
                function=self.get_proxy_config,
                parameters={
                    "type": "object",
                    "properties": {},
                },
            ),
            Tool(
                name="dominusnode_list_sessions",
                description="List active Dominus Node proxy sessions.",
                function=self.list_sessions,
                parameters={
                    "type": "object",
                    "properties": {},
                },
            ),
            Tool(
                name="dominusnode_create_agentic_wallet",
                description="Create a new agentic sub-wallet with a per-transaction spending limit.",
                function=self.create_agentic_wallet,
                parameters={
                    "type": "object",
                    "properties": {
                        "label": {
                            "type": "string",
                            "description": "Human-readable wallet label (max 100 chars)",
                        },
                        "spending_limit_cents": {
                            "type": "integer",
                            "description": "Per-transaction spending limit in cents",
                        },
                    },
                    "required": ["label", "spending_limit_cents"],
                },
            ),
            Tool(
                name="dominusnode_fund_agentic_wallet",
                description="Fund an agentic wallet from the main wallet.",
                function=self.fund_agentic_wallet,
                parameters={
                    "type": "object",
                    "properties": {
                        "wallet_id": {
                            "type": "string",
                            "description": "Agentic wallet ID",
                        },
                        "amount_cents": {
                            "type": "integer",
                            "description": "Amount to transfer in cents",
                        },
                    },
                    "required": ["wallet_id", "amount_cents"],
                },
            ),
            Tool(
                name="dominusnode_agentic_wallet_balance",
                description="Check the balance of an agentic wallet.",
                function=self.agentic_wallet_balance,
                parameters={
                    "type": "object",
                    "properties": {
                        "wallet_id": {
                            "type": "string",
                            "description": "Agentic wallet ID",
                        },
                    },
                    "required": ["wallet_id"],
                },
            ),
            Tool(
                name="dominusnode_list_agentic_wallets",
                description="List all agentic wallets.",
                function=self.list_agentic_wallets,
                parameters={
                    "type": "object",
                    "properties": {},
                },
            ),
            Tool(
                name="dominusnode_agentic_transactions",
                description="Get transaction history for an agentic wallet.",
                function=self.agentic_transactions,
                parameters={
                    "type": "object",
                    "properties": {
                        "wallet_id": {
                            "type": "string",
                            "description": "Agentic wallet ID",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Max number of transactions to return (1-100)",
                            "default": 20,
                        },
                    },
                    "required": ["wallet_id"],
                },
            ),
            Tool(
                name="dominusnode_freeze_agentic_wallet",
                description="Freeze an agentic wallet to prevent spending.",
                function=self.freeze_agentic_wallet,
                parameters={
                    "type": "object",
                    "properties": {
                        "wallet_id": {
                            "type": "string",
                            "description": "Agentic wallet ID",
                        },
                    },
                    "required": ["wallet_id"],
                },
            ),
            Tool(
                name="dominusnode_unfreeze_agentic_wallet",
                description="Unfreeze an agentic wallet to re-enable spending.",
                function=self.unfreeze_agentic_wallet,
                parameters={
                    "type": "object",
                    "properties": {
                        "wallet_id": {
                            "type": "string",
                            "description": "Agentic wallet ID",
                        },
                    },
                    "required": ["wallet_id"],
                },
            ),
            Tool(
                name="dominusnode_delete_agentic_wallet",
                description="Delete an agentic wallet (must be unfrozen first; remaining balance is refunded).",
                function=self.delete_agentic_wallet,
                parameters={
                    "type": "object",
                    "properties": {
                        "wallet_id": {
                            "type": "string",
                            "description": "Agentic wallet ID",
                        },
                    },
                    "required": ["wallet_id"],
                },
            ),
            Tool(
                name="dominusnode_create_team",
                description="Create a new team with a shared wallet.",
                function=self.create_team,
                parameters={
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Team name (max 100 chars)",
                        },
                        "max_members": {
                            "type": "integer",
                            "description": "Maximum number of team members (1-100)",
                        },
                    },
                    "required": ["name"],
                },
            ),
            Tool(
                name="dominusnode_list_teams",
                description="List all teams the user belongs to.",
                function=self.list_teams,
                parameters={
                    "type": "object",
                    "properties": {},
                },
            ),
            Tool(
                name="dominusnode_team_details",
                description="Get details for a specific team.",
                function=self.team_details,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID",
                        },
                    },
                    "required": ["team_id"],
                },
            ),
            Tool(
                name="dominusnode_team_fund",
                description="Fund a team's shared wallet from the user's personal wallet.",
                function=self.team_fund,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID",
                        },
                        "amount_cents": {
                            "type": "integer",
                            "description": "Amount to transfer in cents (100-1,000,000)",
                        },
                    },
                    "required": ["team_id", "amount_cents"],
                },
            ),
            Tool(
                name="dominusnode_team_create_key",
                description="Create a new API key for a team.",
                function=self.team_create_key,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID",
                        },
                        "label": {
                            "type": "string",
                            "description": "Key label (max 100 chars)",
                        },
                    },
                    "required": ["team_id", "label"],
                },
            ),
            Tool(
                name="dominusnode_team_usage",
                description="Get usage/transaction history for a team.",
                function=self.team_usage,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Max number of records to return (1-100)",
                            "default": 20,
                        },
                    },
                    "required": ["team_id"],
                },
            ),
            Tool(
                name="dominusnode_update_team",
                description="Update team settings (name and/or max_members).",
                function=self.update_team,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID",
                        },
                        "name": {
                            "type": "string",
                            "description": "New team name (max 100 chars)",
                        },
                        "max_members": {
                            "type": "integer",
                            "description": "New max members (1-100)",
                        },
                    },
                    "required": ["team_id"],
                },
            ),
            Tool(
                name="dominusnode_update_team_member_role",
                description="Update the role of a team member (member or admin).",
                function=self.update_team_member_role,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID",
                        },
                        "user_id": {
                            "type": "string",
                            "description": "User UUID",
                        },
                        "role": {
                            "type": "string",
                            "description": "New role: member or admin",
                        },
                    },
                    "required": ["team_id", "user_id", "role"],
                },
            ),
            Tool(
                name="dominusnode_x402_info",
                description=(
                    "Get x402 micropayment protocol information including "
                    "supported facilitators, pricing, and payment options."
                ),
                function=self.x402_info,
                parameters={
                    "type": "object",
                    "properties": {},
                },
            ),
            Tool(
                name="dominusnode_topup_paypal",
                description="Create a PayPal wallet top-up order. Minimum $5.00 (500 cents).",
                function=self.topup_paypal,
                parameters={
                    "type": "object",
                    "properties": {
                        "amount_cents": {
                            "type": "integer",
                            "description": "Amount to top up in cents (500-1,000,000)",
                        },
                    },
                    "required": ["amount_cents"],
                },
            ),
            Tool(
                name="dominusnode_topup_stripe",
                description="Create a Stripe checkout session for wallet top-up. Minimum $5.00 (500 cents).",
                function=self.topup_stripe,
                parameters={
                    "type": "object",
                    "properties": {
                        "amount_cents": {
                            "type": "integer",
                            "description": "Amount to top up in cents (500-100,000)",
                        },
                    },
                    "required": ["amount_cents"],
                },
            ),
            Tool(
                name="dominusnode_topup_crypto",
                description="Create a crypto payment invoice for wallet top-up. Supports BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK.",
                function=self.topup_crypto,
                parameters={
                    "type": "object",
                    "properties": {
                        "amount_usd": {
                            "type": "number",
                            "description": "Amount in USD (5-1,000)",
                        },
                        "currency": {
                            "type": "string",
                            "description": "Crypto currency (BTC/ETH/LTC/XMR/ZEC/USDC/SOL/USDT/DAI/BNB/LINK)",
                        },
                    },
                    "required": ["amount_usd", "currency"],
                },
            ),
            Tool(
                name="dominusnode_update_wallet_policy",
                description="Update an agentic wallet's policy (daily limit and/or allowed domains).",
                function=self.update_wallet_policy,
                parameters={
                    "type": "object",
                    "properties": {
                        "wallet_id": {
                            "type": "string",
                            "description": "Agentic wallet ID",
                        },
                        "daily_limit_cents": {
                            "type": "integer",
                            "description": "Daily budget cap in cents (1-1,000,000)",
                        },
                        "allowed_domains": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "List of allowed domains (max 100)",
                        },
                    },
                    "required": ["wallet_id"],
                },
            ),
            # -- Tool 27: get_proxy_status --
            Tool(
                name="dominusnode_get_proxy_status",
                description=(
                    "Get the current status of the Dominus Node proxy gateway "
                    "including uptime, active connections, and pool health."
                ),
                function=self.get_proxy_status,
                parameters={
                    "type": "object",
                    "properties": {},
                },
            ),
            # -- Tool 28: get_transactions --
            Tool(
                name="dominusnode_get_transactions",
                description=(
                    "Get main wallet transaction history including top-ups, "
                    "usage charges, and refunds."
                ),
                function=self.get_transactions,
                parameters={
                    "type": "object",
                    "properties": {
                        "limit": {
                            "type": "integer",
                            "description": "Number of transactions to return (1-100)",
                            "default": 20,
                        },
                    },
                },
            ),
            # -- Tool 29: get_forecast --
            Tool(
                name="dominusnode_get_forecast",
                description=(
                    "Get a spending forecast based on recent usage patterns. "
                    "Shows projected balance depletion date and daily burn rate."
                ),
                function=self.get_forecast,
                parameters={
                    "type": "object",
                    "properties": {},
                },
            ),
            # -- Tool 30: check_payment --
            Tool(
                name="dominusnode_check_payment",
                description=(
                    "Check the status of a crypto payment invoice. "
                    "Use the invoice ID returned by topup_crypto."
                ),
                function=self.check_payment,
                parameters={
                    "type": "object",
                    "properties": {
                        "invoice_id": {
                            "type": "string",
                            "description": "Crypto invoice ID to check",
                        },
                    },
                    "required": ["invoice_id"],
                },
            ),
            # -- Tool 31: get_daily_usage --
            Tool(
                name="dominusnode_get_daily_usage",
                description=(
                    "Get daily bandwidth usage breakdown for the specified "
                    "number of days. Shows per-day bytes, cost, and request count."
                ),
                function=self.get_daily_usage,
                parameters={
                    "type": "object",
                    "properties": {
                        "days": {
                            "type": "integer",
                            "description": "Number of days to look back (1-90)",
                            "default": 7,
                        },
                    },
                },
            ),
            # -- Tool 32: get_top_hosts --
            Tool(
                name="dominusnode_get_top_hosts",
                description=(
                    "Get the top hosts by bandwidth usage. Shows which domains "
                    "consume the most proxy bandwidth."
                ),
                function=self.get_top_hosts,
                parameters={
                    "type": "object",
                    "properties": {
                        "limit": {
                            "type": "integer",
                            "description": "Number of top hosts to return (1-50)",
                            "default": 10,
                        },
                    },
                },
            ),
            # -- Tool 33: register_account --
            Tool(
                name="dominusnode_register_account",
                description=(
                    "Register a new Dominus Node account. "
                    "This is an unauthenticated endpoint -- no API key required."
                ),
                function=self.register_account,
                parameters={
                    "type": "object",
                    "properties": {
                        "email": {
                            "type": "string",
                            "description": "Email address for the new account",
                        },
                        "password": {
                            "type": "string",
                            "description": "Password (8-128 characters)",
                        },
                    },
                    "required": ["email", "password"],
                },
            ),
            # -- Tool 34: login_account --
            Tool(
                name="dominusnode_login_account",
                description=(
                    "Log in to a Dominus Node account and receive access/refresh tokens. "
                    "This is an unauthenticated endpoint -- no API key required."
                ),
                function=self.login_account,
                parameters={
                    "type": "object",
                    "properties": {
                        "email": {
                            "type": "string",
                            "description": "Account email address",
                        },
                        "password": {
                            "type": "string",
                            "description": "Account password (8-128 characters)",
                        },
                    },
                    "required": ["email", "password"],
                },
            ),
            # -- Tool 35: get_account_info --
            Tool(
                name="dominusnode_get_account_info",
                description=(
                    "Get your Dominus Node account information including email, "
                    "plan, verification status, and creation date."
                ),
                function=self.get_account_info,
                parameters={
                    "type": "object",
                    "properties": {},
                },
            ),
            # -- Tool 36: verify_email --
            Tool(
                name="dominusnode_verify_email",
                description=(
                    "Verify your email address using the code sent during registration. "
                    "This is an unauthenticated endpoint -- no API key required."
                ),
                function=self.verify_email,
                parameters={
                    "type": "object",
                    "properties": {
                        "email": {
                            "type": "string",
                            "description": "Email address to verify",
                        },
                        "code": {
                            "type": "string",
                            "description": "Verification code from email",
                        },
                    },
                    "required": ["email", "code"],
                },
            ),
            # -- Tool 37: resend_verification --
            Tool(
                name="dominusnode_resend_verification",
                description=(
                    "Resend the email verification code. Requires authentication."
                ),
                function=self.resend_verification,
                parameters={
                    "type": "object",
                    "properties": {},
                },
            ),
            # -- Tool 38: update_password --
            Tool(
                name="dominusnode_update_password",
                description=(
                    "Change your account password. Requires your current "
                    "password for verification."
                ),
                function=self.update_password,
                parameters={
                    "type": "object",
                    "properties": {
                        "current_password": {
                            "type": "string",
                            "description": "Your current password (8-128 characters)",
                        },
                        "new_password": {
                            "type": "string",
                            "description": "Your new password (8-128 characters)",
                        },
                    },
                    "required": ["current_password", "new_password"],
                },
            ),
            # -- Tool 39: list_keys --
            Tool(
                name="dominusnode_list_keys",
                description=(
                    "List all your personal API keys. Shows key prefix, "
                    "label, status, and creation date."
                ),
                function=self.list_keys,
                parameters={
                    "type": "object",
                    "properties": {},
                },
            ),
            # -- Tool 40: create_key --
            Tool(
                name="dominusnode_create_key",
                description=(
                    "Create a new personal API key. The full key is shown "
                    "only once -- save it immediately."
                ),
                function=self.create_key,
                parameters={
                    "type": "object",
                    "properties": {
                        "label": {
                            "type": "string",
                            "description": "Label for the API key (max 100 chars)",
                        },
                    },
                    "required": ["label"],
                },
            ),
            # -- Tool 41: revoke_key --
            Tool(
                name="dominusnode_revoke_key",
                description=(
                    "Revoke (delete) a personal API key. This immediately "
                    "invalidates the key."
                ),
                function=self.revoke_key,
                parameters={
                    "type": "object",
                    "properties": {
                        "key_id": {
                            "type": "string",
                            "description": "API key ID (UUID) to revoke",
                        },
                    },
                    "required": ["key_id"],
                },
            ),
            # -- Tool 42: get_plan --
            Tool(
                name="dominusnode_get_plan",
                description=(
                    "Get your current plan details including limits, "
                    "pricing, and features."
                ),
                function=self.get_plan,
                parameters={
                    "type": "object",
                    "properties": {},
                },
            ),
            # -- Tool 43: list_plans --
            Tool(
                name="dominusnode_list_plans",
                description="List all available plans with pricing, limits, and features.",
                function=self.list_plans,
                parameters={
                    "type": "object",
                    "properties": {},
                },
            ),
            # -- Tool 44: change_plan --
            Tool(
                name="dominusnode_change_plan",
                description=(
                    "Change your account plan. Use list_plans to see "
                    "available options first."
                ),
                function=self.change_plan,
                parameters={
                    "type": "object",
                    "properties": {
                        "plan": {
                            "type": "string",
                            "description": "Plan name/ID to switch to",
                        },
                    },
                    "required": ["plan"],
                },
            ),
            # -- Tool 45: team_delete --
            Tool(
                name="dominusnode_team_delete",
                description=(
                    "Delete a team. Only the team owner can delete a team. "
                    "Any remaining balance is refunded."
                ),
                function=self.team_delete,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID to delete",
                        },
                    },
                    "required": ["team_id"],
                },
            ),
            # -- Tool 46: team_revoke_key --
            Tool(
                name="dominusnode_team_revoke_key",
                description=(
                    "Revoke a shared API key for a team. Only owners and "
                    "admins can revoke keys."
                ),
                function=self.team_revoke_key,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID",
                        },
                        "key_id": {
                            "type": "string",
                            "description": "API key ID (UUID) to revoke",
                        },
                    },
                    "required": ["team_id", "key_id"],
                },
            ),
            # -- Tool 47: team_list_keys --
            Tool(
                name="dominusnode_team_list_keys",
                description=(
                    "List all API keys for a team. Shows key prefix, "
                    "label, status, and creation date."
                ),
                function=self.team_list_keys,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID",
                        },
                    },
                    "required": ["team_id"],
                },
            ),
            # -- Tool 48: team_list_members --
            Tool(
                name="dominusnode_team_list_members",
                description="List all members of a team with their roles and join dates.",
                function=self.team_list_members,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID",
                        },
                    },
                    "required": ["team_id"],
                },
            ),
            # -- Tool 49: team_add_member --
            Tool(
                name="dominusnode_team_add_member",
                description=(
                    "Add a member directly to a team by user ID. Only owners "
                    "and admins can add members."
                ),
                function=self.team_add_member,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID",
                        },
                        "user_id": {
                            "type": "string",
                            "description": "User UUID of the person to add",
                        },
                        "role": {
                            "type": "string",
                            "description": "Role: member or admin",
                            "default": "member",
                        },
                    },
                    "required": ["team_id", "user_id"],
                },
            ),
            # -- Tool 50: team_remove_member --
            Tool(
                name="dominusnode_team_remove_member",
                description=(
                    "Remove a member from a team. Only owners and admins "
                    "can remove members."
                ),
                function=self.team_remove_member,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID",
                        },
                        "user_id": {
                            "type": "string",
                            "description": "User UUID of the member to remove",
                        },
                    },
                    "required": ["team_id", "user_id"],
                },
            ),
            # -- Tool 51: team_invite_member --
            Tool(
                name="dominusnode_team_invite_member",
                description=(
                    "Send an invitation to join a team by email. The invitee "
                    "receives an email with a link to accept."
                ),
                function=self.team_invite_member,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID",
                        },
                        "email": {
                            "type": "string",
                            "description": "Email address of the person to invite",
                        },
                        "role": {
                            "type": "string",
                            "description": "Role: member or admin",
                            "default": "member",
                        },
                    },
                    "required": ["team_id", "email"],
                },
            ),
            # -- Tool 52: team_list_invites --
            Tool(
                name="dominusnode_team_list_invites",
                description="List all pending invitations for a team.",
                function=self.team_list_invites,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID",
                        },
                    },
                    "required": ["team_id"],
                },
            ),
            # -- Tool 53: team_cancel_invite --
            Tool(
                name="dominusnode_team_cancel_invite",
                description=(
                    "Cancel a pending team invitation. Only owners and "
                    "admins can cancel invites."
                ),
                function=self.team_cancel_invite,
                parameters={
                    "type": "object",
                    "properties": {
                        "team_id": {
                            "type": "string",
                            "description": "Team UUID",
                        },
                        "invite_id": {
                            "type": "string",
                            "description": "Invite ID (UUID) to cancel",
                        },
                    },
                    "required": ["team_id", "invite_id"],
                },
            ),
        ]
