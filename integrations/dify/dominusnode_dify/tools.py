"""Dominus Node Dify tool provider -- 24 tools with full security hardening.

This module implements the DominusNodeProvider class that Dify invokes.
Each tool is a method that receives credentials (from the provider YAML)
and parameters (from the tool YAML), performs the operation against the
Dominus Node REST API, and returns a dict result.

Security code is copied verbatim from the AutoGPT integration to ensure
identical SSRF, OFAC, credential scrubbing, and prototype pollution
protections.
"""

from __future__ import annotations

import ipaddress
import json
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

_DOMAIN_RE = re.compile(
    r"^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$"
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


# ===========================================================================
# DominusNodeProvider -- Dify tool provider
# ===========================================================================


class DominusNodeProvider:
    """Dify tool provider for Dominus Node rotating proxy service.

    Authenticates using a Dominus Node API key and exposes 24 tool methods that
    Dify can invoke.  Each tool method receives ``credentials`` and ``params``
    dicts from the Dify runtime and returns a dict result.

    Args:
        credentials: Dify provider credentials dict containing ``api_key``,
            optional ``base_url``, and optional ``proxy_host``.

    Example::

        provider = DominusNodeProvider(credentials={
            "api_key": "dn_live_...",
            "base_url": "https://api.dominusnode.com",
            "proxy_host": "proxy.dominusnode.com",
        })
        result = provider.proxied_fetch({"url": "https://example.com"})
    """

    def __init__(self, credentials: Dict[str, Any] | None = None):
        creds = credentials or {}
        self.api_key: str = creds.get("api_key", "") or os.environ.get("DOMINUSNODE_API_KEY", "")
        base = creds.get("base_url", "") or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        self.base_url: str = base.rstrip("/")
        self.proxy_host: str = creds.get("proxy_host", "") or os.environ.get("DOMINUSNODE_PROXY_HOST", "proxy.dominusnode.com")
        self.proxy_port: int = int(os.environ.get("DOMINUSNODE_PROXY_PORT", "8080"))
        self.timeout: float = 30.0
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
                "Dominus Node API key is required. Set api_key in provider credentials "
                "or DOMINUSNODE_API_KEY environment variable."
            )

        with httpx.Client(
            timeout=self.timeout,
            follow_redirects=False,
        ) as client:
            resp = client.post(
                f"{self.base_url}/api/auth/verify-key",
                json={"apiKey": self.api_key},
                headers={
                    "User-Agent": "dominusnode-dify/1.0.0",
                    "Content-Type": "application/json",
                },
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
        """Ensure the provider is authenticated, authenticating if needed."""
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
                    "User-Agent": "dominusnode-dify/1.0.0",
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._token}",
                },
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

    def proxied_fetch(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Fetch a URL through the Dominus Node rotating proxy network.

        Args:
            params: Dict with keys: url (required), method, country, proxy_type.

        Returns:
            Dict with status, headers, and body (or error).
        """
        url = params.get("url")
        if not url or not isinstance(url, str):
            return {"error": "url is required and must be a string"}

        # Validate URL for SSRF
        try:
            validate_url(url)
        except ValueError as e:
            return {"error": str(e)}

        country = params.get("country")

        # OFAC country check
        if country:
            upper = country.upper()
            if upper in SANCTIONED_COUNTRIES:
                return {"error": f"Country '{upper}' is blocked (OFAC sanctioned country)"}

        # Restrict HTTP methods
        method = params.get("method", "GET")
        method_upper = (method or "GET").upper()
        if method_upper not in _ALLOWED_FETCH_METHODS:
            return {
                "error": (
                    f"HTTP method '{method_upper}' is not allowed. "
                    "Only GET, HEAD, OPTIONS are permitted."
                )
            }

        # Validate proxy_type
        proxy_type = params.get("proxy_type", "dc")
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

    def check_balance(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Check the current wallet balance.

        Args:
            params: Empty dict (no parameters needed).

        Returns:
            Dict with wallet balance information.
        """
        try:
            result = self._request_with_retry("GET", "/api/wallet")
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 3: check_usage
    # ==================================================================

    def check_usage(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Check proxy usage statistics.

        Args:
            params: Dict with optional key: period (day, week, month).

        Returns:
            Dict with usage statistics.
        """
        period = params.get("period", "month")
        if period not in ("day", "week", "month"):
            return {"error": "period must be 'day', 'week', or 'month'"}
        try:
            date_range = _period_to_date_range(period)
            result = self._request_with_retry(
                "GET",
                f"/api/usage?since={quote(date_range['since'], safe='')}"
                f"&until={quote(date_range['until'], safe='')}",
            )
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 4: get_proxy_config
    # ==================================================================

    def get_proxy_config(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Get proxy configuration information.

        Args:
            params: Empty dict (no parameters needed).

        Returns:
            Dict with proxy configuration.
        """
        try:
            result = self._request_with_retry("GET", "/api/proxy/config")
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 5: list_sessions
    # ==================================================================

    def list_sessions(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """List active proxy sessions.

        Args:
            params: Empty dict (no parameters needed).

        Returns:
            Dict with active session information.
        """
        try:
            result = self._request_with_retry("GET", "/api/sessions/active")
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 6: create_agentic_wallet
    # ==================================================================

    def create_agentic_wallet(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new agentic sub-wallet with a spending limit.

        Args:
            params: Dict with keys: label (required), spending_limit_cents (required),
                daily_limit_cents (optional), allowed_domains (optional).

        Returns:
            Dict with the created wallet details.
        """
        label = params.get("label")
        spending_limit_cents = params.get("spending_limit_cents")
        daily_limit_cents = params.get("daily_limit_cents")
        allowed_domains = params.get("allowed_domains")

        if label is None or spending_limit_cents is None:
            return {"error": "label and spending_limit_cents are required"}

        # Dify sends numbers as float; coerce to int
        if isinstance(spending_limit_cents, float) and spending_limit_cents == int(spending_limit_cents):
            spending_limit_cents = int(spending_limit_cents)

        err = _validate_label(label, "label")
        if err:
            return {"error": err}

        err = _validate_positive_int(spending_limit_cents, "spending_limit_cents")
        if err:
            return {"error": err}

        if daily_limit_cents is not None:
            if isinstance(daily_limit_cents, float) and daily_limit_cents == int(daily_limit_cents):
                daily_limit_cents = int(daily_limit_cents)
            err = _validate_positive_int(
                daily_limit_cents, "daily_limit_cents", max_value=1_000_000
            )
            if err:
                return {"error": err}

        if allowed_domains is not None:
            err = _validate_allowed_domains(allowed_domains)
            if err:
                return {"error": err}

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
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 7: fund_agentic_wallet
    # ==================================================================

    def fund_agentic_wallet(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Fund an agentic wallet from the main wallet.

        Args:
            params: Dict with keys: wallet_id (required), amount_cents (required).

        Returns:
            Dict with the updated wallet details.
        """
        wallet_id = params.get("wallet_id")
        amount_cents = params.get("amount_cents")

        if wallet_id is None or amount_cents is None:
            return {"error": "wallet_id and amount_cents are required"}

        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        # Dify sends numbers as float; coerce to int
        if isinstance(amount_cents, float) and amount_cents == int(amount_cents):
            amount_cents = int(amount_cents)

        err = _validate_positive_int(amount_cents, "amount_cents")
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "POST",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/fund",
                {"amountCents": amount_cents},
            )
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 8: agentic_wallet_balance
    # ==================================================================

    def agentic_wallet_balance(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Check the balance of an agentic wallet.

        Args:
            params: Dict with key: wallet_id (required).

        Returns:
            Dict with wallet balance details.
        """
        wallet_id = params.get("wallet_id")
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        try:
            result = self._request_with_retry(
                "GET",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}",
            )
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 9: list_agentic_wallets
    # ==================================================================

    def list_agentic_wallets(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """List all agentic wallets.

        Args:
            params: Empty dict (no parameters needed).

        Returns:
            Dict with a list of all agentic wallets.
        """
        try:
            result = self._request_with_retry("GET", "/api/agent-wallet")
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 10: agentic_transactions
    # ==================================================================

    def agentic_transactions(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Get transaction history for an agentic wallet.

        Args:
            params: Dict with keys: wallet_id (required), limit (optional, 1-100).

        Returns:
            Dict with transaction history.
        """
        wallet_id = params.get("wallet_id")
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        limit = params.get("limit", 20)
        # Dify sends numbers as float; coerce to int
        if isinstance(limit, float) and limit == int(limit):
            limit = int(limit)

        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
            return {"error": "limit must be an integer between 1 and 100"}

        qs = f"?limit={limit}" if limit != 20 else ""

        try:
            result = self._request_with_retry(
                "GET",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/transactions{qs}",
            )
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 11: freeze_agentic_wallet
    # ==================================================================

    def freeze_agentic_wallet(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Freeze an agentic wallet (prevent spending).

        Args:
            params: Dict with key: wallet_id (required).

        Returns:
            Dict confirming the wallet is frozen.
        """
        wallet_id = params.get("wallet_id")
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        try:
            result = self._request_with_retry(
                "POST",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/freeze",
            )
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 12: unfreeze_agentic_wallet
    # ==================================================================

    def unfreeze_agentic_wallet(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Unfreeze an agentic wallet (re-enable spending).

        Args:
            params: Dict with key: wallet_id (required).

        Returns:
            Dict confirming the wallet is unfrozen.
        """
        wallet_id = params.get("wallet_id")
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        try:
            result = self._request_with_retry(
                "POST",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/unfreeze",
            )
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 13: delete_agentic_wallet
    # ==================================================================

    def delete_agentic_wallet(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Delete an agentic wallet (must be unfrozen first; refunds balance).

        Args:
            params: Dict with key: wallet_id (required).

        Returns:
            Dict confirming deletion.
        """
        wallet_id = params.get("wallet_id")
        if not wallet_id or not isinstance(wallet_id, str):
            return {"error": "wallet_id is required and must be a string"}

        try:
            result = self._request_with_retry(
                "DELETE",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}",
            )
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 14: update_wallet_policy
    # ==================================================================

    def update_wallet_policy(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Update the policy for an agentic wallet.

        Args:
            params: Dict with keys: wallet_id (required),
                daily_limit_cents (optional), allowed_domains (optional).

        Returns:
            Dict with the updated wallet policy.
        """
        wallet_id = params.get("wallet_id")
        daily_limit_cents = params.get("daily_limit_cents")
        allowed_domains = params.get("allowed_domains")

        err = _validate_uuid(wallet_id, "wallet_id")
        if err:
            return {"error": err}

        body: Dict[str, Any] = {}

        if daily_limit_cents is not None:
            if isinstance(daily_limit_cents, float) and daily_limit_cents == int(daily_limit_cents):
                daily_limit_cents = int(daily_limit_cents)
            err = _validate_positive_int(
                daily_limit_cents, "daily_limit_cents", max_value=1_000_000
            )
            if err:
                return {"error": err}
            body["dailyLimitCents"] = daily_limit_cents

        if allowed_domains is not None:
            err = _validate_allowed_domains(allowed_domains)
            if err:
                return {"error": err}
            body["allowedDomains"] = allowed_domains

        try:
            result = self._request_with_retry(
                "PATCH",
                f"/api/agent-wallet/{quote(wallet_id, safe='')}/policy",
                body,
            )
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 15: create_team
    # ==================================================================

    def create_team(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new team with a shared wallet.

        Args:
            params: Dict with keys: name (required), max_members (optional, 1-100).

        Returns:
            Dict with the created team details.
        """
        name = params.get("name")
        if not name:
            return {"error": "name is required"}

        err = _validate_label(name, "name")
        if err:
            return {"error": err}

        body: Dict[str, Any] = {"name": name}

        max_members = params.get("max_members")
        if max_members is not None:
            # Dify sends numbers as float; coerce to int
            if isinstance(max_members, float) and max_members == int(max_members):
                max_members = int(max_members)
            err = _validate_positive_int(max_members, "max_members", max_value=100)
            if err:
                return {"error": err}
            body["maxMembers"] = max_members

        try:
            result = self._request_with_retry("POST", "/api/teams", body)
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 15: list_teams
    # ==================================================================

    def list_teams(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """List all teams the user belongs to.

        Args:
            params: Empty dict (no parameters needed).

        Returns:
            Dict with a list of teams.
        """
        try:
            result = self._request_with_retry("GET", "/api/teams")
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 16: team_details
    # ==================================================================

    def team_details(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Get details for a specific team.

        Args:
            params: Dict with key: team_id (required, UUID).

        Returns:
            Dict with team details.
        """
        team_id = params.get("team_id")
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        try:
            result = self._request_with_retry(
                "GET", f"/api/teams/{quote(team_id, safe='')}"
            )
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 17: team_fund
    # ==================================================================

    def team_fund(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Fund a team's shared wallet from the user's personal wallet.

        Args:
            params: Dict with keys: team_id (required), amount_cents (required, 100-1000000).

        Returns:
            Dict with the updated team wallet details.
        """
        team_id = params.get("team_id")
        amount_cents = params.get("amount_cents")

        if team_id is None or amount_cents is None:
            return {"error": "team_id and amount_cents are required"}

        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        # Dify sends numbers as float; coerce to int
        if isinstance(amount_cents, float) and amount_cents == int(amount_cents):
            amount_cents = int(amount_cents)

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
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 18: team_create_key
    # ==================================================================

    def team_create_key(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new API key for a team.

        Args:
            params: Dict with keys: team_id (required), label (required).

        Returns:
            Dict with the created API key (shown once).
        """
        team_id = params.get("team_id")
        label = params.get("label")

        if team_id is None or label is None:
            return {"error": "team_id and label are required"}

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
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 19: team_usage
    # ==================================================================

    def team_usage(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Get usage/transaction history for a team.

        Args:
            params: Dict with keys: team_id (required), limit (optional, 1-100).

        Returns:
            Dict with team usage/transaction history.
        """
        team_id = params.get("team_id")
        if not team_id:
            return {"error": "team_id is required"}

        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        limit = params.get("limit", 20)
        # Dify sends numbers as float; coerce to int
        if isinstance(limit, float) and limit == int(limit):
            limit = int(limit)

        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
            return {"error": "limit must be an integer between 1 and 100"}

        qs = f"?limit={limit}" if limit != 20 else ""

        try:
            result = self._request_with_retry(
                "GET",
                f"/api/teams/{quote(team_id, safe='')}/wallet/transactions{qs}",
            )
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 20: update_team
    # ==================================================================

    def update_team(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Update team settings (name and/or max_members).

        Args:
            params: Dict with keys: team_id (required), name (optional), max_members (optional).

        Returns:
            Dict with the updated team details.
        """
        team_id = params.get("team_id")
        if not team_id:
            return {"error": "team_id is required"}

        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        body: Dict[str, Any] = {}

        name = params.get("name")
        if name is not None:
            err = _validate_label(name, "name")
            if err:
                return {"error": err}
            body["name"] = name

        max_members = params.get("max_members")
        if max_members is not None:
            # Dify sends numbers as float; coerce to int
            if isinstance(max_members, float) and max_members == int(max_members):
                max_members = int(max_members)
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
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 21: update_team_member_role
    # ==================================================================

    def update_team_member_role(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Update the role of a team member.

        Args:
            params: Dict with keys: team_id (required), user_id (required),
                role (required, 'member' or 'admin').

        Returns:
            Dict confirming the role update.
        """
        team_id = params.get("team_id")
        user_id = params.get("user_id")
        role = params.get("role")

        if team_id is None or user_id is None or role is None:
            return {"error": "team_id, user_id, and role are required"}

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
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 22: x402_info
    # ==================================================================

    def x402_info(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Get x402 micropayment protocol information.

        Args:
            params: Empty dict (no parameters needed).

        Returns:
            Dict with x402 protocol information.
        """
        try:
            result = self._request_with_retry("GET", "/api/x402/info")
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool 23: topup_paypal
    # ==================================================================

    def topup_paypal(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Create a PayPal top-up order for the user's wallet.

        Args:
            params: Dict with key: amount_cents (required, 500-1000000).

        Returns:
            Dict with orderId and approvalUrl.
        """
        amount_cents = params.get("amount_cents")
        if amount_cents is None:
            return {"error": "amount_cents is required"}

        # Dify sends numbers as float; coerce to int
        if isinstance(amount_cents, float) and amount_cents == int(amount_cents):
            amount_cents = int(amount_cents)

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
            return result if isinstance(result, dict) else {"data": result}
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Tool dispatcher (Dify invokes tools by name)
    # ==================================================================

    def invoke_tool(self, tool_name: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """Dispatch a tool invocation by name.

        This is the main entry point for Dify to invoke tools.

        Args:
            tool_name: Tool name matching the YAML identity name.
            params: Dictionary of tool parameters.

        Returns:
            Dict with the tool result or error.
        """
        dispatch: Dict[str, Any] = {
            "proxied_fetch": self.proxied_fetch,
            "check_balance": self.check_balance,
            "check_usage": self.check_usage,
            "get_proxy_config": self.get_proxy_config,
            "list_sessions": self.list_sessions,
            "create_agentic_wallet": self.create_agentic_wallet,
            "fund_agentic_wallet": self.fund_agentic_wallet,
            "agentic_wallet_balance": self.agentic_wallet_balance,
            "list_agentic_wallets": self.list_agentic_wallets,
            "agentic_transactions": self.agentic_transactions,
            "freeze_agentic_wallet": self.freeze_agentic_wallet,
            "unfreeze_agentic_wallet": self.unfreeze_agentic_wallet,
            "delete_agentic_wallet": self.delete_agentic_wallet,
            "update_wallet_policy": self.update_wallet_policy,
            "create_team": self.create_team,
            "list_teams": self.list_teams,
            "team_details": self.team_details,
            "team_fund": self.team_fund,
            "team_create_key": self.team_create_key,
            "team_usage": self.team_usage,
            "update_team": self.update_team,
            "update_team_member_role": self.update_team_member_role,
            "x402_info": self.x402_info,
            "topup_paypal": self.topup_paypal,
        }

        handler = dispatch.get(tool_name)
        if handler is None:
            return {
                "error": f"Unknown tool: {tool_name}",
                "available_tools": sorted(dispatch.keys()),
            }

        try:
            return handler(params)
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    @staticmethod
    def get_tools() -> list[str]:
        """Return the list of all 22 tool names (plus topup_paypal = 23 entries).

        Returns:
            Sorted list of tool name strings.
        """
        return sorted([
            "proxied_fetch",
            "check_balance",
            "check_usage",
            "get_proxy_config",
            "list_sessions",
            "create_agentic_wallet",
            "fund_agentic_wallet",
            "agentic_wallet_balance",
            "list_agentic_wallets",
            "agentic_transactions",
            "freeze_agentic_wallet",
            "unfreeze_agentic_wallet",
            "delete_agentic_wallet",
            "update_wallet_policy",
            "create_team",
            "list_teams",
            "team_details",
            "team_fund",
            "team_create_key",
            "team_usage",
            "update_team",
            "update_team_member_role",
            "x402_info",
            "topup_paypal",
        ])
