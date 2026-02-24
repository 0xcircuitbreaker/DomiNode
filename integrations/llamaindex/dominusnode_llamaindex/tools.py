"""DomiNode LlamaIndex integration -- core client and security helpers.

Provides a ``DominusNodeClient`` that wraps the DomiNode REST API using
httpx, with full SSRF prevention, credential scrubbing, prototype
pollution protection, OFAC compliance, and 401 retry logic.

The client authenticates via the ``/api/auth/verify-key`` endpoint to
obtain a JWT, then uses Bearer auth for subsequent API calls.  Proxied
fetch requests are routed through the DomiNode proxy gateway using
CONNECT tunnels (HTTPS) or full-URL forwarding (HTTP).

Security:
    - SSRF: private IPs, hex/octal/decimal encoding, DNS rebinding,
      .localhost/.local/.internal/.arpa, embedded credentials, IPv6
      zone IDs, ::ffff: mapped, IPv4-compatible ::, Teredo 2001:0000::/32,
      6to4 2002::/16, CGNAT 100.64/10, multicast 224+
    - HTTP methods: GET/HEAD/OPTIONS only for proxied fetch
    - Response: 4000 char truncation, 10 MB body cap, 30 s timeout
    - OFAC: CU, IR, KP, RU, SY blocked
    - Redirects: disabled (follow_redirects=False)
    - Prototype pollution: strip __proto__/constructor/prototype
    - Credential scrubbing: dn_(live|test)_[a-zA-Z0-9]+ -> ***
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Set
from urllib.parse import quote, urlparse

import httpx

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_RESPONSE_CHARS: int = 4_000
"""Maximum characters returned from a proxied fetch to prevent LLM context overflow."""

MAX_RESPONSE_BYTES: int = 10 * 1024 * 1024
"""Maximum response body size in bytes (10 MB)."""

DEFAULT_TIMEOUT: float = 30.0
"""Default HTTP request timeout in seconds."""

ALLOWED_FETCH_METHODS: frozenset[str] = frozenset({"GET", "HEAD", "OPTIONS"})
"""HTTP methods permitted through the proxied fetch tool."""

SANCTIONED_COUNTRIES: frozenset[str] = frozenset({"CU", "IR", "KP", "RU", "SY"})
"""OFAC sanctioned countries -- requests geo-targeting these are blocked."""

_CREDENTIAL_RE = re.compile(r"dn_(live|test)_[a-zA-Z0-9]+")
"""Regex to match DomiNode API key patterns for scrubbing."""

_DANGEROUS_KEYS: frozenset[str] = frozenset({"__proto__", "constructor", "prototype"})
"""Keys that must be stripped from parsed JSON to prevent prototype pollution."""

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

BLOCKED_HOSTNAMES: frozenset[str] = frozenset({
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "0.0.0.0",
    "[::]",
    "metadata.google.internal",
    "169.254.169.254",
})

_BLOCKED_HEADER_NAMES: frozenset[str] = frozenset({
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "proxy-authorization",
    "authorization",
    "user-agent",
})

USER_AGENT = "dominusnode-llamaindex/1.0.0"

# ---------------------------------------------------------------------------
# SSRF Prevention
# ---------------------------------------------------------------------------


def normalize_ipv4(hostname: str) -> Optional[str]:
    """Normalize non-standard IPv4 representations to dotted-decimal.

    Handles hex (0x7f000001), octal (0177.0.0.1), and decimal integer
    (2130706433) forms to prevent SSRF bypasses.

    Args:
        hostname: The hostname string to normalize.

    Returns:
        Dotted-decimal IPv4 string if the input was a non-standard form,
        or None if it was not a recognizable encoded IP.
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


