"""Dominus Node Semantic Kernel plugin -- 53 proxy, wallet, team, and payment management functions.

Provides a Semantic Kernel plugin class that exposes 53 kernel functions for
interacting with the Dominus Node rotating proxy-as-a-service platform.

Functions cover:
  - Proxied HTTP fetching through rotating proxies
  - Wallet balance, transactions, forecast, and usage monitoring
  - Proxy configuration, status, and session listing
  - Account management (register, login, verify email, change password)
  - API key management (list, create, revoke)
  - Plan management (get, list, change)
  - Agentic wallet management (create, fund, freeze, unfreeze, delete, policy)
  - Team management (create, list, fund, keys, usage, update, role changes,
    members, invites, delete)
  - x402 micropayment protocol information
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

    import semantic_kernel as sk
    from dominusnode_semantic_kernel import DominusNodePlugin

    kernel = sk.Kernel()
    plugin = DominusNodePlugin(api_key="dn_live_...")
    kernel.add_plugin(plugin, plugin_name="dominusnode")

    result = await kernel.invoke(plugin.check_balance)

Requires: httpx (``pip install httpx``), semantic-kernel (``pip install semantic-kernel``)
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
from semantic_kernel.functions import kernel_function

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


# ===========================================================================
# DominusNodePlugin -- Semantic Kernel plugin class
# ===========================================================================


class DominusNodePlugin:
    """Semantic Kernel plugin providing Dominus Node rotating proxy functions.

    Authenticates using a Dominus Node API key and exposes 53 kernel functions for
    proxy, wallet, account, API key, plan, team, and payment management.  All
    functions return JSON strings suitable for consumption by an LLM.

    Args:
        api_key: Dominus Node API key (``dn_live_...`` or ``dn_test_...``).
            Falls back to ``DOMINUSNODE_API_KEY`` environment variable.
        base_url: Base URL of the Dominus Node REST API.
        proxy_host: Hostname of the Dominus Node proxy gateway.
        proxy_port: Port of the Dominus Node proxy gateway.
        timeout: HTTP request timeout in seconds.

    Example::

        import semantic_kernel as sk
        from dominusnode_semantic_kernel import DominusNodePlugin

        kernel = sk.Kernel()
        plugin = DominusNodePlugin(api_key="dn_live_abc123")
        kernel.add_plugin(plugin, plugin_name="dominusnode")
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
            "User-Agent": "dominusnode-semantic-kernel/1.0.0",
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
        """Ensure the plugin is authenticated, authenticating if needed."""
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
                "User-Agent": "dominusnode-semantic-kernel/1.0.0",
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
    # Unauthenticated API request helper
    # ------------------------------------------------------------------

    def _unauth_request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Make an unauthenticated API request to the Dominus Node REST API.

        Used for public endpoints such as register, login, and verify-email.

        Args:
            method: HTTP method (GET, POST).
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
            req_headers: Dict[str, str] = {
                "User-Agent": "dominusnode-semantic-kernel/1.0.0",
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
    # Function 1: proxied_fetch
    # ==================================================================

    @kernel_function(
        name="proxied_fetch",
        description="Fetch a URL through Dominus Node's rotating proxy network with geo-targeting",
    )
    def proxied_fetch(
        self,
        url: str,
        method: str = "GET",
        country: str = "",
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
    # Function 2: check_balance
    # ==================================================================

    @kernel_function(
        name="check_balance",
        description="Check Dominus Node wallet balance in cents",
    )
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
    # Function 3: check_usage
    # ==================================================================

    @kernel_function(
        name="check_usage",
        description="Check proxy usage statistics for a time period (day, week, or month)",
    )
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
    # Function 4: get_proxy_config
    # ==================================================================

    @kernel_function(
        name="get_proxy_config",
        description="Get proxy configuration including endpoints and geo-targeting options",
    )
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
    # Function 5: list_sessions
    # ==================================================================

    @kernel_function(
        name="list_sessions",
        description="List active proxy sessions",
    )
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
    # Function 6: create_agentic_wallet
    # ==================================================================

    @kernel_function(
        name="create_agentic_wallet",
        description="Create a new agentic sub-wallet with a per-transaction spending limit",
    )
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
    # Function 7: fund_agentic_wallet
    # ==================================================================

    @kernel_function(
        name="fund_agentic_wallet",
        description="Fund an agentic wallet from the main wallet",
    )
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
    # Function 8: agentic_wallet_balance
    # ==================================================================

    @kernel_function(
        name="agentic_wallet_balance",
        description="Check the balance of an agentic sub-wallet",
    )
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
    # Function 9: list_agentic_wallets
    # ==================================================================

    @kernel_function(
        name="list_agentic_wallets",
        description="List all agentic sub-wallets",
    )
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
    # Function 10: agentic_transactions
    # ==================================================================

    @kernel_function(
        name="agentic_transactions",
        description="Get transaction history for an agentic wallet",
    )
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
    # Function 11: freeze_agentic_wallet
    # ==================================================================

    @kernel_function(
        name="freeze_agentic_wallet",
        description="Freeze an agentic wallet to prevent spending",
    )
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
    # Function 12: unfreeze_agentic_wallet
    # ==================================================================

    @kernel_function(
        name="unfreeze_agentic_wallet",
        description="Unfreeze an agentic wallet to re-enable spending",
    )
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
    # Function 13: delete_agentic_wallet
    # ==================================================================

    @kernel_function(
        name="delete_agentic_wallet",
        description="Delete an agentic wallet (must be unfrozen; refunds remaining balance)",
    )
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
    # Function 14: create_team
    # ==================================================================

    @kernel_function(
        name="create_team",
        description="Create a new team with a shared wallet for collaborative proxy usage",
    )
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
    # Function 15: list_teams
    # ==================================================================

    @kernel_function(
        name="list_teams",
        description="List all teams the user belongs to",
    )
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
    # Function 16: team_details
    # ==================================================================

    @kernel_function(
        name="team_details",
        description="Get details for a specific team including members and wallet",
    )
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
    # Function 17: team_fund
    # ==================================================================

    @kernel_function(
        name="team_fund",
        description="Fund a team's shared wallet from the user's personal wallet",
    )
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
    # Function 18: team_create_key
    # ==================================================================

    @kernel_function(
        name="team_create_key",
        description="Create a new API key for a team",
    )
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
    # Function 19: team_usage
    # ==================================================================

    @kernel_function(
        name="team_usage",
        description="Get usage and transaction history for a team",
    )
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
    # Function 20: update_team
    # ==================================================================

    @kernel_function(
        name="update_team",
        description="Update team settings such as name and maximum member count",
    )
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
    # Function 21: update_team_member_role
    # ==================================================================

    @kernel_function(
        name="update_team_member_role",
        description="Update the role of a team member (member or admin)",
    )
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
    # Function 22: x402_info
    # ==================================================================

    @kernel_function(
        name="x402_info",
        description="Get x402 micropayment protocol information including facilitators, pricing, and payment options",
    )
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
    # Function 23: topup_paypal
    # ==================================================================

    @kernel_function(
        name="topup_paypal",
        description="Create a PayPal top-up order for the user's wallet (minimum $5.00)",
    )
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
    # Function 24: topup_stripe
    # ==================================================================

    @kernel_function(
        name="topup_stripe",
        description="Create a Stripe checkout session for wallet top-up (minimum $5.00)",
    )
    def topup_stripe(self, amount_cents: int) -> str:
        """Create a Stripe checkout session for wallet top-up.

        Args:
            amount_cents: Amount to top up in cents (500 to 100,000).
                Minimum $5.00 (500 cents).

        Returns:
            JSON string with ``sessionId`` and ``checkoutUrl`` for completing
            the Stripe checkout flow.
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
    # Function 25: topup_crypto
    # ==================================================================

    _VALID_CRYPTO_CURRENCIES: Set[str] = {
        "btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai",
        "bnb", "link",
    }

    @kernel_function(
        name="topup_crypto",
        description="Create a crypto invoice for wallet top-up via NOWPayments (BTC, ETH, etc.)",
    )
    def topup_crypto(self, amount_usd: float, currency: str) -> str:
        """Create a crypto invoice for wallet top-up via NOWPayments.

        Args:
            amount_usd: Amount in USD (5 to 1,000).
            currency: Cryptocurrency to pay with. One of: BTC, ETH, LTC,
                XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK.

        Returns:
            JSON string with ``invoiceId`` and ``paymentUrl`` for completing
            the crypto payment.
        """
        if not isinstance(amount_usd, (int, float)) or isinstance(amount_usd, bool):
            return json.dumps({"error": "amount_usd must be a number between 5 and 1000"})
        if not math.isfinite(amount_usd):
            return json.dumps({"error": "amount_usd must be a number between 5 and 1000"})
        if amount_usd < 5 or amount_usd > 1000:
            return json.dumps({"error": "amount_usd must be a number between 5 and 1000"})

        if not isinstance(currency, str) or currency.lower() not in self._VALID_CRYPTO_CURRENCIES:
            return json.dumps({
                "error": (
                    "currency must be one of: "
                    "BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK"
                )
            })

        try:
            result = self._request_with_retry(
                "POST",
                "/api/wallet/topup/crypto",
                {"amountUsd": amount_usd, "currency": currency.lower()},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 26: update_wallet_policy
    # ==================================================================

    @kernel_function(
        name="update_wallet_policy",
        description="Update the policy of an agentic wallet (daily limit and/or allowed domains)",
    )
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
    # Function 27: get_proxy_status
    # ==================================================================

    @kernel_function(
        name="get_proxy_status",
        description="Get the current proxy gateway status including pool health and active connections",
    )
    def get_proxy_status(self) -> str:
        """Get the current proxy gateway status.

        Returns:
            JSON string with proxy status (pool health, active connections).
        """
        try:
            result = self._request_with_retry("GET", "/api/proxy/status")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 28: get_transactions
    # ==================================================================

    @kernel_function(
        name="get_transactions",
        description="Get wallet transaction history with an optional limit",
    )
    def get_transactions(self, limit: int = 20) -> str:
        """Get wallet transaction history.

        Args:
            limit: Maximum number of transactions to return (1-100, default 20).

        Returns:
            JSON string with transaction history.
        """
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
            return json.dumps(
                {"error": "limit must be an integer between 1 and 100"}
            )

        qs = f"?limit={limit}" if limit != 20 else ""

        try:
            result = self._request_with_retry(
                "GET", f"/api/wallet/transactions{qs}"
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 29: get_forecast
    # ==================================================================

    @kernel_function(
        name="get_forecast",
        description="Get wallet balance forecast based on current usage trends",
    )
    def get_forecast(self) -> str:
        """Get wallet balance forecast based on current usage trends.

        Returns:
            JSON string with forecast data (projected depletion date, daily burn rate).
        """
        try:
            result = self._request_with_retry("GET", "/api/wallet/forecast")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 30: check_payment
    # ==================================================================

    @kernel_function(
        name="check_payment",
        description="Check the status of a crypto top-up payment by invoice ID",
    )
    def check_payment(self, payment_id: str) -> str:
        """Check the status of a crypto top-up payment.

        Args:
            payment_id: The crypto invoice/payment ID to check.

        Returns:
            JSON string with payment status details.
        """
        if not payment_id or not isinstance(payment_id, str):
            return json.dumps({"error": "payment_id is required and must be a string"})

        if len(payment_id) > 200:
            return json.dumps({"error": "payment_id is too long"})

        try:
            result = self._request_with_retry(
                "GET",
                f"/api/wallet/topup/crypto/{quote(payment_id, safe='')}/status",
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 31: get_daily_usage
    # ==================================================================

    @kernel_function(
        name="get_daily_usage",
        description="Get daily usage breakdown for a specified number of days",
    )
    def get_daily_usage(self, days: int = 7) -> str:
        """Get daily usage breakdown.

        Args:
            days: Number of days to retrieve (1-90, default 7).

        Returns:
            JSON string with daily usage data.
        """
        if not isinstance(days, int) or isinstance(days, bool) or days < 1 or days > 90:
            return json.dumps(
                {"error": "days must be an integer between 1 and 90"}
            )

        try:
            result = self._request_with_retry(
                "GET", f"/api/usage/daily?days={days}"
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 32: get_top_hosts
    # ==================================================================

    @kernel_function(
        name="get_top_hosts",
        description="Get the top-accessed hosts by bandwidth usage",
    )
    def get_top_hosts(self, limit: int = 10) -> str:
        """Get the top-accessed hosts by bandwidth usage.

        Args:
            limit: Maximum number of hosts to return (1-100, default 10).

        Returns:
            JSON string with top hosts ranked by bandwidth.
        """
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
            return json.dumps(
                {"error": "limit must be an integer between 1 and 100"}
            )

        try:
            result = self._request_with_retry(
                "GET", f"/api/usage/top-hosts?limit={limit}"
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 33: register
    # ==================================================================

    @kernel_function(
        name="register",
        description="Register a new Dominus Node account (unauthenticated)",
    )
    def register(self, email: str, password: str) -> str:
        """Register a new Dominus Node account.

        This is an unauthenticated endpoint. After registration, verify the
        email address using the ``verify_email`` function.

        Args:
            email: Email address for the new account.
            password: Password (minimum 8 characters).

        Returns:
            JSON string with registration result.
        """
        if not email or not isinstance(email, str):
            return json.dumps({"error": "email is required and must be a string"})
        if len(email) > 254:
            return json.dumps({"error": "email must be 254 characters or fewer"})

        if not password or not isinstance(password, str):
            return json.dumps({"error": "password is required and must be a string"})
        if len(password) < 8:
            return json.dumps({"error": "password must be at least 8 characters"})
        if len(password) > 128:
            return json.dumps({"error": "password must be 128 characters or fewer"})

        try:
            body: dict = {"email": email, "password": password}
            pow_result = _solve_pow(self.base_url)
            if pow_result:
                body["pow"] = pow_result
            result = self._unauth_request(
                "POST",
                "/api/auth/register",
                body,
            )
            if pow_result and isinstance(result, dict):
                result["_pow_verified"] = True
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 34: login
    # ==================================================================

    @kernel_function(
        name="login",
        description="Log in to a Dominus Node account and obtain a JWT token (unauthenticated)",
    )
    def login(self, email: str, password: str) -> str:
        """Log in to a Dominus Node account.

        This is an unauthenticated endpoint. On success, stores the JWT
        token for subsequent authenticated requests.

        Args:
            email: Account email address.
            password: Account password.

        Returns:
            JSON string with login result (token, user info). If MFA is
            required, returns ``mfaRequired: true`` with a challenge token.
        """
        if not email or not isinstance(email, str):
            return json.dumps({"error": "email is required and must be a string"})
        if len(email) > 254:
            return json.dumps({"error": "email must be 254 characters or fewer"})

        if not password or not isinstance(password, str):
            return json.dumps({"error": "password is required and must be a string"})
        if len(password) > 128:
            return json.dumps({"error": "password must be 128 characters or fewer"})

        try:
            result = self._unauth_request(
                "POST",
                "/api/auth/login",
                {"email": email, "password": password},
            )
            # Detect MFA response
            if isinstance(result, dict) and result.get("mfaRequired"):
                return json.dumps(result)
            # Store token if returned
            if isinstance(result, dict) and result.get("token"):
                self._token = result["token"]
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 35: get_account_info
    # ==================================================================

    @kernel_function(
        name="get_account_info",
        description="Get the current authenticated user's account information",
    )
    def get_account_info(self) -> str:
        """Get the current authenticated user's account information.

        Returns:
            JSON string with account details (email, plan, status, etc.).
        """
        try:
            result = self._request_with_retry("GET", "/api/auth/me")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 36: verify_email
    # ==================================================================

    @kernel_function(
        name="verify_email",
        description="Verify an email address using a verification token (unauthenticated)",
    )
    def verify_email(self, token: str) -> str:
        """Verify an email address using a verification token.

        This is an unauthenticated endpoint. The token is sent to the
        user's email after registration.

        Args:
            token: The email verification token.

        Returns:
            JSON string confirming email verification.
        """
        if not token or not isinstance(token, str):
            return json.dumps({"error": "token is required and must be a string"})
        if len(token) > 512:
            return json.dumps({"error": "token is too long"})

        try:
            result = self._unauth_request(
                "POST",
                "/api/auth/verify-email",
                {"token": token},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 37: resend_verification
    # ==================================================================

    @kernel_function(
        name="resend_verification",
        description="Resend the email verification link to the authenticated user's email",
    )
    def resend_verification(self) -> str:
        """Resend the email verification link.

        Returns:
            JSON string confirming the verification email was resent.
        """
        try:
            result = self._request_with_retry(
                "POST", "/api/auth/resend-verification"
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 38: update_password
    # ==================================================================

    @kernel_function(
        name="update_password",
        description="Update the authenticated user's password",
    )
    def update_password(
        self, current_password: str, new_password: str
    ) -> str:
        """Update the authenticated user's password.

        Args:
            current_password: The user's current password.
            new_password: The new password (minimum 8 characters).

        Returns:
            JSON string confirming the password was updated.
        """
        if not current_password or not isinstance(current_password, str):
            return json.dumps({"error": "current_password is required and must be a string"})
        if len(current_password) > 128:
            return json.dumps({"error": "current_password must be 128 characters or fewer"})

        if not new_password or not isinstance(new_password, str):
            return json.dumps({"error": "new_password is required and must be a string"})
        if len(new_password) < 8:
            return json.dumps({"error": "new_password must be at least 8 characters"})
        if len(new_password) > 128:
            return json.dumps({"error": "new_password must be 128 characters or fewer"})

        try:
            result = self._request_with_retry(
                "POST",
                "/api/auth/change-password",
                {
                    "currentPassword": current_password,
                    "newPassword": new_password,
                },
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 39: list_keys
    # ==================================================================

    @kernel_function(
        name="list_keys",
        description="List all API keys for the authenticated user",
    )
    def list_keys(self) -> str:
        """List all API keys for the authenticated user.

        Returns:
            JSON string with a list of API keys (key hashes, labels, dates).
        """
        try:
            result = self._request_with_retry("GET", "/api/keys")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 40: create_key
    # ==================================================================

    @kernel_function(
        name="create_key",
        description="Create a new API key for the authenticated user",
    )
    def create_key(self, label: str = "") -> str:
        """Create a new API key for the authenticated user.

        Args:
            label: Optional human-readable label for the key (max 100 chars).

        Returns:
            JSON string with the created API key (shown once, store securely).
        """
        if label:
            err = _validate_label(label, "label")
            if err:
                return json.dumps({"error": err})

        try:
            body: Dict[str, Any] = {}
            if label:
                body["label"] = label
            result = self._request_with_retry("POST", "/api/keys", body)
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 41: revoke_key
    # ==================================================================

    @kernel_function(
        name="revoke_key",
        description="Revoke (delete) an API key by its ID",
    )
    def revoke_key(self, key_id: str) -> str:
        """Revoke (delete) an API key.

        Args:
            key_id: UUID of the API key to revoke.

        Returns:
            JSON string confirming key revocation.
        """
        err = _validate_uuid(key_id, "key_id")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "DELETE", f"/api/keys/{quote(key_id, safe='')}"
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 42: get_plan
    # ==================================================================

    @kernel_function(
        name="get_plan",
        description="Get the authenticated user's current plan details",
    )
    def get_plan(self) -> str:
        """Get the authenticated user's current plan.

        Returns:
            JSON string with plan details (name, limits, pricing).
        """
        try:
            result = self._request_with_retry("GET", "/api/plans/user/plan")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 43: list_plans
    # ==================================================================

    @kernel_function(
        name="list_plans",
        description="List all available subscription plans",
    )
    def list_plans(self) -> str:
        """List all available subscription plans.

        Returns:
            JSON string with a list of available plans and their features.
        """
        try:
            result = self._request_with_retry("GET", "/api/plans")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 44: change_plan
    # ==================================================================

    @kernel_function(
        name="change_plan",
        description="Change the authenticated user's subscription plan",
    )
    def change_plan(self, plan_id: str) -> str:
        """Change the authenticated user's subscription plan.

        Args:
            plan_id: UUID of the target plan.

        Returns:
            JSON string with updated plan details.
        """
        err = _validate_uuid(plan_id, "plan_id")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "PUT",
                "/api/plans/user/plan",
                {"planId": plan_id},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 45: team_delete
    # ==================================================================

    @kernel_function(
        name="team_delete",
        description="Delete a team (must be the team owner)",
    )
    def team_delete(self, team_id: str) -> str:
        """Delete a team.

        Only the team owner can delete a team. All team keys, members,
        and invites are removed.

        Args:
            team_id: UUID of the team to delete.

        Returns:
            JSON string confirming team deletion.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "DELETE", f"/api/teams/{quote(team_id, safe='')}"
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 46: team_revoke_key
    # ==================================================================

    @kernel_function(
        name="team_revoke_key",
        description="Revoke (delete) an API key from a team",
    )
    def team_revoke_key(self, team_id: str, key_id: str) -> str:
        """Revoke (delete) an API key from a team.

        Args:
            team_id: UUID of the team.
            key_id: UUID of the team API key to revoke.

        Returns:
            JSON string confirming key revocation.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        err = _validate_uuid(key_id, "key_id")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "DELETE",
                f"/api/teams/{quote(team_id, safe='')}/keys/{quote(key_id, safe='')}",
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 47: team_list_keys
    # ==================================================================

    @kernel_function(
        name="team_list_keys",
        description="List all API keys for a team",
    )
    def team_list_keys(self, team_id: str) -> str:
        """List all API keys for a team.

        Args:
            team_id: UUID of the team.

        Returns:
            JSON string with a list of team API keys.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "GET", f"/api/teams/{quote(team_id, safe='')}/keys"
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 48: team_list_members
    # ==================================================================

    @kernel_function(
        name="team_list_members",
        description="List all members of a team",
    )
    def team_list_members(self, team_id: str) -> str:
        """List all members of a team.

        Args:
            team_id: UUID of the team.

        Returns:
            JSON string with a list of team members and their roles.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "GET", f"/api/teams/{quote(team_id, safe='')}/members"
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 49: team_add_member
    # ==================================================================

    @kernel_function(
        name="team_add_member",
        description="Add a member to a team by user ID",
    )
    def team_add_member(
        self, team_id: str, user_id: str, role: str = "member"
    ) -> str:
        """Add a member to a team.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the user to add.
            role: Role for the new member (``member`` or ``admin``, default ``member``).

        Returns:
            JSON string confirming the member was added.
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
                "POST",
                f"/api/teams/{quote(team_id, safe='')}/members",
                {"userId": user_id, "role": role},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 50: team_remove_member
    # ==================================================================

    @kernel_function(
        name="team_remove_member",
        description="Remove a member from a team",
    )
    def team_remove_member(self, team_id: str, user_id: str) -> str:
        """Remove a member from a team.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the user to remove.

        Returns:
            JSON string confirming the member was removed.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        err = _validate_uuid(user_id, "user_id")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "DELETE",
                f"/api/teams/{quote(team_id, safe='')}/members/{quote(user_id, safe='')}",
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 51: team_invite_member
    # ==================================================================

    @kernel_function(
        name="team_invite_member",
        description="Invite a user to a team by email address",
    )
    def team_invite_member(
        self, team_id: str, email: str, role: str = "member"
    ) -> str:
        """Invite a user to a team by email.

        Args:
            team_id: UUID of the team.
            email: Email address of the user to invite.
            role: Role for the invited user (``member`` or ``admin``, default ``member``).

        Returns:
            JSON string with invite details.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        if not email or not isinstance(email, str):
            return json.dumps({"error": "email is required and must be a string"})
        if len(email) > 254:
            return json.dumps({"error": "email must be 254 characters or fewer"})

        if not role or not isinstance(role, str):
            return json.dumps({"error": "role is required and must be a string"})
        if role not in ("member", "admin"):
            return json.dumps({"error": "role must be 'member' or 'admin'"})

        try:
            result = self._request_with_retry(
                "POST",
                f"/api/teams/{quote(team_id, safe='')}/invites",
                {"email": email, "role": role},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 52: team_list_invites
    # ==================================================================

    @kernel_function(
        name="team_list_invites",
        description="List all pending invites for a team",
    )
    def team_list_invites(self, team_id: str) -> str:
        """List all pending invites for a team.

        Args:
            team_id: UUID of the team.

        Returns:
            JSON string with a list of pending team invites.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "GET", f"/api/teams/{quote(team_id, safe='')}/invites"
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Function 53: team_cancel_invite
    # ==================================================================

    @kernel_function(
        name="team_cancel_invite",
        description="Cancel a pending team invite",
    )
    def team_cancel_invite(self, team_id: str, invite_id: str) -> str:
        """Cancel a pending team invite.

        Args:
            team_id: UUID of the team.
            invite_id: UUID of the invite to cancel.

        Returns:
            JSON string confirming the invite was cancelled.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        err = _validate_uuid(invite_id, "invite_id")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "DELETE",
                f"/api/teams/{quote(team_id, safe='')}/invites/{quote(invite_id, safe='')}",
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})
