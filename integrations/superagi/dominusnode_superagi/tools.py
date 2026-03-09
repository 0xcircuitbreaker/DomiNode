"""Dominus Node SuperAGI tools -- 53 proxy, wallet, team, and payment management tools.

Provides SuperAGI-compatible tool classes that expose 53 tools for
interacting with the Dominus Node rotating proxy-as-a-service platform.

Tools cover:
  - Proxied HTTP fetching through rotating proxies
  - Wallet balance, transactions, forecast, and usage monitoring
  - Proxy configuration, status, and session listing
  - Agentic wallet management (create, fund, freeze, unfreeze, delete)
  - Team management (create, list, fund, keys, usage, update, role changes,
    members, invites, delete)
  - Account lifecycle (register, login, account info, email verification,
    password change)
  - API key management (list, create, revoke)
  - Plan management (get, list, change)
  - x402 micropayment info
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

Requires: httpx (``pip install httpx``)
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
from pydantic import BaseModel, Field

try:
    from superagi.tools.base_tool import BaseTool
except ImportError:
    # Standalone mode — SuperAGI framework not installed.
    # Provide a minimal stub so tool classes can be imported and instantiated.
    class BaseTool:  # type: ignore[no-redef]
        """Minimal BaseTool stub for standalone use without SuperAGI."""
        def __init__(self, **kwargs: Any) -> None:
            for k, v in kwargs.items():
                setattr(self, k, v)
        def _execute(self, **kwargs: Any) -> str:
            raise NotImplementedError("SuperAGI framework not installed")

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

_DOMAIN_RE = re.compile(
    r"^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$"
)

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


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


def _validate_allowed_domains(domains: Any) -> Optional[str]:
    """Validate allowed_domains list, returning error message or None."""
    if not isinstance(domains, list):
        return "allowed_domains must be a list of strings"
    if len(domains) > 100:
        return "allowed_domains must contain at most 100 entries"
    for i, domain in enumerate(domains):
        if not isinstance(domain, str):
            return f"allowed_domains[{i}] must be a string"
        if len(domain) > 253:
            return f"allowed_domains[{i}] exceeds maximum length of 253 characters"
        if not _DOMAIN_RE.match(domain):
            return f"allowed_domains[{i}] is not a valid domain format"
    return None


def _validate_email(email: Any, field_name: str = "email") -> Optional[str]:
    """Validate an email address, returning an error message or None."""
    if not email or not isinstance(email, str):
        return f"{field_name} is required and must be a string"
    email = email.strip()
    if not _EMAIL_RE.match(email):
        return f"{field_name} must be a valid email address"
    if len(email) > 254:
        return f"{field_name} exceeds maximum length of 254 characters"
    return None


def _validate_password(password: Any, field_name: str = "password") -> Optional[str]:
    """Validate a password string, returning an error message or None."""
    if not password or not isinstance(password, str):
        return f"{field_name} is required and must be a string"
    if len(password) < 8 or len(password) > 128:
        return f"{field_name} must be between 8 and 128 characters"
    return None


# ===========================================================================
# _DominusNodeClient -- shared HTTP client for all tools
# ===========================================================================


class _DominusNodeClient:
    """Shared HTTP client for all Dominus Node SuperAGI tools.

    Authenticates using a Dominus Node API key and provides methods for proxy,
    wallet, team, and payment management.  All methods return JSON strings
    suitable for consumption by an LLM.

    Uses a singleton pattern so all tools share the same authenticated session.
    """

    _instance: Optional[_DominusNodeClient] = None

    @classmethod
    def get_instance(
        cls,
        api_key: str | None = None,
        base_url: str | None = None,
        proxy_host: str | None = None,
        proxy_port: int | None = None,
        timeout: float = 30.0,
        agent_secret: str | None = None,
    ) -> _DominusNodeClient:
        """Get or create the singleton client instance."""
        if cls._instance is None:
            cls._instance = cls(
                api_key=api_key or "",
                base_url=base_url or "https://api.dominusnode.com",
                proxy_host=proxy_host or "proxy.dominusnode.com",
                proxy_port=proxy_port or 8080,
                timeout=timeout,
                agent_secret=agent_secret,
            )
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Reset the singleton (for testing)."""
        cls._instance = None

    def __init__(
        self,
        api_key: str,
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
            "User-Agent": "dominusnode-superagi/1.0.0",
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
        """Ensure the client is authenticated, authenticating if needed."""
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
                "User-Agent": "dominusnode-superagi/1.0.0",
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

    def _unauthenticated_request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Make an unauthenticated API request (for register, login, verify-email).

        Args:
            method: HTTP method.
            path: API path.
            body: Optional JSON body.

        Returns:
            Parsed JSON response (with dangerous keys stripped).
        """
        with httpx.Client(
            timeout=self.timeout,
            follow_redirects=False,
        ) as client:
            req_headers = {
                "User-Agent": "dominusnode-superagi/1.0.0",
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
    # Command 1: proxied_fetch
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
    # Command 2: check_balance
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
    # Command 3: check_usage
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
    # Command 4: get_proxy_config
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
    # Command 5: list_sessions
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
    # Command 6: create_agentic_wallet
    # ==================================================================

    def create_agentic_wallet(
        self,
        label: str,
        spending_limit_cents: int,
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[List[str]] = None,
    ) -> str:
        """Create a new agentic sub-wallet with a spending limit.

        Args:
            label: Human-readable label for the wallet (max 100 chars).
            spending_limit_cents: Per-transaction spending limit in cents.
            daily_limit_cents: Optional daily budget cap in cents (1 to 1,000,000).
            allowed_domains: Optional list of domains to restrict proxy usage
                (max 100 entries, each <= 253 chars, valid domain format).

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
            err = _validate_allowed_domains(allowed_domains)
            if err:
                return json.dumps({"error": err})

        body: Dict[str, Any] = {
            "label": label,
            "spendingLimitCents": spending_limit_cents,
        }
        if daily_limit_cents is not None:
            body["dailyLimitCents"] = daily_limit_cents
        if allowed_domains is not None:
            body["allowedDomains"] = allowed_domains

        try:
            result = self._request_with_retry("POST", "/api/agent-wallet", body)
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 7: fund_agentic_wallet
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
    # Command 8: agentic_wallet_balance
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
    # Command 9: list_agentic_wallets
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
    # Command 10: agentic_transactions
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
    # Command 11: freeze_agentic_wallet
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
    # Command 12: unfreeze_agentic_wallet
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
    # Command 13: delete_agentic_wallet
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
    # Command 14: update_wallet_policy
    # ==================================================================

    def update_wallet_policy(
        self,
        wallet_id: str,
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[List[str]] = None,
    ) -> str:
        """Update the policy for an agentic wallet.

        Args:
            wallet_id: UUID of the agentic wallet.
            daily_limit_cents: Optional daily budget cap in cents (1 to 1,000,000).
            allowed_domains: Optional list of domains to restrict proxy usage
                (max 100 entries, each <= 253 chars, valid domain format).

        Returns:
            JSON string with the updated wallet policy.
        """
        err = _validate_uuid(wallet_id, "wallet_id")
        if err:
            return json.dumps({"error": err})

        body: Dict[str, Any] = {}

        if daily_limit_cents is not None:
            err = _validate_positive_int(
                daily_limit_cents, "daily_limit_cents", max_value=1_000_000
            )
            if err:
                return json.dumps({"error": err})
            body["dailyLimitCents"] = daily_limit_cents

        if allowed_domains is not None:
            err = _validate_allowed_domains(allowed_domains)
            if err:
                return json.dumps({"error": err})
            body["allowedDomains"] = allowed_domains

        try:
            result = self._request_with_retry(
                "PATCH",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/policy",
                body,
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 15: create_team
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
    # Command 15: list_teams
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
    # Command 16: team_details
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
    # Command 17: team_fund
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
    # Command 18: team_create_key
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
    # Command 19: team_usage
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
    # Command 20: update_team
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
    # Command 21: update_team_member_role
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
    # Command 22: x402_info
    # ==================================================================

    def x402_info(self) -> str:
        """Get x402 micropayment protocol information.

        Returns:
            JSON string with x402 protocol information.
        """
        try:
            result = self._request_with_retry("GET", "/api/x402/info")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 23: topup_paypal
    # ==================================================================

    def topup_paypal(self, amount_cents: int) -> str:
        """Create a PayPal top-up order for the user's wallet.

        Args:
            amount_cents: Amount to top up in cents (500 to 1,000,000).
                Minimum $5.00 (500 cents).

        Returns:
            JSON string with ``orderId`` and ``approvalUrl``.
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
    # Command 24: topup_stripe
    # ==================================================================

    def topup_stripe(self, amount_cents: int) -> str:
        """Create a Stripe checkout session for wallet top-up.

        Args:
            amount_cents: Amount to top up in cents (500 to 100,000).
                Minimum $5.00 (500 cents).

        Returns:
            JSON string with ``sessionId`` and ``checkoutUrl``.
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
    # Command 25: topup_crypto
    # ==================================================================

    _VALID_CRYPTO_CURRENCIES: Set[str] = {
        "btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai",
        "bnb", "link",
    }

    def topup_crypto(self, amount_usd: float, currency: str) -> str:
        """Create a crypto invoice for wallet top-up via NOWPayments.

        Args:
            amount_usd: Amount in USD (5 to 1,000).
            currency: Cryptocurrency to pay with. One of: BTC, ETH, LTC,
                XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK.

        Returns:
            JSON string with ``invoiceId`` and ``paymentUrl``.
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
    # Command 26: get_proxy_status
    # ==================================================================

    def get_proxy_status(self) -> str:
        """Get the current status of the proxy gateway.

        Returns:
            JSON string with proxy gateway status, uptime, and pool health.
        """
        try:
            result = self._request_with_retry("GET", "/api/proxy/status")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 27: get_transactions
    # ==================================================================

    def get_transactions(self, limit: int = 20) -> str:
        """Get main wallet transaction history.

        Args:
            limit: Maximum number of transactions to return (1-100, default 20).

        Returns:
            JSON string with wallet transaction history.
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
    # Command 28: get_forecast
    # ==================================================================

    def get_forecast(self) -> str:
        """Get a spending forecast based on recent usage patterns.

        Returns:
            JSON string with projected balance depletion and daily burn rate.
        """
        try:
            result = self._request_with_retry("GET", "/api/wallet/forecast")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 29: check_payment
    # ==================================================================

    def check_payment(self, invoice_id: str) -> str:
        """Check the status of a crypto payment invoice.

        Args:
            invoice_id: Crypto invoice ID to check.

        Returns:
            JSON string with payment status details.
        """
        if not invoice_id or not isinstance(invoice_id, str):
            return json.dumps({"error": "invoice_id is required and must be a string"})
        invoice_id = invoice_id.strip()
        if len(invoice_id) == 0 or len(invoice_id) > 200:
            return json.dumps({"error": "invoice_id must be 1-200 characters"})
        if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in invoice_id):
            return json.dumps({"error": "invoice_id contains invalid control characters"})

        try:
            result = self._request_with_retry(
                "GET",
                f"/api/wallet/topup/crypto/{quote(invoice_id, safe='')}/status",
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 30: get_daily_usage
    # ==================================================================

    def get_daily_usage(self, days: int = 7) -> str:
        """Get daily bandwidth usage breakdown.

        Args:
            days: Number of days to look back (1-90, default 7).

        Returns:
            JSON string with per-day bandwidth, cost, and request counts.
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
    # Command 31: get_top_hosts
    # ==================================================================

    def get_top_hosts(self, limit: int = 10) -> str:
        """Get top hosts by bandwidth usage.

        Args:
            limit: Number of top hosts to return (1-100, default 10).

        Returns:
            JSON string with top hosts ranked by bandwidth consumption.
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
    # Command 32: register
    # ==================================================================

    def register(self, email: str, password: str) -> str:
        """Register a new Dominus Node account (unauthenticated).

        Args:
            email: Email address for the new account.
            password: Password (8-128 characters).

        Returns:
            JSON string with the created account info.
        """
        err = _validate_email(email, "email")
        if err:
            return json.dumps({"error": err})

        err = _validate_password(password, "password")
        if err:
            return json.dumps({"error": err})

        try:
            body: dict = {"email": email.strip(), "password": password}
            pow_result = _solve_pow(self.base_url)
            if pow_result:
                body["pow"] = pow_result
            result = self._unauthenticated_request(
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
    # Command 33: login
    # ==================================================================

    def login(self, email: str, password: str) -> str:
        """Log in to a Dominus Node account (unauthenticated).

        Args:
            email: Account email address.
            password: Account password (8-128 characters).

        Returns:
            JSON string with access/refresh tokens, or MFA required indicator.
        """
        err = _validate_email(email, "email")
        if err:
            return json.dumps({"error": err})

        err = _validate_password(password, "password")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._unauthenticated_request(
                "POST",
                "/api/auth/login",
                {"email": email.strip(), "password": password},
            )
            # Surface MFA requirement
            if isinstance(result, dict) and result.get("mfaRequired"):
                return json.dumps({
                    "mfaRequired": True,
                    "message": "Multi-factor authentication is required. Complete MFA to continue.",
                })
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 34: get_account_info
    # ==================================================================

    def get_account_info(self) -> str:
        """Get account information for the authenticated user.

        Returns:
            JSON string with account details (email, plan, status, etc.).
        """
        try:
            result = self._request_with_retry("GET", "/api/auth/me")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 35: verify_email
    # ==================================================================

    def verify_email(self, email: str, code: str) -> str:
        """Verify an email address using a verification code (unauthenticated).

        Args:
            email: Email address to verify.
            code: Verification code from email (max 100 chars).

        Returns:
            JSON string confirming verification.
        """
        err = _validate_email(email, "email")
        if err:
            return json.dumps({"error": err})

        if not code or not isinstance(code, str):
            return json.dumps({"error": "code is required and must be a string"})
        code = code.strip()
        if len(code) == 0 or len(code) > 100:
            return json.dumps({"error": "code must be 1-100 characters"})
        if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in code):
            return json.dumps({"error": "code contains invalid control characters"})

        try:
            result = self._unauthenticated_request(
                "POST",
                "/api/auth/verify-email",
                {"email": email.strip(), "code": code},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 36: resend_verification
    # ==================================================================

    def resend_verification(self) -> str:
        """Resend the email verification code (authenticated).

        Returns:
            JSON string confirming the verification email was resent.
        """
        try:
            result = self._request_with_retry("POST", "/api/auth/resend-verification")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 37: update_password
    # ==================================================================

    def update_password(self, current_password: str, new_password: str) -> str:
        """Change the account password (authenticated).

        Args:
            current_password: Current password (8-128 characters).
            new_password: New password (8-128 characters).

        Returns:
            JSON string confirming the password change.
        """
        err = _validate_password(current_password, "current_password")
        if err:
            return json.dumps({"error": err})

        err = _validate_password(new_password, "new_password")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "POST",
                "/api/auth/change-password",
                {"currentPassword": current_password, "newPassword": new_password},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 38: list_keys
    # ==================================================================

    def list_keys(self) -> str:
        """List all personal API keys.

        Returns:
            JSON string with a list of API keys (prefix, label, status).
        """
        try:
            result = self._request_with_retry("GET", "/api/keys")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 39: create_key
    # ==================================================================

    def create_key(self, label: str) -> str:
        """Create a new personal API key.

        Args:
            label: Human-readable label for the key (max 100 chars).

        Returns:
            JSON string with the created API key (shown once).
        """
        err = _validate_label(label, "label")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "POST", "/api/keys", {"label": label}
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 40: revoke_key
    # ==================================================================

    def revoke_key(self, key_id: str) -> str:
        """Revoke (delete) a personal API key.

        Args:
            key_id: UUID of the API key to revoke.

        Returns:
            JSON string confirming revocation.
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
    # Command 41: get_plan
    # ==================================================================

    def get_plan(self) -> str:
        """Get the current plan details for the authenticated user.

        Returns:
            JSON string with plan limits, pricing, and features.
        """
        try:
            result = self._request_with_retry("GET", "/api/plans/user/plan")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 42: list_plans
    # ==================================================================

    def list_plans(self) -> str:
        """List all available plans with pricing and limits.

        Returns:
            JSON string with a list of all available plans.
        """
        try:
            result = self._request_with_retry("GET", "/api/plans")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 43: change_plan
    # ==================================================================

    def change_plan(self, plan: str) -> str:
        """Change the account plan.

        Args:
            plan: Plan name/ID to switch to (max 100 chars).

        Returns:
            JSON string with the updated plan details.
        """
        err = _validate_label(plan, "plan")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "PUT", "/api/plans/user/plan", {"planId": plan}
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 44: team_delete
    # ==================================================================

    def team_delete(self, team_id: str) -> str:
        """Delete a team. Only the owner can delete. Remaining balance is refunded.

        Args:
            team_id: UUID of the team to delete.

        Returns:
            JSON string confirming deletion.
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
    # Command 45: team_revoke_key
    # ==================================================================

    def team_revoke_key(self, team_id: str, key_id: str) -> str:
        """Revoke a shared API key for a team.

        Args:
            team_id: UUID of the team.
            key_id: UUID of the API key to revoke.

        Returns:
            JSON string confirming revocation.
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
    # Command 46: team_list_keys
    # ==================================================================

    def team_list_keys(self, team_id: str) -> str:
        """List all API keys for a team.

        Args:
            team_id: UUID of the team.

        Returns:
            JSON string with the team's API keys.
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
    # Command 47: team_list_members
    # ==================================================================

    def team_list_members(self, team_id: str) -> str:
        """List all members of a team.

        Args:
            team_id: UUID of the team.

        Returns:
            JSON string with team members and their roles.
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
    # Command 48: team_add_member
    # ==================================================================

    def team_add_member(
        self, team_id: str, user_id: str, role: str = "member"
    ) -> str:
        """Add a member directly to a team by user ID.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the user to add.
            role: Role for the new member (``member`` or ``admin``).

        Returns:
            JSON string with the added member details.
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
    # Command 49: team_remove_member
    # ==================================================================

    def team_remove_member(self, team_id: str, user_id: str) -> str:
        """Remove a member from a team.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the member to remove.

        Returns:
            JSON string confirming removal.
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
    # Command 50: team_invite_member
    # ==================================================================

    def team_invite_member(
        self, team_id: str, email: str, role: str = "member"
    ) -> str:
        """Send an invitation to join a team by email.

        Args:
            team_id: UUID of the team.
            email: Email address of the person to invite.
            role: Role for the invited member (``member`` or ``admin``).

        Returns:
            JSON string with the created invitation details.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        err = _validate_email(email, "email")
        if err:
            return json.dumps({"error": err})

        if not role or not isinstance(role, str):
            return json.dumps({"error": "role is required and must be a string"})
        if role not in ("member", "admin"):
            return json.dumps({"error": "role must be 'member' or 'admin'"})

        try:
            result = self._request_with_retry(
                "POST",
                f"/api/teams/{quote(team_id, safe='')}/invites",
                {"email": email.strip(), "role": role},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 51: team_list_invites
    # ==================================================================

    def team_list_invites(self, team_id: str) -> str:
        """List all pending invitations for a team.

        Args:
            team_id: UUID of the team.

        Returns:
            JSON string with pending invitations.
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
    # Command 52: team_cancel_invite
    # ==================================================================

    def team_cancel_invite(self, team_id: str, invite_id: str) -> str:
        """Cancel a pending team invitation.

        Args:
            team_id: UUID of the team.
            invite_id: UUID of the invitation to cancel.

        Returns:
            JSON string confirming cancellation.
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


# ===========================================================================
# Pydantic Schemas for SuperAGI tool args
# ===========================================================================


class ProxiedFetchSchema(BaseModel):
    url: str = Field(description="Target URL to fetch through the rotating proxy network")
    method: str = Field(default="GET", description="HTTP method (GET, HEAD, or OPTIONS only)")
    country: str = Field(default="", description="ISO 3166-1 alpha-2 country code for geo-targeting (e.g. US, DE, JP)")
    proxy_type: str = Field(default="dc", description="Proxy type: 'dc' (datacenter $3/GB) or 'residential' ($5/GB)")


class BalanceSchema(BaseModel):
    pass


class UsageSchema(BaseModel):
    period: str = Field(default="month", description="Time period: 'day', 'week', or 'month'")


class ProxyConfigSchema(BaseModel):
    pass


class SessionsSchema(BaseModel):
    pass


class CreateAgenticWalletSchema(BaseModel):
    label: str = Field(description="Human-readable label for the wallet (max 100 chars)")
    spending_limit_cents: int = Field(description="Per-transaction spending limit in cents")
    daily_limit_cents: Optional[int] = Field(default=None, description="Optional daily budget cap in cents (1-1,000,000)")
    allowed_domains: Optional[List[str]] = Field(default=None, description="Optional list of allowed domains (max 100)")


class FundAgenticWalletSchema(BaseModel):
    wallet_id: str = Field(description="ID of the agentic wallet to fund")
    amount_cents: int = Field(description="Amount to transfer in cents")


class AgenticWalletBalanceSchema(BaseModel):
    wallet_id: str = Field(description="ID of the agentic wallet")


class ListAgenticWalletsSchema(BaseModel):
    pass


class AgenticTransactionsSchema(BaseModel):
    wallet_id: str = Field(description="ID of the agentic wallet")
    limit: int = Field(default=20, description="Max results to return (1-100)")


class FreezeAgenticWalletSchema(BaseModel):
    wallet_id: str = Field(description="ID of the agentic wallet to freeze")


class UnfreezeAgenticWalletSchema(BaseModel):
    wallet_id: str = Field(description="ID of the agentic wallet to unfreeze")


class DeleteAgenticWalletSchema(BaseModel):
    wallet_id: str = Field(description="ID of the agentic wallet to delete (must be unfrozen)")


class UpdateWalletPolicySchema(BaseModel):
    wallet_id: str = Field(description="UUID of the agentic wallet")
    daily_limit_cents: Optional[int] = Field(default=None, description="Daily budget cap in cents (1-1,000,000)")
    allowed_domains: Optional[List[str]] = Field(default=None, description="List of allowed domains (max 100)")


class CreateTeamSchema(BaseModel):
    name: str = Field(description="Team name (max 100 chars)")
    max_members: int = Field(default=0, description="Max team members (1-100, 0 for default)")


class ListTeamsSchema(BaseModel):
    pass


class TeamDetailsSchema(BaseModel):
    team_id: str = Field(description="UUID of the team")


class TeamFundSchema(BaseModel):
    team_id: str = Field(description="UUID of the team")
    amount_cents: int = Field(description="Amount to transfer in cents (100-1,000,000)")


class TeamCreateKeySchema(BaseModel):
    team_id: str = Field(description="UUID of the team")
    label: str = Field(description="Human-readable label for the API key (max 100 chars)")


class TeamUsageSchema(BaseModel):
    team_id: str = Field(description="UUID of the team")
    limit: int = Field(default=20, description="Max results to return (1-100)")


class UpdateTeamSchema(BaseModel):
    team_id: str = Field(description="UUID of the team")
    name: str = Field(default="", description="New team name (max 100 chars, empty to skip)")
    max_members: int = Field(default=0, description="New max members (1-100, 0 to skip)")


class UpdateTeamMemberRoleSchema(BaseModel):
    team_id: str = Field(description="UUID of the team")
    user_id: str = Field(description="UUID of the user whose role to change")
    role: str = Field(description="New role: 'member' or 'admin'")


class X402InfoSchema(BaseModel):
    pass


class TopupPaypalSchema(BaseModel):
    amount_cents: int = Field(description="Amount to top up in cents (minimum 500 = $5.00)")


class TopupStripeSchema(BaseModel):
    amount_cents: int = Field(description="Amount to top up in cents (500 to 100,000 = $5-$1,000)")


class TopupCryptoSchema(BaseModel):
    amount_usd: float = Field(description="Amount in USD to top up via crypto (5 to 1,000)")
    currency: str = Field(description="Cryptocurrency: BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, or LINK")


class ProxyStatusSchema(BaseModel):
    pass


class TransactionsSchema(BaseModel):
    limit: int = Field(default=20, description="Max transactions to return (1-100)")


class ForecastSchema(BaseModel):
    pass


class CheckPaymentSchema(BaseModel):
    invoice_id: str = Field(description="Crypto invoice ID to check")


class DailyUsageSchema(BaseModel):
    days: int = Field(default=7, description="Number of days to look back (1-90)")


class TopHostsSchema(BaseModel):
    limit: int = Field(default=10, description="Number of top hosts to return (1-100)")


class RegisterSchema(BaseModel):
    email: str = Field(description="Email address for the new account")
    password: str = Field(description="Password for the new account (8-128 characters)")


class LoginSchema(BaseModel):
    email: str = Field(description="Account email address")
    password: str = Field(description="Account password (8-128 characters)")


class AccountInfoSchema(BaseModel):
    pass


class VerifyEmailSchema(BaseModel):
    email: str = Field(description="Email address to verify")
    code: str = Field(description="Verification code from email (max 100 characters)")


class ResendVerificationSchema(BaseModel):
    pass


class UpdatePasswordSchema(BaseModel):
    current_password: str = Field(description="Your current password (8-128 characters)")
    new_password: str = Field(description="Your new password (8-128 characters)")


class ListKeysSchema(BaseModel):
    pass


class CreateKeySchema(BaseModel):
    label: str = Field(description="Human-readable label for the API key (max 100 chars)")


class RevokeKeySchema(BaseModel):
    key_id: str = Field(description="API key ID (UUID) to revoke")


class GetPlanSchema(BaseModel):
    pass


class ListPlansSchema(BaseModel):
    pass


class ChangePlanSchema(BaseModel):
    plan: str = Field(description="Plan name/ID to switch to (max 100 chars)")


class TeamDeleteSchema(BaseModel):
    team_id: str = Field(description="Team ID (UUID) to delete")


class TeamRevokeKeySchema(BaseModel):
    team_id: str = Field(description="Team ID (UUID)")
    key_id: str = Field(description="API key ID (UUID) to revoke")


class TeamListKeysSchema(BaseModel):
    team_id: str = Field(description="Team ID (UUID)")


class TeamListMembersSchema(BaseModel):
    team_id: str = Field(description="Team ID (UUID)")


class TeamAddMemberSchema(BaseModel):
    team_id: str = Field(description="Team ID (UUID)")
    user_id: str = Field(description="User ID (UUID) of the person to add")
    role: str = Field(default="member", description="Role for the new member: 'member' or 'admin'")


class TeamRemoveMemberSchema(BaseModel):
    team_id: str = Field(description="Team ID (UUID)")
    user_id: str = Field(description="User ID (UUID) of the member to remove")


class TeamInviteMemberSchema(BaseModel):
    team_id: str = Field(description="Team ID (UUID)")
    email: str = Field(description="Email address of the person to invite")
    role: str = Field(default="member", description="Role for the invited member: 'member' or 'admin'")


class TeamListInvitesSchema(BaseModel):
    team_id: str = Field(description="Team ID (UUID)")


class TeamCancelInviteSchema(BaseModel):
    team_id: str = Field(description="Team ID (UUID)")
    invite_id: str = Field(description="Invite ID (UUID) to cancel")


# ===========================================================================
# SuperAGI Tool Classes (53 tools)
# ===========================================================================


def _get_client(tool: BaseTool) -> _DominusNodeClient:
    """Get or create the shared client from tool config."""
    return _DominusNodeClient.get_instance(
        api_key=tool.get_tool_config("DOMINUSNODE_API_KEY"),
        base_url=tool.get_tool_config("DOMINUSNODE_BASE_URL") or "https://api.dominusnode.com",
        proxy_host=tool.get_tool_config("DOMINUSNODE_PROXY_HOST") or "proxy.dominusnode.com",
        proxy_port=int(tool.get_tool_config("DOMINUSNODE_PROXY_PORT") or "8080"),
    )


class DominusNodeProxiedFetchTool(BaseTool):
    """Fetch a URL through Dominus Node's rotating proxy network."""

    name: str = "Dominus Node Proxied Fetch"
    description: str = (
        "Fetch a URL through Dominus Node's rotating proxy network with "
        "geo-targeting support. Datacenter proxies cost $3/GB, residential $5/GB. "
        "Only GET, HEAD, OPTIONS methods are allowed."
    )
    args_schema: type[BaseModel] = ProxiedFetchSchema

    def _execute(
        self,
        url: str,
        method: str = "GET",
        country: str = "",
        proxy_type: str = "dc",
    ) -> str:
        client = _get_client(self)
        return client.proxied_fetch(
            url=url,
            method=method,
            country=country or None,
            proxy_type=proxy_type,
        )


class DominusNodeBalanceTool(BaseTool):
    """Check the current Dominus Node wallet balance."""

    name: str = "Dominus Node Check Balance"
    description: str = "Check your current Dominus Node wallet balance in cents."
    args_schema: type[BaseModel] = BalanceSchema

    def _execute(self) -> str:
        client = _get_client(self)
        return client.check_balance()


class DominusNodeUsageTool(BaseTool):
    """Check Dominus Node proxy usage statistics."""

    name: str = "Dominus Node Check Usage"
    description: str = (
        "Check proxy usage statistics for a given time period. "
        "Returns bandwidth consumed, cost, and request counts."
    )
    args_schema: type[BaseModel] = UsageSchema

    def _execute(self, period: str = "month") -> str:
        client = _get_client(self)
        return client.check_usage(period=period)


class DominusNodeProxyConfigTool(BaseTool):
    """Get Dominus Node proxy configuration."""

    name: str = "Dominus Node Proxy Config"
    description: str = (
        "Get proxy configuration including endpoints, supported geo-targeting "
        "countries, and available proxy types."
    )
    args_schema: type[BaseModel] = ProxyConfigSchema

    def _execute(self) -> str:
        client = _get_client(self)
        return client.get_proxy_config()


class DominusNodeSessionsTool(BaseTool):
    """List active Dominus Node proxy sessions."""

    name: str = "Dominus Node List Sessions"
    description: str = "List all currently active proxy sessions with their usage details."
    args_schema: type[BaseModel] = SessionsSchema

    def _execute(self) -> str:
        client = _get_client(self)
        return client.list_sessions()


class DominusNodeCreateAgenticWalletTool(BaseTool):
    """Create a new Dominus Node agentic sub-wallet."""

    name: str = "Dominus Node Create Agentic Wallet"
    description: str = (
        "Create a new agentic sub-wallet with a per-transaction spending limit. "
        "Agentic wallets are funded from the main wallet and used for automated spending."
    )
    args_schema: type[BaseModel] = CreateAgenticWalletSchema

    def _execute(
        self,
        label: str,
        spending_limit_cents: int,
        daily_limit_cents: int | None = None,
        allowed_domains: list[str] | None = None,
    ) -> str:
        client = _get_client(self)
        return client.create_agentic_wallet(
            label=label,
            spending_limit_cents=spending_limit_cents,
            daily_limit_cents=daily_limit_cents,
            allowed_domains=allowed_domains,
        )


class DominusNodeFundAgenticWalletTool(BaseTool):
    """Fund a Dominus Node agentic wallet from the main wallet."""

    name: str = "Dominus Node Fund Agentic Wallet"
    description: str = "Transfer funds from the main wallet to an agentic sub-wallet."
    args_schema: type[BaseModel] = FundAgenticWalletSchema

    def _execute(self, wallet_id: str, amount_cents: int) -> str:
        client = _get_client(self)
        return client.fund_agentic_wallet(
            wallet_id=wallet_id,
            amount_cents=amount_cents,
        )


class DominusNodeAgenticWalletBalanceTool(BaseTool):
    """Check a Dominus Node agentic wallet balance."""

    name: str = "Dominus Node Agentic Wallet Balance"
    description: str = "Check the balance and details of a specific agentic sub-wallet."
    args_schema: type[BaseModel] = AgenticWalletBalanceSchema

    def _execute(self, wallet_id: str) -> str:
        client = _get_client(self)
        return client.agentic_wallet_balance(wallet_id=wallet_id)


class DominusNodeListAgenticWalletsTool(BaseTool):
    """List all Dominus Node agentic wallets."""

    name: str = "Dominus Node List Agentic Wallets"
    description: str = "List all agentic sub-wallets with their balances and spending limits."
    args_schema: type[BaseModel] = ListAgenticWalletsSchema

    def _execute(self) -> str:
        client = _get_client(self)
        return client.list_agentic_wallets()


class DominusNodeAgenticTransactionsTool(BaseTool):
    """Get transaction history for a Dominus Node agentic wallet."""

    name: str = "Dominus Node Agentic Transactions"
    description: str = "Get the transaction history for a specific agentic sub-wallet."
    args_schema: type[BaseModel] = AgenticTransactionsSchema

    def _execute(self, wallet_id: str, limit: int = 20) -> str:
        client = _get_client(self)
        return client.agentic_transactions(wallet_id=wallet_id, limit=limit)


class DominusNodeFreezeAgenticWalletTool(BaseTool):
    """Freeze a Dominus Node agentic wallet to prevent spending."""

    name: str = "Dominus Node Freeze Agentic Wallet"
    description: str = "Freeze an agentic wallet to temporarily prevent all spending."
    args_schema: type[BaseModel] = FreezeAgenticWalletSchema

    def _execute(self, wallet_id: str) -> str:
        client = _get_client(self)
        return client.freeze_agentic_wallet(wallet_id=wallet_id)


class DominusNodeUnfreezeAgenticWalletTool(BaseTool):
    """Unfreeze a Dominus Node agentic wallet to re-enable spending."""

    name: str = "Dominus Node Unfreeze Agentic Wallet"
    description: str = "Unfreeze an agentic wallet to re-enable spending."
    args_schema: type[BaseModel] = UnfreezeAgenticWalletSchema

    def _execute(self, wallet_id: str) -> str:
        client = _get_client(self)
        return client.unfreeze_agentic_wallet(wallet_id=wallet_id)


class DominusNodeDeleteAgenticWalletTool(BaseTool):
    """Delete a Dominus Node agentic wallet and refund balance."""

    name: str = "Dominus Node Delete Agentic Wallet"
    description: str = (
        "Delete an agentic wallet. The wallet must be unfrozen first. "
        "Any remaining balance is refunded to the main wallet."
    )
    args_schema: type[BaseModel] = DeleteAgenticWalletSchema

    def _execute(self, wallet_id: str) -> str:
        client = _get_client(self)
        return client.delete_agentic_wallet(wallet_id=wallet_id)


class DominusNodeUpdateWalletPolicyTool(BaseTool):
    """Update the policy for a Dominus Node agentic wallet."""

    name: str = "Dominus Node Update Wallet Policy"
    description: str = (
        "Update the policy for an agentic wallet. Set a daily budget cap "
        "and/or restrict proxy usage to specific domains."
    )
    args_schema: type[BaseModel] = UpdateWalletPolicySchema

    def _execute(
        self,
        wallet_id: str,
        daily_limit_cents: int | None = None,
        allowed_domains: list[str] | None = None,
    ) -> str:
        client = _get_client(self)
        return client.update_wallet_policy(
            wallet_id=wallet_id,
            daily_limit_cents=daily_limit_cents,
            allowed_domains=allowed_domains,
        )


class DominusNodeCreateTeamTool(BaseTool):
    """Create a new Dominus Node team with a shared wallet."""

    name: str = "Dominus Node Create Team"
    description: str = (
        "Create a new team with a shared wallet for collaborative proxy usage. "
        "Teams support owner/admin/member roles."
    )
    args_schema: type[BaseModel] = CreateTeamSchema

    def _execute(self, name: str, max_members: int = 0) -> str:
        client = _get_client(self)
        return client.create_team(
            name=name,
            max_members=max_members if max_members > 0 else None,
        )


class DominusNodeListTeamsTool(BaseTool):
    """List all Dominus Node teams the user belongs to."""

    name: str = "Dominus Node List Teams"
    description: str = "List all teams the authenticated user belongs to."
    args_schema: type[BaseModel] = ListTeamsSchema

    def _execute(self) -> str:
        client = _get_client(self)
        return client.list_teams()


class DominusNodeTeamDetailsTool(BaseTool):
    """Get details for a specific Dominus Node team."""

    name: str = "Dominus Node Team Details"
    description: str = "Get details for a specific team including members, wallet balance, and settings."
    args_schema: type[BaseModel] = TeamDetailsSchema

    def _execute(self, team_id: str) -> str:
        client = _get_client(self)
        return client.team_details(team_id=team_id)


class DominusNodeTeamFundTool(BaseTool):
    """Fund a Dominus Node team's shared wallet."""

    name: str = "Dominus Node Team Fund"
    description: str = (
        "Fund a team's shared wallet from the user's personal wallet. "
        "Amount must be between 100 and 1,000,000 cents."
    )
    args_schema: type[BaseModel] = TeamFundSchema

    def _execute(self, team_id: str, amount_cents: int) -> str:
        client = _get_client(self)
        return client.team_fund(team_id=team_id, amount_cents=amount_cents)


class DominusNodeTeamCreateKeyTool(BaseTool):
    """Create an API key for a Dominus Node team."""

    name: str = "Dominus Node Team Create Key"
    description: str = "Create a new API key for a team. The key is shown once and cannot be retrieved later."
    args_schema: type[BaseModel] = TeamCreateKeySchema

    def _execute(self, team_id: str, label: str) -> str:
        client = _get_client(self)
        return client.team_create_key(team_id=team_id, label=label)


class DominusNodeTeamUsageTool(BaseTool):
    """Get usage/transaction history for a Dominus Node team."""

    name: str = "Dominus Node Team Usage"
    description: str = "Get the usage and transaction history for a team's shared wallet."
    args_schema: type[BaseModel] = TeamUsageSchema

    def _execute(self, team_id: str, limit: int = 20) -> str:
        client = _get_client(self)
        return client.team_usage(team_id=team_id, limit=limit)


class DominusNodeUpdateTeamTool(BaseTool):
    """Update Dominus Node team settings."""

    name: str = "Dominus Node Update Team"
    description: str = "Update team name and/or maximum member count."
    args_schema: type[BaseModel] = UpdateTeamSchema

    def _execute(self, team_id: str, name: str = "", max_members: int = 0) -> str:
        client = _get_client(self)
        return client.update_team(
            team_id=team_id,
            name=name if name else None,
            max_members=max_members if max_members > 0 else None,
        )


class DominusNodeUpdateTeamMemberRoleTool(BaseTool):
    """Update a Dominus Node team member's role."""

    name: str = "Dominus Node Update Team Member Role"
    description: str = "Update a team member's role to 'member' or 'admin'."
    args_schema: type[BaseModel] = UpdateTeamMemberRoleSchema

    def _execute(self, team_id: str, user_id: str, role: str) -> str:
        client = _get_client(self)
        return client.update_team_member_role(
            team_id=team_id,
            user_id=user_id,
            role=role,
        )


class DominusNodeX402InfoTool(BaseTool):
    """Get Dominus Node x402 micropayment protocol information."""

    name: str = "Dominus Node X402 Info"
    description: str = (
        "Get x402 micropayment protocol information including supported "
        "facilitators, pricing, currencies, and payment options for AI agent micropayments."
    )
    args_schema: type[BaseModel] = X402InfoSchema

    def _execute(self) -> str:
        client = _get_client(self)
        return client.x402_info()


class DominusNodeTopupPaypalTool(BaseTool):
    """Create a PayPal wallet top-up order."""

    name: str = "Dominus Node TopUp PayPal"
    description: str = (
        "Create a PayPal top-up order for the wallet. "
        "Minimum $5.00 (500 cents). Returns an approval URL to complete payment."
    )
    args_schema: type[BaseModel] = TopupPaypalSchema

    def _execute(self, amount_cents: int) -> str:
        client = _get_client(self)
        return client.topup_paypal(amount_cents=amount_cents)


class DominusNodeTopupStripeTool(BaseTool):
    """Create a Stripe checkout session for wallet top-up."""

    name: str = "Dominus Node TopUp Stripe"
    description: str = (
        "Create a Stripe checkout session for wallet top-up. "
        "Amount between $5.00 (500 cents) and $1,000 (100,000 cents). "
        "Returns a checkout URL to complete payment."
    )
    args_schema: type[BaseModel] = TopupStripeSchema

    def _execute(self, amount_cents: int) -> str:
        client = _get_client(self)
        return client.topup_stripe(amount_cents=amount_cents)


class DominusNodeTopupCryptoTool(BaseTool):
    """Create a crypto invoice for wallet top-up."""

    name: str = "Dominus Node TopUp Crypto"
    description: str = (
        "Create a crypto payment invoice via NOWPayments for wallet top-up. "
        "Amount between $5 and $1,000 USD. Supports BTC, ETH, LTC, XMR, ZEC, "
        "USDC, SOL, USDT, DAI, BNB, LINK."
    )
    args_schema: type[BaseModel] = TopupCryptoSchema

    def _execute(self, amount_usd: float, currency: str) -> str:
        client = _get_client(self)
        return client.topup_crypto(amount_usd=amount_usd, currency=currency)


class DominusNodeProxyStatusTool(BaseTool):
    """Get the current status of the Dominus Node proxy gateway."""

    name: str = "Dominus Node Proxy Status"
    description: str = (
        "Get the proxy gateway status including uptime, active connections, "
        "and pool health information."
    )
    args_schema: type[BaseModel] = ProxyStatusSchema

    def _execute(self) -> str:
        client = _get_client(self)
        return client.get_proxy_status()


class DominusNodeTransactionsTool(BaseTool):
    """Get main wallet transaction history."""

    name: str = "Dominus Node Get Transactions"
    description: str = (
        "Get your main wallet transaction history including top-ups, "
        "usage charges, and refunds."
    )
    args_schema: type[BaseModel] = TransactionsSchema

    def _execute(self, limit: int = 20) -> str:
        client = _get_client(self)
        return client.get_transactions(limit=limit)


class DominusNodeForecastTool(BaseTool):
    """Get a spending forecast based on recent usage patterns."""

    name: str = "Dominus Node Get Forecast"
    description: str = (
        "Get a spending forecast showing projected balance depletion date, "
        "daily burn rate, and average daily bandwidth consumption."
    )
    args_schema: type[BaseModel] = ForecastSchema

    def _execute(self) -> str:
        client = _get_client(self)
        return client.get_forecast()


class DominusNodeCheckPaymentTool(BaseTool):
    """Check the status of a crypto payment invoice."""

    name: str = "Dominus Node Check Payment"
    description: str = (
        "Check the status of a crypto payment invoice. "
        "Use the invoice ID returned by topup_crypto."
    )
    args_schema: type[BaseModel] = CheckPaymentSchema

    def _execute(self, invoice_id: str) -> str:
        client = _get_client(self)
        return client.check_payment(invoice_id=invoice_id)


class DominusNodeDailyUsageTool(BaseTool):
    """Get daily bandwidth usage breakdown."""

    name: str = "Dominus Node Daily Usage"
    description: str = (
        "Get daily bandwidth usage breakdown showing per-day bytes, "
        "cost, and request counts for the specified number of days."
    )
    args_schema: type[BaseModel] = DailyUsageSchema

    def _execute(self, days: int = 7) -> str:
        client = _get_client(self)
        return client.get_daily_usage(days=days)


class DominusNodeTopHostsTool(BaseTool):
    """Get top hosts by bandwidth usage."""

    name: str = "Dominus Node Top Hosts"
    description: str = (
        "Get the top hosts by bandwidth usage. Shows which domains "
        "consume the most proxy bandwidth."
    )
    args_schema: type[BaseModel] = TopHostsSchema

    def _execute(self, limit: int = 10) -> str:
        client = _get_client(self)
        return client.get_top_hosts(limit=limit)


class DominusNodeRegisterTool(BaseTool):
    """Register a new Dominus Node account."""

    name: str = "Dominus Node Register"
    description: str = (
        "Register a new Dominus Node account. This is an unauthenticated "
        "endpoint. Returns user info and instructions for email verification."
    )
    args_schema: type[BaseModel] = RegisterSchema

    def _execute(self, email: str, password: str) -> str:
        client = _get_client(self)
        return client.register(email=email, password=password)


class DominusNodeLoginTool(BaseTool):
    """Log in to a Dominus Node account."""

    name: str = "Dominus Node Login"
    description: str = (
        "Log in to a Dominus Node account and receive access/refresh tokens. "
        "This is an unauthenticated endpoint. Detects MFA requirements."
    )
    args_schema: type[BaseModel] = LoginSchema

    def _execute(self, email: str, password: str) -> str:
        client = _get_client(self)
        return client.login(email=email, password=password)


class DominusNodeAccountInfoTool(BaseTool):
    """Get Dominus Node account information."""

    name: str = "Dominus Node Account Info"
    description: str = (
        "Get your account information including email, plan, "
        "verification status, MFA status, and creation date."
    )
    args_schema: type[BaseModel] = AccountInfoSchema

    def _execute(self) -> str:
        client = _get_client(self)
        return client.get_account_info()


class DominusNodeVerifyEmailTool(BaseTool):
    """Verify an email address using a verification code."""

    name: str = "Dominus Node Verify Email"
    description: str = (
        "Verify your email address using the code sent during registration. "
        "This is an unauthenticated endpoint."
    )
    args_schema: type[BaseModel] = VerifyEmailSchema

    def _execute(self, email: str, code: str) -> str:
        client = _get_client(self)
        return client.verify_email(email=email, code=code)


class DominusNodeResendVerificationTool(BaseTool):
    """Resend the email verification code."""

    name: str = "Dominus Node Resend Verification"
    description: str = (
        "Resend the email verification code to your registered email address. "
        "Requires authentication."
    )
    args_schema: type[BaseModel] = ResendVerificationSchema

    def _execute(self) -> str:
        client = _get_client(self)
        return client.resend_verification()


class DominusNodeUpdatePasswordTool(BaseTool):
    """Change your Dominus Node account password."""

    name: str = "Dominus Node Update Password"
    description: str = (
        "Change your account password. Requires your current password "
        "for verification."
    )
    args_schema: type[BaseModel] = UpdatePasswordSchema

    def _execute(self, current_password: str, new_password: str) -> str:
        client = _get_client(self)
        return client.update_password(
            current_password=current_password,
            new_password=new_password,
        )


class DominusNodeListKeysTool(BaseTool):
    """List all personal Dominus Node API keys."""

    name: str = "Dominus Node List Keys"
    description: str = (
        "List all your personal API keys showing key prefix, label, "
        "status, and creation date."
    )
    args_schema: type[BaseModel] = ListKeysSchema

    def _execute(self) -> str:
        client = _get_client(self)
        return client.list_keys()


class DominusNodeCreateKeyTool(BaseTool):
    """Create a new personal Dominus Node API key."""

    name: str = "Dominus Node Create Key"
    description: str = (
        "Create a new personal API key. The full key is shown only once "
        "and cannot be retrieved later."
    )
    args_schema: type[BaseModel] = CreateKeySchema

    def _execute(self, label: str) -> str:
        client = _get_client(self)
        return client.create_key(label=label)


class DominusNodeRevokeKeyTool(BaseTool):
    """Revoke a personal Dominus Node API key."""

    name: str = "Dominus Node Revoke Key"
    description: str = (
        "Revoke (delete) a personal API key. This immediately "
        "invalidates the key."
    )
    args_schema: type[BaseModel] = RevokeKeySchema

    def _execute(self, key_id: str) -> str:
        client = _get_client(self)
        return client.revoke_key(key_id=key_id)


class DominusNodeGetPlanTool(BaseTool):
    """Get your current Dominus Node plan details."""

    name: str = "Dominus Node Get Plan"
    description: str = (
        "Get your current plan details including limits, pricing, "
        "and features."
    )
    args_schema: type[BaseModel] = GetPlanSchema

    def _execute(self) -> str:
        client = _get_client(self)
        return client.get_plan()


class DominusNodeListPlansTool(BaseTool):
    """List all available Dominus Node plans."""

    name: str = "Dominus Node List Plans"
    description: str = (
        "List all available plans with pricing, bandwidth limits, "
        "rate limits, and features."
    )
    args_schema: type[BaseModel] = ListPlansSchema

    def _execute(self) -> str:
        client = _get_client(self)
        return client.list_plans()


class DominusNodeChangePlanTool(BaseTool):
    """Change your Dominus Node account plan."""

    name: str = "Dominus Node Change Plan"
    description: str = (
        "Change your account plan. Use list_plans to see available "
        "options first."
    )
    args_schema: type[BaseModel] = ChangePlanSchema

    def _execute(self, plan: str) -> str:
        client = _get_client(self)
        return client.change_plan(plan=plan)


class DominusNodeTeamDeleteTool(BaseTool):
    """Delete a Dominus Node team."""

    name: str = "Dominus Node Team Delete"
    description: str = (
        "Delete a team. Only the team owner can delete. Any remaining "
        "team balance is refunded to the owner's wallet."
    )
    args_schema: type[BaseModel] = TeamDeleteSchema

    def _execute(self, team_id: str) -> str:
        client = _get_client(self)
        return client.team_delete(team_id=team_id)


class DominusNodeTeamRevokeKeyTool(BaseTool):
    """Revoke a shared API key for a Dominus Node team."""

    name: str = "Dominus Node Team Revoke Key"
    description: str = (
        "Revoke a shared API key for a team. Only owners and admins "
        "can revoke keys."
    )
    args_schema: type[BaseModel] = TeamRevokeKeySchema

    def _execute(self, team_id: str, key_id: str) -> str:
        client = _get_client(self)
        return client.team_revoke_key(team_id=team_id, key_id=key_id)


class DominusNodeTeamListKeysTool(BaseTool):
    """List all API keys for a Dominus Node team."""

    name: str = "Dominus Node Team List Keys"
    description: str = (
        "List all API keys for a team showing key prefix, label, "
        "status, and creation date."
    )
    args_schema: type[BaseModel] = TeamListKeysSchema

    def _execute(self, team_id: str) -> str:
        client = _get_client(self)
        return client.team_list_keys(team_id=team_id)


class DominusNodeTeamListMembersTool(BaseTool):
    """List all members of a Dominus Node team."""

    name: str = "Dominus Node Team List Members"
    description: str = (
        "List all members of a team with their roles and join dates."
    )
    args_schema: type[BaseModel] = TeamListMembersSchema

    def _execute(self, team_id: str) -> str:
        client = _get_client(self)
        return client.team_list_members(team_id=team_id)


class DominusNodeTeamAddMemberTool(BaseTool):
    """Add a member directly to a Dominus Node team."""

    name: str = "Dominus Node Team Add Member"
    description: str = (
        "Add a member directly to a team by user ID. Only owners and "
        "admins can add members."
    )
    args_schema: type[BaseModel] = TeamAddMemberSchema

    def _execute(self, team_id: str, user_id: str, role: str = "member") -> str:
        client = _get_client(self)
        return client.team_add_member(
            team_id=team_id, user_id=user_id, role=role,
        )


class DominusNodeTeamRemoveMemberTool(BaseTool):
    """Remove a member from a Dominus Node team."""

    name: str = "Dominus Node Team Remove Member"
    description: str = (
        "Remove a member from a team. Only owners and admins can "
        "remove members."
    )
    args_schema: type[BaseModel] = TeamRemoveMemberSchema

    def _execute(self, team_id: str, user_id: str) -> str:
        client = _get_client(self)
        return client.team_remove_member(team_id=team_id, user_id=user_id)


class DominusNodeTeamInviteMemberTool(BaseTool):
    """Send an invitation to join a Dominus Node team."""

    name: str = "Dominus Node Team Invite Member"
    description: str = (
        "Send an invitation to join a team by email. The invitee receives "
        "an email with a link to accept."
    )
    args_schema: type[BaseModel] = TeamInviteMemberSchema

    def _execute(self, team_id: str, email: str, role: str = "member") -> str:
        client = _get_client(self)
        return client.team_invite_member(
            team_id=team_id, email=email, role=role,
        )


class DominusNodeTeamListInvitesTool(BaseTool):
    """List all pending invitations for a Dominus Node team."""

    name: str = "Dominus Node Team List Invites"
    description: str = "List all pending invitations for a team."
    args_schema: type[BaseModel] = TeamListInvitesSchema

    def _execute(self, team_id: str) -> str:
        client = _get_client(self)
        return client.team_list_invites(team_id=team_id)


class DominusNodeTeamCancelInviteTool(BaseTool):
    """Cancel a pending Dominus Node team invitation."""

    name: str = "Dominus Node Team Cancel Invite"
    description: str = (
        "Cancel a pending team invitation. Only owners and admins "
        "can cancel invites."
    )
    args_schema: type[BaseModel] = TeamCancelInviteSchema

    def _execute(self, team_id: str, invite_id: str) -> str:
        client = _get_client(self)
        return client.team_cancel_invite(team_id=team_id, invite_id=invite_id)