def is_private_ip(hostname: str) -> bool:
    """Check if a hostname resolves to a private/reserved IP range.

    Handles raw IPv4, raw IPv6 (bracket stripping, zone-ID removal),
    hex/octal/decimal encoded forms, IPv4-mapped IPv6 (::ffff:),
    IPv4-compatible IPv6 (::x.x.x.x), Teredo (2001:0000::/32),
    and 6to4 (2002::/16) tunneling addresses.

    Args:
        hostname: The hostname or IP address string to check.

    Returns:
        True if the address is private/reserved, False otherwise.
    """
    ip = hostname.strip("[]")

    # Strip IPv6 zone ID (%... suffix)
    zone_idx = ip.find("%")
    if zone_idx != -1:
        ip = ip[:zone_idx]

    # Normalize non-standard IPv4 forms
    normalized = normalize_ipv4(ip)
    check_ip = normalized if normalized else ip

    # IPv4 private ranges (dotted-decimal)
    ipv4_match = re.match(
        r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$", check_ip
    )
    if ipv4_match:
        a, b = int(ipv4_match.group(1)), int(ipv4_match.group(2))
        if a == 0:
            return True  # 0.0.0.0/8
        if a == 10:
            return True  # 10.0.0.0/8
        if a == 127:
            return True  # 127.0.0.0/8
        if a == 169 and b == 254:
            return True  # 169.254.0.0/16 link-local
        if a == 172 and 16 <= b <= 31:
            return True  # 172.16.0.0/12
        if a == 192 and b == 168:
            return True  # 192.168.0.0/16
        if a == 100 and 64 <= b <= 127:
            return True  # 100.64.0.0/10 CGNAT
        if a >= 224:
            return True  # 224+ multicast + reserved
        return False

    # IPv6 private ranges
    ip_lower = check_ip.lower()

    if ip_lower == "::1":
        return True  # loopback
    if ip_lower == "::":
        return True  # unspecified

    # ULA fc00::/7
    if ip_lower.startswith("fc") or ip_lower.startswith("fd"):
        return True
    # Link-local fe80::/10
    if ip_lower.startswith("fe80"):
        return True

    # IPv4-mapped IPv6 (::ffff:x.x.x.x)
    if ip_lower.startswith("::ffff:"):
        embedded = ip_lower[7:]
        if "." in embedded:
            return is_private_ip(embedded)
        # Hex form ::ffff:7f00:1
        hex_parts = embedded.split(":")
        if len(hex_parts) == 2:
            try:
                hi = int(hex_parts[0], 16)
                lo = int(hex_parts[1], 16)
                reconstructed = (
                    f"{(hi >> 8) & 0xFF}.{hi & 0xFF}"
                    f".{(lo >> 8) & 0xFF}.{lo & 0xFF}"
                )
                return is_private_ip(reconstructed)
            except ValueError:
                pass
        return is_private_ip(embedded)

    # IPv6 multicast (ff00::/8)
    if ip_lower.startswith("ff"):
        return True

    # IPv4-compatible IPv6 (::x.x.x.x) -- deprecated but still parsed
    ipv4_compat_match = re.match(
        r"^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$", ip_lower
    )
    if ipv4_compat_match:
        return is_private_ip(ipv4_compat_match.group(1))

    # IPv4-compatible IPv6 hex form (::7f00:1)
    if ip_lower.startswith("::") and not ip_lower.startswith("::ffff:"):
        try:
            addr = ipaddress.IPv6Address(ip_lower)
            packed = addr.packed
            if all(b == 0 for b in packed[:12]):
                embedded_v4 = ipaddress.IPv4Address(packed[12:16])
                if embedded_v4.is_private or embedded_v4.is_loopback or embedded_v4.is_reserved:
                    return True
        except (ValueError, ipaddress.AddressValueError):
            pass

    # Teredo tunneling (2001:0000::/32) -- embeds IPv4 addresses
    if ip_lower.startswith("2001:0000:") or ip_lower.startswith("2001:0:"):
        return True

    # 6to4 tunneling (2002::/16) -- embeds IPv4 address in bits 16-47
    if ip_lower.startswith("2002:"):
        # Extract the embedded IPv4 from the 2002:AABB:CCDD:: form
        try:
            addr = ipaddress.ip_address(ip_lower)
            # 6to4: bits 16-47 contain the IPv4 address
            packed = addr.packed
            embedded_ipv4 = f"{packed[2]}.{packed[3]}.{packed[4]}.{packed[5]}"
            return is_private_ip(embedded_ipv4)
        except (ValueError, IndexError):
            return True  # Malformed 6to4 -- block conservatively

    return False


