"""Dominus Node TaskWeaver plugin -- 53 proxy, wallet, team, and payment commands.

Provides a TaskWeaver-compatible plugin class that exposes 53 commands for
interacting with the Dominus Node rotating proxy-as-a-service platform.

Commands cover:
  - Proxied HTTP fetching through rotating proxies
  - Wallet balance, usage monitoring, transactions, and forecast
  - Proxy configuration, session listing, and proxy status
  - Agentic wallet management (create, fund, freeze, unfreeze, delete)
  - Team management (create, list, fund, keys, usage, update, role changes,
    members, invites, delete)
  - Account lifecycle (register, login, verify email, change password)
  - API key management (list, create, revoke)
  - Plan management (get, list, change)
  - PayPal, Stripe, and crypto top-up with payment status checking

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

    from dominusnode_taskweaver import DominusNodePlugin

    plugin = DominusNodePlugin(api_key="dn_live_...")
    result = plugin.check_balance()  # JSON string
    result = plugin("proxied_fetch", url="https://example.com")

Requires: httpx (``pip install httpx``)
"""

from __future__ import annotations

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
# DominusNodePlugin -- main plugin class
# ===========================================================================


class DominusNodePlugin:
    """TaskWeaver plugin providing Dominus Node rotating proxy commands.

    Authenticates using a Dominus Node API key and exposes 53 commands for proxy,
    wallet, team, account, API key, plan, and payment management.  All commands
    return JSON strings suitable for consumption by an LLM.

    This plugin follows the TaskWeaver plugin pattern: it can be invoked via
    ``__call__(command, **kwargs)`` as a dispatcher, or individual command
    methods can be called directly.

    Args:
        api_key: Dominus Node API key (``dn_live_...`` or ``dn_test_...``).
            Falls back to ``DOMINUSNODE_API_KEY`` environment variable.
        base_url: Base URL of the Dominus Node REST API.
        proxy_host: Hostname of the Dominus Node proxy gateway.
        proxy_port: Port of the Dominus Node proxy gateway.
        timeout: HTTP request timeout in seconds.

    Example::

        plugin = DominusNodePlugin(api_key="dn_live_abc123")
        print(plugin.check_balance())
        print(plugin("proxied_fetch", url="https://example.com"))
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
                "User-Agent": "dominusnode-taskweaver/1.0.0",
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
            req_headers: Dict[str, str] = {
                "User-Agent": "dominusnode-taskweaver/1.0.0",
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
    # Command 1: proxied_fetch
    # ==================================================================

    def proxied_fetch(
        self,
        url: str,
        method: str = "GET",
        country: str | None = None,
        proxy_type: str = "dc",
        headers: Dict[str, str] | None = None,
    ) -> str:
        """Fetch a URL through the Dominus Node rotating proxy network.

        Args:
            url: Target URL to fetch.
            method: HTTP method (GET, HEAD, or OPTIONS only).
            country: Optional ISO 3166-1 alpha-2 country code for geo-targeting.
            proxy_type: Proxy type: ``dc`` (datacenter, $3/GB) or
                ``residential`` ($5/GB). Default: ``dc``.
            headers: Optional additional headers to send with the request.

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
    # Command 14: create_team
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
    # Command 23: topup_paypal
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
    # Command 24: topup_stripe
    # ==================================================================

    def topup_stripe(self, amount_cents: int) -> str:
        """Create a Stripe checkout session for wallet top-up.

        Args:
            amount_cents: Amount to top up in cents (500 to 100,000).
                Minimum $5.00 (500 cents), maximum $1,000.00 (100,000 cents).

        Returns:
            JSON string with checkout session details for completing
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
    # Command 25: topup_crypto
    # ==================================================================

    _VALID_CRYPTO_CURRENCIES = {
        "BTC", "ETH", "LTC", "XMR", "ZEC",
        "USDC", "SOL", "USDT", "DAI", "BNB", "LINK",
    }

    def topup_crypto(self, amount_usd: float, currency: str) -> str:
        """Create a crypto payment invoice for wallet top-up.

        Args:
            amount_usd: Amount in USD (5 to 1,000).
            currency: Cryptocurrency code (BTC/ETH/LTC/XMR/ZEC/USDC/SOL/
                USDT/DAI/BNB/LINK).

        Returns:
            JSON string with invoice details for completing the crypto payment.
        """
        if not isinstance(amount_usd, (int, float)) or isinstance(amount_usd, bool):
            return json.dumps({"error": "amount_usd must be a number between 5 and 1,000"})
        if not math.isfinite(amount_usd):
            return json.dumps({"error": "amount_usd must be a number between 5 and 1,000"})
        if amount_usd < 5 or amount_usd > 1000:
            return json.dumps({"error": "amount_usd must be a number between 5 and 1,000"})

        if not currency or not isinstance(currency, str):
            return json.dumps({
                "error": "currency must be one of: BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK",
            })
        if currency.upper() not in self._VALID_CRYPTO_CURRENCIES:
            return json.dumps({
                "error": "currency must be one of: BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK",
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
    # Command 26: update_wallet_policy
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
    # Command 27: get_proxy_status
    # ==================================================================

    def get_proxy_status(self) -> str:
        """Get the current status of the proxy gateway.

        Returns:
            JSON string with proxy gateway status information.
        """
        try:
            result = self._request_with_retry("GET", "/api/proxy/status")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 28: get_transactions
    # ==================================================================

    def get_transactions(self, limit: int = 20) -> str:
        """Get wallet transaction history.

        Args:
            limit: Maximum number of transactions to return (1-100, default 20).

        Returns:
            JSON string with wallet transaction history.
        """
        if isinstance(limit, float) and not math.isfinite(limit):
            return json.dumps({"error": "limit must be an integer between 1 and 100"})
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
            return json.dumps(
                {"error": "limit must be an integer between 1 and 100"}
            )

        try:
            result = self._request_with_retry(
                "GET", f"/api/wallet/transactions?limit={limit}"
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 29: get_forecast
    # ==================================================================

    def get_forecast(self) -> str:
        """Get wallet balance forecast based on recent usage trends.

        Returns:
            JSON string with wallet balance forecast information.
        """
        try:
            result = self._request_with_retry("GET", "/api/wallet/forecast")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 30: check_payment
    # ==================================================================

    def check_payment(self, invoice_id: str) -> str:
        """Check the status of a crypto top-up payment.

        Args:
            invoice_id: The invoice ID from a previous ``topup_crypto`` call.

        Returns:
            JSON string with payment status information.
        """
        if not invoice_id or not isinstance(invoice_id, str):
            return json.dumps({"error": "invoice_id is required and must be a string"})

        try:
            result = self._request_with_retry(
                "GET",
                f"/api/wallet/topup/crypto/{quote(invoice_id, safe='')}/status",
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 31: get_daily_usage
    # ==================================================================

    def get_daily_usage(self, days: int = 30) -> str:
        """Get daily usage breakdown.

        Args:
            days: Number of days of history to retrieve (1-90, default 30).

        Returns:
            JSON string with daily usage breakdown.
        """
        if isinstance(days, float) and not math.isfinite(days):
            return json.dumps({"error": "days must be an integer between 1 and 90"})
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
    # Command 32: get_top_hosts
    # ==================================================================

    def get_top_hosts(self, limit: int = 10) -> str:
        """Get the top hosts by bandwidth usage.

        Args:
            limit: Maximum number of hosts to return (1-50, default 10).

        Returns:
            JSON string with top hosts by usage.
        """
        if isinstance(limit, float) and not math.isfinite(limit):
            return json.dumps({"error": "limit must be an integer between 1 and 50"})
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 50:
            return json.dumps(
                {"error": "limit must be an integer between 1 and 50"}
            )

        try:
            result = self._request_with_retry(
                "GET", f"/api/usage/top-hosts?limit={limit}"
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 33: register_account
    # ==================================================================

    _BASIC_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

    def register_account(self, email: str, password: str) -> str:
        """Register a new Dominus Node account.

        This is an unauthenticated endpoint -- no API key or token needed.

        Args:
            email: Email address for the new account.
            password: Password for the new account (8-128 characters).

        Returns:
            JSON string with registration result.
        """
        if not email or not isinstance(email, str):
            return json.dumps({"error": "email is required and must be a string"})
        if not self._BASIC_EMAIL_RE.match(email):
            return json.dumps({"error": "email must be a valid email address"})
        if len(email) > 254:
            return json.dumps({"error": "email must be 254 characters or fewer"})

        if not password or not isinstance(password, str):
            return json.dumps({"error": "password is required and must be a string"})
        if len(password) < 8:
            return json.dumps({"error": "password must be at least 8 characters"})
        if len(password) > 128:
            return json.dumps({"error": "password must be 128 characters or fewer"})

        try:
            headers = {
                "User-Agent": "dominusnode-taskweaver/1.0.0",
                "Content-Type": "application/json",
            }
            if self.agent_secret:
                headers["X-DominusNode-Agent"] = "mcp"
                headers["X-DominusNode-Agent-Secret"] = self.agent_secret
            with httpx.Client(
                timeout=self.timeout,
                follow_redirects=False,
            ) as client:
                resp = client.post(
                    f"{self.base_url}/api/auth/register",
                    json={"email": email, "password": password},
                    headers=headers,
                )
                if len(resp.content) > MAX_RESPONSE_BYTES:
                    return json.dumps({"error": "Response body too large"})
                if resp.status_code >= 400:
                    try:
                        err_data = resp.json()
                        msg = err_data.get("error", resp.text)
                    except Exception:
                        msg = resp.text
                    return json.dumps({"error": _sanitize_error(str(msg)[:500])})
                if resp.text:
                    data = resp.json()
                    _strip_dangerous_keys(data)
                    return json.dumps(data)
                return json.dumps({})
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 34: login_account
    # ==================================================================

    def login_account(self, email: str, password: str) -> str:
        """Log in to a Dominus Node account.

        This is an unauthenticated endpoint -- no API key or token needed.

        Args:
            email: Account email address.
            password: Account password.

        Returns:
            JSON string with login result (tokens).
        """
        if not email or not isinstance(email, str):
            return json.dumps({"error": "email is required and must be a string"})
        if not self._BASIC_EMAIL_RE.match(email):
            return json.dumps({"error": "email must be a valid email address"})
        if len(email) > 254:
            return json.dumps({"error": "email must be 254 characters or fewer"})

        if not password or not isinstance(password, str):
            return json.dumps({"error": "password is required and must be a string"})
        if len(password) < 8:
            return json.dumps({"error": "password must be at least 8 characters"})
        if len(password) > 128:
            return json.dumps({"error": "password must be 128 characters or fewer"})

        try:
            headers = {
                "User-Agent": "dominusnode-taskweaver/1.0.0",
                "Content-Type": "application/json",
            }
            if self.agent_secret:
                headers["X-DominusNode-Agent"] = "mcp"
                headers["X-DominusNode-Agent-Secret"] = self.agent_secret
            with httpx.Client(
                timeout=self.timeout,
                follow_redirects=False,
            ) as client:
                resp = client.post(
                    f"{self.base_url}/api/auth/login",
                    json={"email": email, "password": password},
                    headers=headers,
                )
                if len(resp.content) > MAX_RESPONSE_BYTES:
                    return json.dumps({"error": "Response body too large"})
                if resp.status_code >= 400:
                    try:
                        err_data = resp.json()
                        msg = err_data.get("error", resp.text)
                    except Exception:
                        msg = resp.text
                    return json.dumps({"error": _sanitize_error(str(msg)[:500])})
                if resp.text:
                    data = resp.json()
                    _strip_dangerous_keys(data)
                    return json.dumps(data)
                return json.dumps({})
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 35: get_account_info
    # ==================================================================

    def get_account_info(self) -> str:
        """Get current account information.

        Returns:
            JSON string with account details (email, plan, verification status).
        """
        try:
            result = self._request_with_retry("GET", "/api/auth/me")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 36: verify_email
    # ==================================================================

    def verify_email(self, token: str) -> str:
        """Verify an email address using a verification token.

        This is an unauthenticated endpoint -- no API key or token needed.

        Args:
            token: The email verification token received via email.

        Returns:
            JSON string confirming email verification.
        """
        if not token or not isinstance(token, str):
            return json.dumps({"error": "token is required and must be a string"})
        if len(token) > 512:
            return json.dumps({"error": "token must be 512 characters or fewer"})

        try:
            headers = {
                "User-Agent": "dominusnode-taskweaver/1.0.0",
                "Content-Type": "application/json",
            }
            if self.agent_secret:
                headers["X-DominusNode-Agent"] = "mcp"
                headers["X-DominusNode-Agent-Secret"] = self.agent_secret
            with httpx.Client(
                timeout=self.timeout,
                follow_redirects=False,
            ) as client:
                resp = client.post(
                    f"{self.base_url}/api/auth/verify-email",
                    json={"token": token},
                    headers=headers,
                )
                if len(resp.content) > MAX_RESPONSE_BYTES:
                    return json.dumps({"error": "Response body too large"})
                if resp.status_code >= 400:
                    try:
                        err_data = resp.json()
                        msg = err_data.get("error", resp.text)
                    except Exception:
                        msg = resp.text
                    return json.dumps({"error": _sanitize_error(str(msg)[:500])})
                if resp.text:
                    data = resp.json()
                    _strip_dangerous_keys(data)
                    return json.dumps(data)
                return json.dumps({})
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 37: resend_verification
    # ==================================================================

    def resend_verification(self) -> str:
        """Resend the email verification link.

        Returns:
            JSON string confirming the verification email was resent.
        """
        try:
            result = self._request_with_retry("POST", "/api/auth/resend-verification")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 38: update_password
    # ==================================================================

    def update_password(self, current_password: str, new_password: str) -> str:
        """Change the account password.

        Args:
            current_password: The current account password.
            new_password: The new password (8-128 characters).

        Returns:
            JSON string confirming the password change.
        """
        if not current_password or not isinstance(current_password, str):
            return json.dumps({"error": "current_password is required and must be a string"})
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
                {"currentPassword": current_password, "newPassword": new_password},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 39: list_keys
    # ==================================================================

    def list_keys(self) -> str:
        """List all API keys for the current account.

        Returns:
            JSON string with a list of API keys.
        """
        try:
            result = self._request_with_retry("GET", "/api/keys")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 40: create_key
    # ==================================================================

    def create_key(self, label: str) -> str:
        """Create a new API key.

        Args:
            label: Human-readable label for the key (max 100 chars, no control characters).

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
    # Command 41: revoke_key
    # ==================================================================

    def revoke_key(self, key_id: str) -> str:
        """Revoke (delete) an API key.

        Args:
            key_id: ID of the API key to revoke.

        Returns:
            JSON string confirming the key revocation.
        """
        if not key_id or not isinstance(key_id, str):
            return json.dumps({"error": "key_id is required and must be a string"})

        try:
            result = self._request_with_retry(
                "DELETE", f"/api/keys/{quote(key_id, safe='')}"
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 42: get_plan
    # ==================================================================

    def get_plan(self) -> str:
        """Get the current user's plan.

        Returns:
            JSON string with the user's current plan details.
        """
        try:
            result = self._request_with_retry("GET", "/api/plans/user/plan")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 43: list_plans
    # ==================================================================

    def list_plans(self) -> str:
        """List all available plans.

        Returns:
            JSON string with a list of available plans.
        """
        try:
            result = self._request_with_retry("GET", "/api/plans")
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 44: change_plan
    # ==================================================================

    def change_plan(self, plan_id: str) -> str:
        """Change the user's plan.

        Args:
            plan_id: UUID of the plan to switch to.

        Returns:
            JSON string with the updated plan details.
        """
        err = _validate_uuid(plan_id, "plan_id")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "PUT", "/api/plans/user/plan", {"planId": plan_id}
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 45: team_delete
    # ==================================================================

    def team_delete(self, team_id: str) -> str:
        """Delete a team.

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
    # Command 46: team_revoke_key
    # ==================================================================

    def team_revoke_key(self, team_id: str, key_id: str) -> str:
        """Revoke (delete) an API key from a team.

        Args:
            team_id: UUID of the team.
            key_id: ID of the API key to revoke.

        Returns:
            JSON string confirming the key revocation.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        if not key_id or not isinstance(key_id, str):
            return json.dumps({"error": "key_id is required and must be a string"})

        try:
            result = self._request_with_retry(
                "DELETE",
                f"/api/teams/{quote(team_id, safe='')}/keys/{quote(key_id, safe='')}",
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 47: team_list_keys
    # ==================================================================

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
    # Command 48: team_list_members
    # ==================================================================

    def team_list_members(self, team_id: str) -> str:
        """List all members of a team.

        Args:
            team_id: UUID of the team.

        Returns:
            JSON string with a list of team members.
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
    # Command 49: team_add_member
    # ==================================================================

    def team_add_member(self, team_id: str, user_id: str) -> str:
        """Add a member to a team by user ID.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the user to add.

        Returns:
            JSON string confirming the member addition.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        err = _validate_uuid(user_id, "user_id")
        if err:
            return json.dumps({"error": err})

        try:
            result = self._request_with_retry(
                "POST",
                f"/api/teams/{quote(team_id, safe='')}/members",
                {"userId": user_id},
            )
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ==================================================================
    # Command 50: team_remove_member
    # ==================================================================

    def team_remove_member(self, team_id: str, user_id: str) -> str:
        """Remove a member from a team.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the user to remove.

        Returns:
            JSON string confirming the member removal.
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
    # Command 51: team_invite_member
    # ==================================================================

    def team_invite_member(
        self, team_id: str, email: str, role: str = "member"
    ) -> str:
        """Invite a user to a team by email.

        Args:
            team_id: UUID of the team.
            email: Email address of the user to invite.
            role: Role for the invited user (``member`` or ``admin``). Default: ``member``.

        Returns:
            JSON string with the created invite details.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return json.dumps({"error": err})

        if not email or not isinstance(email, str):
            return json.dumps({"error": "email is required and must be a string"})
        if not self._BASIC_EMAIL_RE.match(email):
            return json.dumps({"error": "email must be a valid email address"})
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
    # Command 52: team_list_invites
    # ==================================================================

    def team_list_invites(self, team_id: str) -> str:
        """List pending invites for a team.

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
    # Command 53: team_cancel_invite
    # ==================================================================

    def team_cancel_invite(self, team_id: str, invite_id: str) -> str:
        """Cancel a pending team invite.

        Args:
            team_id: UUID of the team.
            invite_id: UUID of the invite to cancel.

        Returns:
            JSON string confirming the invite cancellation.
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

    # ==================================================================
    # TaskWeaver __call__ dispatcher
    # ==================================================================

    def __call__(self, command: str, **kwargs: Any) -> str:
        """Execute a Dominus Node command.

        This is the main entry point for TaskWeaver to invoke plugin commands.
        It maps command names to their corresponding methods.

        Args:
            command: Command name (e.g., ``proxied_fetch``, ``check_balance``).
            **kwargs: Command-specific keyword arguments.

        Returns:
            JSON string with the command result or error.
        """
        dispatch: Dict[str, Any] = {
            "proxied_fetch": self._dispatch_proxied_fetch,
            "check_balance": self._dispatch_check_balance,
            "check_usage": self._dispatch_check_usage,
            "get_proxy_config": self._dispatch_get_proxy_config,
            "list_sessions": self._dispatch_list_sessions,
            "create_agentic_wallet": self._dispatch_create_agentic_wallet,
            "fund_agentic_wallet": self._dispatch_fund_agentic_wallet,
            "agentic_wallet_balance": self._dispatch_agentic_wallet_balance,
            "list_agentic_wallets": self._dispatch_list_agentic_wallets,
            "agentic_transactions": self._dispatch_agentic_transactions,
            "freeze_agentic_wallet": self._dispatch_freeze_agentic_wallet,
            "unfreeze_agentic_wallet": self._dispatch_unfreeze_agentic_wallet,
            "delete_agentic_wallet": self._dispatch_delete_agentic_wallet,
            "create_team": self._dispatch_create_team,
            "list_teams": self._dispatch_list_teams,
            "team_details": self._dispatch_team_details,
            "team_fund": self._dispatch_team_fund,
            "team_create_key": self._dispatch_team_create_key,
            "team_usage": self._dispatch_team_usage,
            "update_team": self._dispatch_update_team,
            "update_team_member_role": self._dispatch_update_team_member_role,
            "x402_info": self._dispatch_x402_info,
            "topup_paypal": self._dispatch_topup_paypal,
            "topup_stripe": self._dispatch_topup_stripe,
            "topup_crypto": self._dispatch_topup_crypto,
            "update_wallet_policy": self._dispatch_update_wallet_policy,
            # --- Commands 27-53 ---
            "get_proxy_status": self._dispatch_get_proxy_status,
            "get_transactions": self._dispatch_get_transactions,
            "get_forecast": self._dispatch_get_forecast,
            "check_payment": self._dispatch_check_payment,
            "get_daily_usage": self._dispatch_get_daily_usage,
            "get_top_hosts": self._dispatch_get_top_hosts,
            "register_account": self._dispatch_register_account,
            "login_account": self._dispatch_login_account,
            "get_account_info": self._dispatch_get_account_info,
            "verify_email": self._dispatch_verify_email,
            "resend_verification": self._dispatch_resend_verification,
            "update_password": self._dispatch_update_password,
            "list_keys": self._dispatch_list_keys,
            "create_key": self._dispatch_create_key,
            "revoke_key": self._dispatch_revoke_key,
            "get_plan": self._dispatch_get_plan,
            "list_plans": self._dispatch_list_plans,
            "change_plan": self._dispatch_change_plan,
            "team_delete": self._dispatch_team_delete,
            "team_revoke_key": self._dispatch_team_revoke_key,
            "team_list_keys": self._dispatch_team_list_keys,
            "team_list_members": self._dispatch_team_list_members,
            "team_add_member": self._dispatch_team_add_member,
            "team_remove_member": self._dispatch_team_remove_member,
            "team_invite_member": self._dispatch_team_invite_member,
            "team_list_invites": self._dispatch_team_list_invites,
            "team_cancel_invite": self._dispatch_team_cancel_invite,
        }

        handler = dispatch.get(command)
        if handler is None:
            return json.dumps({
                "error": f"Unknown command: {command}",
                "available_commands": sorted(dispatch.keys()),
            })

        try:
            return handler(kwargs)
        except Exception as e:
            return json.dumps({"error": _sanitize_error(str(e))})

    # ------------------------------------------------------------------
    # Internal dispatch handlers (translate dict args to method calls)
    # ------------------------------------------------------------------

    def _dispatch_proxied_fetch(self, args: dict) -> str:
        url = args.get("url")
        if not url or not isinstance(url, str):
            return json.dumps({"error": "url is required and must be a string"})
        return self.proxied_fetch(
            url=url,
            method=args.get("method", "GET"),
            country=args.get("country"),
            proxy_type=args.get("proxy_type", "dc"),
            headers=args.get("headers"),
        )

    def _dispatch_check_balance(self, args: dict) -> str:
        return self.check_balance()

    def _dispatch_check_usage(self, args: dict) -> str:
        return self.check_usage(period=args.get("period", "month"))

    def _dispatch_get_proxy_config(self, args: dict) -> str:
        return self.get_proxy_config()

    def _dispatch_list_sessions(self, args: dict) -> str:
        return self.list_sessions()

    def _dispatch_create_agentic_wallet(self, args: dict) -> str:
        label = args.get("label")
        spending_limit_cents = args.get("spending_limit_cents")
        if label is None or spending_limit_cents is None:
            return json.dumps({
                "error": "label and spending_limit_cents are required"
            })
        return self.create_agentic_wallet(
            label=label,
            spending_limit_cents=spending_limit_cents,
            daily_limit_cents=args.get("daily_limit_cents"),
            allowed_domains=args.get("allowed_domains"),
        )

    def _dispatch_fund_agentic_wallet(self, args: dict) -> str:
        wallet_id = args.get("wallet_id")
        amount_cents = args.get("amount_cents")
        if wallet_id is None or amount_cents is None:
            return json.dumps({
                "error": "wallet_id and amount_cents are required"
            })
        return self.fund_agentic_wallet(
            wallet_id=wallet_id,
            amount_cents=amount_cents,
        )

    def _dispatch_agentic_wallet_balance(self, args: dict) -> str:
        wallet_id = args.get("wallet_id")
        if not wallet_id:
            return json.dumps({"error": "wallet_id is required"})
        return self.agentic_wallet_balance(wallet_id=wallet_id)

    def _dispatch_list_agentic_wallets(self, args: dict) -> str:
        return self.list_agentic_wallets()

    def _dispatch_agentic_transactions(self, args: dict) -> str:
        wallet_id = args.get("wallet_id")
        if not wallet_id:
            return json.dumps({"error": "wallet_id is required"})
        limit = args.get("limit", 20)
        return self.agentic_transactions(wallet_id=wallet_id, limit=limit)

    def _dispatch_freeze_agentic_wallet(self, args: dict) -> str:
        wallet_id = args.get("wallet_id")
        if not wallet_id:
            return json.dumps({"error": "wallet_id is required"})
        return self.freeze_agentic_wallet(wallet_id=wallet_id)

    def _dispatch_unfreeze_agentic_wallet(self, args: dict) -> str:
        wallet_id = args.get("wallet_id")
        if not wallet_id:
            return json.dumps({"error": "wallet_id is required"})
        return self.unfreeze_agentic_wallet(wallet_id=wallet_id)

    def _dispatch_delete_agentic_wallet(self, args: dict) -> str:
        wallet_id = args.get("wallet_id")
        if not wallet_id:
            return json.dumps({"error": "wallet_id is required"})
        return self.delete_agentic_wallet(wallet_id=wallet_id)

    def _dispatch_create_team(self, args: dict) -> str:
        name = args.get("name")
        if not name:
            return json.dumps({"error": "name is required"})
        return self.create_team(
            name=name,
            max_members=args.get("max_members"),
        )

    def _dispatch_list_teams(self, args: dict) -> str:
        return self.list_teams()

    def _dispatch_team_details(self, args: dict) -> str:
        team_id = args.get("team_id")
        if not team_id:
            return json.dumps({"error": "team_id is required"})
        return self.team_details(team_id=team_id)

    def _dispatch_team_fund(self, args: dict) -> str:
        team_id = args.get("team_id")
        amount_cents = args.get("amount_cents")
        if team_id is None or amount_cents is None:
            return json.dumps({
                "error": "team_id and amount_cents are required"
            })
        return self.team_fund(team_id=team_id, amount_cents=amount_cents)

    def _dispatch_team_create_key(self, args: dict) -> str:
        team_id = args.get("team_id")
        label = args.get("label")
        if team_id is None or label is None:
            return json.dumps({
                "error": "team_id and label are required"
            })
        return self.team_create_key(team_id=team_id, label=label)

    def _dispatch_team_usage(self, args: dict) -> str:
        team_id = args.get("team_id")
        if not team_id:
            return json.dumps({"error": "team_id is required"})
        limit = args.get("limit", 20)
        return self.team_usage(team_id=team_id, limit=limit)

    def _dispatch_update_team(self, args: dict) -> str:
        team_id = args.get("team_id")
        if not team_id:
            return json.dumps({"error": "team_id is required"})
        return self.update_team(
            team_id=team_id,
            name=args.get("name"),
            max_members=args.get("max_members"),
        )

    def _dispatch_update_team_member_role(self, args: dict) -> str:
        team_id = args.get("team_id")
        user_id = args.get("user_id")
        role = args.get("role")
        if team_id is None or user_id is None or role is None:
            return json.dumps({
                "error": "team_id, user_id, and role are required"
            })
        return self.update_team_member_role(
            team_id=team_id,
            user_id=user_id,
            role=role,
        )

    def _dispatch_x402_info(self, args: dict) -> str:
        return self.x402_info()

    def _dispatch_topup_paypal(self, args: dict) -> str:
        amount_cents = args.get("amount_cents")
        if amount_cents is None:
            return json.dumps({"error": "amount_cents is required"})
        return self.topup_paypal(amount_cents=amount_cents)

    def _dispatch_topup_stripe(self, args: dict) -> str:
        amount_cents = args.get("amount_cents")
        if amount_cents is None:
            return json.dumps({"error": "amount_cents is required"})
        return self.topup_stripe(amount_cents=amount_cents)

    def _dispatch_topup_crypto(self, args: dict) -> str:
        amount_usd = args.get("amount_usd")
        currency = args.get("currency")
        if amount_usd is None or currency is None:
            return json.dumps({
                "error": "amount_usd and currency are required"
            })
        return self.topup_crypto(amount_usd=amount_usd, currency=currency)

    def _dispatch_update_wallet_policy(self, args: dict) -> str:
        wallet_id = args.get("wallet_id")
        if not wallet_id:
            return json.dumps({"error": "wallet_id is required"})
        return self.update_wallet_policy(
            wallet_id=wallet_id,
            daily_limit_cents=args.get("daily_limit_cents"),
            allowed_domains=args.get("allowed_domains"),
        )

    # ------------------------------------------------------------------
    # Dispatch handlers for commands 27-53
    # ------------------------------------------------------------------

    def _dispatch_get_proxy_status(self, args: dict) -> str:
        return self.get_proxy_status()

    def _dispatch_get_transactions(self, args: dict) -> str:
        limit = args.get("limit", 20)
        return self.get_transactions(limit=limit)

    def _dispatch_get_forecast(self, args: dict) -> str:
        return self.get_forecast()

    def _dispatch_check_payment(self, args: dict) -> str:
        invoice_id = args.get("invoice_id")
        if not invoice_id:
            return json.dumps({"error": "invoice_id is required"})
        return self.check_payment(invoice_id=invoice_id)

    def _dispatch_get_daily_usage(self, args: dict) -> str:
        days = args.get("days", 30)
        return self.get_daily_usage(days=days)

    def _dispatch_get_top_hosts(self, args: dict) -> str:
        limit = args.get("limit", 10)
        return self.get_top_hosts(limit=limit)

    def _dispatch_register_account(self, args: dict) -> str:
        email = args.get("email")
        password = args.get("password")
        if email is None or password is None:
            return json.dumps({
                "error": "email and password are required"
            })
        return self.register_account(email=email, password=password)

    def _dispatch_login_account(self, args: dict) -> str:
        email = args.get("email")
        password = args.get("password")
        if email is None or password is None:
            return json.dumps({
                "error": "email and password are required"
            })
        return self.login_account(email=email, password=password)

    def _dispatch_get_account_info(self, args: dict) -> str:
        return self.get_account_info()

    def _dispatch_verify_email(self, args: dict) -> str:
        token = args.get("token")
        if not token:
            return json.dumps({"error": "token is required"})
        return self.verify_email(token=token)

    def _dispatch_resend_verification(self, args: dict) -> str:
        return self.resend_verification()

    def _dispatch_update_password(self, args: dict) -> str:
        current_password = args.get("current_password")
        new_password = args.get("new_password")
        if current_password is None or new_password is None:
            return json.dumps({
                "error": "current_password and new_password are required"
            })
        return self.update_password(
            current_password=current_password,
            new_password=new_password,
        )

    def _dispatch_list_keys(self, args: dict) -> str:
        return self.list_keys()

    def _dispatch_create_key(self, args: dict) -> str:
        label = args.get("label")
        if not label:
            return json.dumps({"error": "label is required"})
        return self.create_key(label=label)

    def _dispatch_revoke_key(self, args: dict) -> str:
        key_id = args.get("key_id")
        if not key_id:
            return json.dumps({"error": "key_id is required"})
        return self.revoke_key(key_id=key_id)

    def _dispatch_get_plan(self, args: dict) -> str:
        return self.get_plan()

    def _dispatch_list_plans(self, args: dict) -> str:
        return self.list_plans()

    def _dispatch_change_plan(self, args: dict) -> str:
        plan_id = args.get("plan_id")
        if not plan_id:
            return json.dumps({"error": "plan_id is required"})
        return self.change_plan(plan_id=plan_id)

    def _dispatch_team_delete(self, args: dict) -> str:
        team_id = args.get("team_id")
        if not team_id:
            return json.dumps({"error": "team_id is required"})
        return self.team_delete(team_id=team_id)

    def _dispatch_team_revoke_key(self, args: dict) -> str:
        team_id = args.get("team_id")
        key_id = args.get("key_id")
        if team_id is None or key_id is None:
            return json.dumps({
                "error": "team_id and key_id are required"
            })
        return self.team_revoke_key(team_id=team_id, key_id=key_id)

    def _dispatch_team_list_keys(self, args: dict) -> str:
        team_id = args.get("team_id")
        if not team_id:
            return json.dumps({"error": "team_id is required"})
        return self.team_list_keys(team_id=team_id)

    def _dispatch_team_list_members(self, args: dict) -> str:
        team_id = args.get("team_id")
        if not team_id:
            return json.dumps({"error": "team_id is required"})
        return self.team_list_members(team_id=team_id)

    def _dispatch_team_add_member(self, args: dict) -> str:
        team_id = args.get("team_id")
        user_id = args.get("user_id")
        if team_id is None or user_id is None:
            return json.dumps({
                "error": "team_id and user_id are required"
            })
        return self.team_add_member(team_id=team_id, user_id=user_id)

    def _dispatch_team_remove_member(self, args: dict) -> str:
        team_id = args.get("team_id")
        user_id = args.get("user_id")
        if team_id is None or user_id is None:
            return json.dumps({
                "error": "team_id and user_id are required"
            })
        return self.team_remove_member(team_id=team_id, user_id=user_id)

    def _dispatch_team_invite_member(self, args: dict) -> str:
        team_id = args.get("team_id")
        email = args.get("email")
        if team_id is None or email is None:
            return json.dumps({
                "error": "team_id and email are required"
            })
        return self.team_invite_member(
            team_id=team_id,
            email=email,
            role=args.get("role", "member"),
        )

    def _dispatch_team_list_invites(self, args: dict) -> str:
        team_id = args.get("team_id")
        if not team_id:
            return json.dumps({"error": "team_id is required"})
        return self.team_list_invites(team_id=team_id)

    def _dispatch_team_cancel_invite(self, args: dict) -> str:
        team_id = args.get("team_id")
        invite_id = args.get("invite_id")
        if team_id is None or invite_id is None:
            return json.dumps({
                "error": "team_id and invite_id are required"
            })
        return self.team_cancel_invite(team_id=team_id, invite_id=invite_id)