def validate_url(url: str) -> str:
    """Validate a URL for SSRF safety.

    Checks scheme (http/https only), hostname against blocked lists,
    private IP ranges (including encoded forms), DNS rebinding via
    resolution, embedded credentials, and dangerous TLD suffixes.

    Args:
        url: The URL to validate.

    Returns:
        The validated URL string (unchanged).

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

    if hostname in BLOCKED_HOSTNAMES:
        raise ValueError("Requests to localhost/loopback addresses are blocked")

    if is_private_ip(hostname):
        raise ValueError("Requests to private/internal IP addresses are blocked")

    # .localhost TLD (RFC 6761)
    if hostname.endswith(".localhost"):
        raise ValueError("Requests to localhost/loopback addresses are blocked")

    # Dangerous TLD suffixes
    if (
        hostname.endswith(".local")
        or hostname.endswith(".internal")
        or hostname.endswith(".arpa")
    ):
        raise ValueError("Requests to internal network hostnames are blocked")

    # Block embedded credentials in URL
    if parsed.username or parsed.password:
        raise ValueError("URLs with embedded credentials are not allowed")

    # DNS rebinding protection: resolve hostname and check all IPs
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        # It is a hostname, not a raw IP -- try resolving
        try:
            infos = socket.getaddrinfo(
                hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM
            )
            for _family, _type, _proto, _canonname, sockaddr in infos:
                addr_str = sockaddr[0]
                if "%" in addr_str:
                    addr_str = addr_str.split("%")[0]
                if is_private_ip(addr_str):
                    raise ValueError(
                        f"Hostname {hostname!r} resolves to private IP {addr_str}"
                    )
        except socket.gaierror:
            raise ValueError(f"Could not resolve hostname: {hostname!r}")

    return url


# ---------------------------------------------------------------------------
# Credential sanitization
# ---------------------------------------------------------------------------


def sanitize_error(message: str) -> str:
    """Remove DomiNode API key patterns from error messages.

    Args:
        message: The error message to sanitize.

    Returns:
        The message with all API key patterns replaced by ``***``.
    """
    return _CREDENTIAL_RE.sub("***", message)


# ---------------------------------------------------------------------------
# Prototype pollution prevention
# ---------------------------------------------------------------------------


def strip_dangerous_keys(obj: Any, depth: int = 0) -> None:
    """Remove prototype pollution keys from parsed JSON.

    Recursively removes ``__proto__``, ``constructor``, and ``prototype``
    keys from dicts, and recurses into lists.  Depth is capped at 50 to
    prevent stack overflow on deeply nested structures.

    Args:
        obj: The parsed JSON object (dict or list) to sanitize.
        depth: Current recursion depth (internal use).
    """
    if depth > 50 or obj is None or not isinstance(obj, (dict, list)):
        return
    if isinstance(obj, list):
        for item in obj:
            strip_dangerous_keys(item, depth + 1)
        return
    keys_to_remove = [k for k in obj if k in _DANGEROUS_KEYS]
    for k in keys_to_remove:
        del obj[k]
    for v in obj.values():
        if isinstance(v, (dict, list)):
            strip_dangerous_keys(v, depth + 1)


# ---------------------------------------------------------------------------
# Period to date range helper
# ---------------------------------------------------------------------------


def _period_to_date_range(period: str) -> Dict[str, str]:
    """Convert a human-readable period to ISO date range query parameters.

    Args:
        period: One of ``'day'``, ``'week'``, or ``'month'`` (default).

    Returns:
        Dict with ``'since'`` and ``'until'`` ISO datetime strings.
    """
    now = datetime.now(timezone.utc)
    until = now.isoformat()

    if period == "day":
        since = (now - timedelta(days=1)).isoformat()
    elif period == "week":
        since = (now - timedelta(weeks=1)).isoformat()
    else:  # month
        since = (now - timedelta(days=30)).isoformat()

    return {"since": since, "until": until}


# ---------------------------------------------------------------------------
# Input validation helpers
# ---------------------------------------------------------------------------


def _validate_label(label: str, field_name: str = "label") -> Optional[str]:
    """Validate a text label for control chars and length.

    Returns an error string or None if valid.
    """
    if not label or not isinstance(label, str):
        return f"{field_name} is required and must be a non-empty string"
    if len(label) > 100:
        return f"{field_name} must be 100 characters or fewer"
    if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in label):
        return f"{field_name} contains invalid control characters"
    return None


def _validate_uuid(value: str, field_name: str = "id") -> Optional[str]:
    """Validate a UUID string.  Returns an error string or None if valid."""
    if not value or not isinstance(value, str):
        return f"{field_name} is required and must be a string"
    if not _UUID_RE.match(value):
        return f"{field_name} must be a valid UUID"
    return None


def _validate_amount_cents(
    amount_cents: Any,
    field_name: str = "amount_cents",
    min_val: int = 1,
    max_val: int = 2_147_483_647,
) -> Optional[str]:
    """Validate an integer cent amount.  Returns an error string or None if valid."""
    if isinstance(amount_cents, bool) or not isinstance(amount_cents, int) or amount_cents < min_val or amount_cents > max_val:
        return f"{field_name} must be an integer between {min_val} and {max_val}"
    return None


# ---------------------------------------------------------------------------
# DominusNodeClient
# ---------------------------------------------------------------------------


class DominusNodeClient:
    """HTTP client for the DomiNode REST API with JWT authentication.

    Authenticates using an API key via the ``/api/auth/verify-key`` endpoint
    to obtain a JWT token, then uses Bearer authentication for all subsequent
    API calls.  Automatically retries on 401 (token expired) by
    re-authenticating.

    Proxied fetch requests are routed through the DomiNode proxy gateway
    (CONNECT tunnel for HTTPS, full-URL forwarding for HTTP).

    Args:
        api_key: DomiNode API key (starts with ``dn_live_`` or ``dn_test_``).
            Falls back to ``DOMINUSNODE_API_KEY`` environment variable.
        base_url: Base URL for the DomiNode REST API.
            Falls back to ``DOMINUSNODE_BASE_URL`` or ``https://api.dominusnode.com``.
        proxy_host: Hostname of the DomiNode proxy gateway.
            Falls back to ``DOMINUSNODE_PROXY_HOST`` or ``proxy.dominusnode.com``.
        proxy_port: Port of the DomiNode proxy gateway.
            Falls back to ``DOMINUSNODE_PROXY_PORT`` or ``8080``.
        timeout: HTTP request timeout in seconds.  Defaults to 30.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        proxy_host: Optional[str] = None,
        proxy_port: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> None:
        self._api_key = api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        if not self._api_key:
            raise ValueError(
                "A DomiNode API key is required.  Pass api_key= or set the "
                "DOMINUSNODE_API_KEY environment variable."
            )

        self._base_url = (
            base_url
            or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        ).rstrip("/")

        self._proxy_host = proxy_host or os.environ.get(
            "DOMINUSNODE_PROXY_HOST", "proxy.dominusnode.com"
        )

        proxy_port_env = os.environ.get("DOMINUSNODE_PROXY_PORT", "8080")
        self._proxy_port = proxy_port if proxy_port is not None else int(proxy_port_env)

        self._timeout = timeout if timeout is not None else DEFAULT_TIMEOUT
        self._auth_token: Optional[str] = None

    # ----- Authentication --------------------------------------------------

    def _ensure_auth(self) -> None:
        """Authenticate with the DomiNode API if not already authenticated.

        Sends the API key to ``/api/auth/verify-key`` and stores the
        resulting JWT token for subsequent requests.

        Raises:
            RuntimeError: If authentication fails.
        """
        if self._auth_token is not None:
            return

        with httpx.Client(
            timeout=self._timeout,
            follow_redirects=False,
        ) as client:
            resp = client.post(
                f"{self._base_url}/api/auth/verify-key",
                json={"apiKey": self._api_key},
                headers={
                    "User-Agent": USER_AGENT,
                    "Content-Type": "application/json",
                },
            )

            if resp.status_code != 200:
                body = resp.text[:500]
                raise RuntimeError(
                    f"Authentication failed ({resp.status_code}): "
                    f"{sanitize_error(body)}"
                )

            data = resp.json()
            token = data.get("token")
            if not token:
                raise RuntimeError("Authentication response missing token")
            self._auth_token = token

    # ----- Authenticated API request ---------------------------------------

    def _api_request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        _retried: bool = False,
    ) -> Any:
        """Make an authenticated API request with automatic 401 retry.

        Args:
            method: HTTP method (GET, POST, PUT, PATCH, DELETE).
            path: API path (e.g., ``/api/wallet``).
            body: Optional JSON body for POST/PUT/PATCH requests.
            _retried: Internal flag to prevent infinite retry loops.

        Returns:
            Parsed JSON response (dict or list).

        Raises:
            RuntimeError: On authentication failure or API errors.
        """
        self._ensure_auth()

        with httpx.Client(
            timeout=self._timeout,
            follow_redirects=False,
        ) as client:
            kwargs: Dict[str, Any] = {
                "headers": {
                    "User-Agent": USER_AGENT,
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._auth_token}",
                },
            }

            if body is not None and method.upper() not in ("GET", "HEAD", "OPTIONS"):
                kwargs["json"] = body

            resp = client.request(method, f"{self._base_url}{path}", **kwargs)

            if len(resp.content) > MAX_RESPONSE_BYTES:
                raise RuntimeError("Response body too large (exceeds 10 MB)")

            # 401 retry: re-authenticate and retry once
            if resp.status_code == 401 and not _retried:
                self._auth_token = None
                return self._api_request(method, path, body, _retried=True)

            if resp.status_code >= 400:
                try:
                    err_data = resp.json()
                    msg = err_data.get("error", resp.text)
                except Exception:
                    msg = resp.text
                msg = str(msg)[:500]
                raise RuntimeError(
                    f"API error {resp.status_code}: {sanitize_error(msg)}"
                )

            if resp.text:
                data = resp.json()
                strip_dangerous_keys(data)
                return data
            return {}

    # ----- Tool methods ----------------------------------------------------

    def proxied_fetch(
        self,
        url: str,
        method: str = "GET",
        country: Optional[str] = None,
        proxy_type: str = "dc",
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Fetch a URL through the DomiNode proxy gateway.

        Routes the request through the DomiNode proxy using the API key
        in the Proxy-Authorization password field for authentication and
        the routing options (pool type, country) in the username field.

        Args:
            url: The URL to fetch (http or https).
            method: HTTP method (GET, HEAD, or OPTIONS only).
            country: ISO 3166-1 alpha-2 country code for geo-targeting.
            proxy_type: ``'dc'`` for datacenter ($3/GB) or ``'residential'`` ($5/GB).
            headers: Optional dict of extra headers to include.

        Returns:
            Dict with ``status``, ``headers``, and ``body`` keys.
        """
        # SSRF validation
        try:
            validate_url(url)
        except ValueError as e:
            return {"error": str(e)}

        # HTTP method restriction
        method_upper = method.upper()
        if method_upper not in ALLOWED_FETCH_METHODS:
            return {
                "error": (
                    f"HTTP method '{method_upper}' is not allowed. "
                    "Only GET, HEAD, OPTIONS are permitted."
                )
            }

        # Proxy type validation
        if proxy_type not in ("dc", "residential"):
            return {"error": "proxy_type must be 'dc' or 'residential'"}

        # OFAC sanctioned country check
        if country:
            upper_country = country.upper()
            if upper_country in SANCTIONED_COUNTRIES:
                return {
                    "error": f"Country '{upper_country}' is blocked (OFAC sanctioned country)"
                }

        # Build proxy username for routing (hyphens, not underscores)
        parts: list[str] = []
        if proxy_type and proxy_type != "auto":
            parts.append(proxy_type)
        if country:
            parts.append(f"country-{country.upper()}")
        username = "-".join(parts) if parts else "auto"

        proxy_url = (
            f"http://{username}:{self._api_key}"
            f"@{self._proxy_host}:{self._proxy_port}"
        )

        # Sanitize headers
        safe_headers: Dict[str, str] = {}
        if headers:
            for key, value in headers.items():
                if key.lower() in _BLOCKED_HEADER_NAMES:
                    continue
                # CRLF injection prevention
                if "\r" in key or "\n" in key or "\0" in key:
                    continue
                val_str = str(value)
                if "\r" in val_str or "\n" in val_str or "\0" in val_str:
                    continue
                safe_headers[key] = val_str

        try:
            with httpx.Client(
                proxy=proxy_url,
                timeout=self._timeout,
                follow_redirects=False,
            ) as proxy_client:
                resp = proxy_client.request(
                    method=method_upper,
                    url=url,
                    headers=safe_headers,
                )

                # Body size cap
                if len(resp.content) > MAX_RESPONSE_BYTES:
                    return {"error": "Response too large (exceeds 10 MB limit)"}

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
                "error": f"Proxy fetch failed: {sanitize_error(str(e))}",
                "hint": "Ensure the DomiNode proxy gateway is running and accessible.",
            }

    def check_balance(self) -> Dict[str, Any]:
        """Check the current wallet balance.

        Returns:
            Dict with wallet balance information (balanceCents, balanceUsd, currency).
        """
        return self._api_request("GET", "/api/wallet")

    def check_usage(self, period: str = "month") -> Dict[str, Any]:
        """Check proxy usage statistics for a time period.

        Args:
            period: Time period -- ``'day'``, ``'week'``, or ``'month'`` (default).

        Returns:
            Dict with usage summary, records, and period info.
        """
        if period not in ("day", "week", "month"):
            return {"error": "period must be 'day', 'week', or 'month'"}

        date_range = _period_to_date_range(period)
        return self._api_request(
            "GET",
            f"/api/usage?since={quote(date_range['since'], safe='')}"
            f"&until={quote(date_range['until'], safe='')}",
        )

    def get_proxy_config(self) -> Dict[str, Any]:
        """Get the current proxy configuration.

        Returns:
            Dict with proxy endpoints, supported countries, geo-targeting features.
        """
        return self._api_request("GET", "/api/proxy/config")

    def list_sessions(self) -> Dict[str, Any]:
        """List currently active proxy sessions.

        Returns:
            Dict with active session information.
        """
        return self._api_request("GET", "/api/sessions/active")

    # ----- Agentic Wallet methods ------------------------------------------

    def create_agentic_wallet(
        self, label: str, spending_limit_cents: int
    ) -> Dict[str, Any]:
        """Create a new agentic wallet (server-side custodial sub-wallet).

        Args:
            label: Human-readable label for the wallet (max 100 chars).
            spending_limit_cents: Per-transaction spending limit in cents (positive int).

        Returns:
            Dict with the created wallet details.
        """
        err = _validate_label(label, "label")
        if err:
            return {"error": err}

        err = _validate_amount_cents(spending_limit_cents, "spending_limit_cents")
        if err:
            return {"error": err}

        return self._api_request("POST", "/api/agent-wallet", {
            "label": label,
            "spendingLimitCents": spending_limit_cents,
        })

    def fund_agentic_wallet(
        self, wallet_id: str, amount_cents: int
    ) -> Dict[str, Any]:
        """Fund an agentic wallet from the main wallet.

        Args:
            wallet_id: UUID of the agentic wallet.
            amount_cents: Amount to transfer in cents (positive int).

        Returns:
            Dict with the updated wallet balance.
        """
        err = _validate_uuid(wallet_id, "wallet_id")
        if err:
            return {"error": err}

        err = _validate_amount_cents(amount_cents, "amount_cents")
        if err:
            return {"error": err}

        return self._api_request(
            "POST",
            f"/api/agent-wallet/{quote(wallet_id, safe='')}/fund",
            {"amountCents": amount_cents},
        )

    def agentic_wallet_balance(self, wallet_id: str) -> Dict[str, Any]:
        """Check the balance of an agentic wallet.

        Args:
            wallet_id: UUID of the agentic wallet.

        Returns:
            Dict with wallet balance and configuration.
        """
        err = _validate_uuid(wallet_id, "wallet_id")
        if err:
            return {"error": err}

        return self._api_request(
            "GET",
            f"/api/agent-wallet/{quote(wallet_id, safe='')}",
        )

    def list_agentic_wallets(self) -> Dict[str, Any]:
        """List all agentic wallets owned by the authenticated user.

        Returns:
            Dict (or list) with all agentic wallets.
        """
        return self._api_request("GET", "/api/agent-wallet")

    def agentic_transactions(
        self, wallet_id: str, limit: int = 20
    ) -> Dict[str, Any]:
        """List transactions for an agentic wallet.

        Args:
            wallet_id: UUID of the agentic wallet.
            limit: Maximum number of transactions to return (1-100).

        Returns:
            Dict with transaction records.
        """
        err = _validate_uuid(wallet_id, "wallet_id")
        if err:
            return {"error": err}

        if not isinstance(limit, int) or limit < 1 or limit > 100:
            return {"error": "limit must be an integer between 1 and 100"}

        return self._api_request(
            "GET",
            f"/api/agent-wallet/{quote(wallet_id, safe='')}/transactions?limit={limit}",
        )

    def freeze_agentic_wallet(self, wallet_id: str) -> Dict[str, Any]:
        """Freeze an agentic wallet (prevent spending).

        Args:
            wallet_id: UUID of the agentic wallet.

        Returns:
            Dict with the updated wallet status.
        """
        err = _validate_uuid(wallet_id, "wallet_id")
        if err:
            return {"error": err}

        return self._api_request(
            "POST",
            f"/api/agent-wallet/{quote(wallet_id, safe='')}/freeze",
        )

    def unfreeze_agentic_wallet(self, wallet_id: str) -> Dict[str, Any]:
        """Unfreeze an agentic wallet (allow spending again).

        Args:
            wallet_id: UUID of the agentic wallet.

        Returns:
            Dict with the updated wallet status.
        """
        err = _validate_uuid(wallet_id, "wallet_id")
        if err:
            return {"error": err}

        return self._api_request(
            "POST",
            f"/api/agent-wallet/{quote(wallet_id, safe='')}/unfreeze",
        )

    def delete_agentic_wallet(self, wallet_id: str) -> Dict[str, Any]:
        """Delete an agentic wallet (must be unfrozen first, refunds balance).

        Args:
            wallet_id: UUID of the agentic wallet.

        Returns:
            Dict confirming deletion and any refunded balance.
        """
        err = _validate_uuid(wallet_id, "wallet_id")
        if err:
            return {"error": err}

        return self._api_request(
            "DELETE",
            f"/api/agent-wallet/{quote(wallet_id, safe='')}",
        )

    # ----- Team methods ----------------------------------------------------

    def create_team(
        self, name: str, max_members: Optional[int] = None
    ) -> Dict[str, Any]:
        """Create a new team with a shared wallet.

        Args:
            name: Team name (max 100 chars, no control characters).
            max_members: Optional maximum team size (1-100).

        Returns:
            Dict with the created team details.
        """
        err = _validate_label(name, "name")
        if err:
            return {"error": err}

        body: Dict[str, Any] = {"name": name}

        if max_members is not None:
            if not isinstance(max_members, int) or max_members < 1 or max_members > 100:
                return {
                    "error": "max_members must be an integer between 1 and 100"
                }
            body["maxMembers"] = max_members

        return self._api_request("POST", "/api/teams", body)

    def list_teams(self) -> Dict[str, Any]:
        """List all teams the authenticated user belongs to.

        Returns:
            Dict (or list) with team information.
        """
        return self._api_request("GET", "/api/teams")

    def team_details(self, team_id: str) -> Dict[str, Any]:
        """Get detailed information about a team.

        Args:
            team_id: UUID of the team.

        Returns:
            Dict with team details, members, wallet, and keys.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        return self._api_request(
            "GET",
            f"/api/teams/{quote(team_id, safe='')}",
        )

    def team_fund(self, team_id: str, amount_cents: int) -> Dict[str, Any]:
        """Fund a team wallet from the authenticated user's wallet.

        Args:
            team_id: UUID of the team.
            amount_cents: Amount to transfer in cents (100-1,000,000).

        Returns:
            Dict with the updated team wallet balance.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        err = _validate_amount_cents(
            amount_cents, "amount_cents", min_val=100, max_val=1_000_000
        )
        if err:
            return {"error": err}

        return self._api_request(
            "POST",
            f"/api/teams/{quote(team_id, safe='')}/wallet/fund",
            {"amountCents": amount_cents},
        )

    def team_create_key(self, team_id: str, label: str) -> Dict[str, Any]:
        """Create an API key scoped to a team (bills to team wallet).

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

        return self._api_request(
            "POST",
            f"/api/teams/{quote(team_id, safe='')}/keys",
            {"label": label},
        )

    def team_usage(self, team_id: str, limit: int = 20) -> Dict[str, Any]:
        """Get team wallet transaction history.

        Args:
            team_id: UUID of the team.
            limit: Maximum number of transactions to return (1-100).

        Returns:
            Dict with team wallet transactions.
        """
        err = _validate_uuid(team_id, "team_id")
        if err:
            return {"error": err}

        if not isinstance(limit, int) or limit < 1 or limit > 100:
            return {"error": "limit must be an integer between 1 and 100"}

        qs = f"?limit={limit}"
        return self._api_request(
            "GET",
            f"/api/teams/{quote(team_id, safe='')}/wallet/transactions{qs}",
        )

    def update_team(
        self,
        team_id: str,
        name: Optional[str] = None,
        max_members: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Update team settings (name and/or max_members).

        Args:
            team_id: UUID of the team.
            name: New team name (max 100 chars).
            max_members: New maximum team size (1-100).

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
            if not isinstance(max_members, int) or max_members < 1 or max_members > 100:
                return {
                    "error": "max_members must be an integer between 1 and 100"
                }
            body["maxMembers"] = max_members

        if not body:
            return {
                "error": "At least one of name or max_members must be provided"
            }

        return self._api_request(
            "PATCH",
            f"/api/teams/{quote(team_id, safe='')}",
            body,
        )

    def update_team_member_role(
        self, team_id: str, user_id: str, role: str
    ) -> Dict[str, Any]:
        """Update a team member's role.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the user whose role to change.
            role: New role -- ``'member'`` or ``'admin'``.

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

        return self._api_request(
            "PATCH",
            f"/api/teams/{quote(team_id, safe='')}/members/{quote(user_id, safe='')}",
            {"role": role},
        )

    # ----- PayPal top-up ---------------------------------------------------

    def topup_paypal(self, amount_cents: int) -> Dict[str, Any]:
        """Create a PayPal order for wallet top-up.

        Creates a PayPal checkout order.  The returned order contains an
        ``approvalUrl`` that the user should visit to complete payment,
        and an ``orderId`` that can be used to capture the payment after
        approval.

        Args:
            amount_cents: Amount to top up in cents (500-1,000,000 i.e. $5-$10,000).

        Returns:
            Dict with ``orderId`` and ``approvalUrl`` for PayPal checkout.
        """
        err = _validate_amount_cents(
            amount_cents, "amount_cents", min_val=500, max_val=1_000_000
        )
        if err:
            return {"error": err}

        return self._api_request(
            "POST",
            "/api/wallet/topup/paypal",
            {"amountCents": amount_cents},
        )
