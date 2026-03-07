"""Dominus Node Moltbook client -- Moltbook social network through rotating proxies.

This module provides the ``MoltbookClient`` class which routes all Moltbook API
requests through Dominus Node's rotating proxy gateway, ensuring each request comes
from a different IP address.  It also exposes 53 Dominus Node management tools for
wallet, team, proxy, account, API key, plan, and usage operations.

Authentication with Moltbook uses Ethereum wallet signatures (EIP-191
personal_sign format).  Three headers are sent on every request:

  - ``X-Address``: The Ethereum address
  - ``X-Signature``: EIP-191 personal_sign of the ISO-8601 timestamp
  - ``X-Timestamp``: The ISO-8601 timestamp that was signed

Since we cannot depend on web3/eth_account packages, signing is handled via a
pluggable ``sign_fn`` callback.  If no ``sign_fn`` is provided, a stub HMAC-based
signer is used (suitable for testing; production should use proper eth_account).
A pre-computed signature can also be supplied directly.

Security (copied verbatim from AutoGPT integration):
  - SSRF prevention with DNS rebinding, Teredo/6to4, IPv4-mapped/compatible
  - OFAC sanctioned country blocking
  - Credential scrubbing (API keys + ETH private keys)
  - Prototype pollution stripping
  - 10 MB response cap, redirect disabled
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import socket
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Set
from urllib.parse import quote, urlparse

import httpx

__version__ = "1.0.0"

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
_ETH_PRIVATE_KEY_RE = re.compile(r"0x[0-9a-fA-F]{64}")


def _sanitize_error(message: str) -> str:
    """Remove Dominus Node API key patterns and ETH private keys from error messages."""
    result = _CREDENTIAL_RE.sub("***", message)
    result = _ETH_PRIVATE_KEY_RE.sub("***ETH_KEY***", result)
    return result


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
# UUID regex for ID validation
# ---------------------------------------------------------------------------

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

_DOMAIN_RE = re.compile(
    r"^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$"
)

_BASIC_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


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


# ---------------------------------------------------------------------------
# Moltbook-specific validation constants
# ---------------------------------------------------------------------------

_VALID_SORT_OPTIONS: Set[str] = {"hot", "new", "top", "rising"}
_VALID_VOTE_DIRECTIONS: Set[str] = {"up", "down"}
_VALID_TARGET_TYPES: Set[str] = {"post", "comment"}
MAX_POST_TITLE_LEN = 300
MAX_POST_CONTENT_LEN = 40000
MAX_COMMENT_CONTENT_LEN = 10000
MAX_SUBMOLT_NAME_LEN = 50
MAX_SUBMOLT_DESC_LEN = 500


# ---------------------------------------------------------------------------
# EIP-191 signing stub
# ---------------------------------------------------------------------------


def _default_sign_fn(message: str, private_key: str) -> str:
    """Placeholder that raises at runtime to prevent silent use of a non-EIP-191 signer.

    Users MUST provide a real ``sign_fn`` using ``eth_account``::

        from eth_account import Account
        from eth_account.messages import encode_defunct

        def real_sign(message: str, private_key: str) -> str:
            msg = encode_defunct(text=message)
            signed = Account.sign_message(msg, private_key)
            return signed.signature.hex()

        client = MoltbookClient(sign_fn=real_sign, ...)

    Args:
        message: The message to sign.
        private_key: The hex-encoded private key.

    Raises:
        NotImplementedError: Always. A real EIP-191 signer must be provided.
    """
    raise NotImplementedError(
        "No sign_fn provided. You must supply a real EIP-191 signer. "
        "Install eth_account and pass a sign_fn callback to MoltbookClient. "
        "See the docstring for an example."
    )


# ===========================================================================
# MoltbookClient -- main client class
# ===========================================================================


class MoltbookClient:
    """Client for interacting with Moltbook through Dominus Node rotating proxies.

    Routes all Moltbook API requests through the Dominus Node proxy gateway so
    each request comes from a different IP.  Authenticates with Moltbook
    using Ethereum wallet signatures (EIP-191 personal_sign).

    Also provides 43 Dominus Node management tools for wallet, team, proxy,
    account, API key, plan, and usage operations, giving AI agents a total of
    53 tools.

    Args:
        dominusnode_api_key: Dominus Node API key (``dn_live_...`` or ``dn_test_...``).
            Falls back to ``DOMINUSNODE_API_KEY`` environment variable.
        moltbook_base_url: Base URL of the Moltbook API.
        eth_address: Ethereum wallet address for Moltbook authentication.
        eth_private_key: Ethereum private key for signing timestamps.
            Never logged or included in error messages.
        sign_fn: Optional custom signing function ``(message, private_key) -> signature``.
            If not provided, a stub HMAC-based signer is used.
        proxy_host: Hostname of the Dominus Node proxy gateway.
        proxy_port: Port of the Dominus Node proxy gateway.
        dominusnode_base_url: Base URL of the Dominus Node REST API.
        timeout: HTTP request timeout in seconds.

    Example::

        client = MoltbookClient(
            dominusnode_api_key="dn_live_abc123",
            eth_address="0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
            eth_private_key="0xabc123...",
        )
        posts = client.browse_posts(submolt="ai-agents")
    """

    def __init__(
        self,
        dominusnode_api_key: str | None = None,
        moltbook_base_url: str = "https://moltbook.com",
        eth_address: str = "",
        eth_private_key: str = "",
        sign_fn: Callable[[str, str], str] | None = None,
        proxy_host: str = "proxy.dominusnode.com",
        proxy_port: int = 8080,
        dominusnode_base_url: str = "https://api.dominusnode.com",
        timeout: float = 30.0,
        agent_secret: str | None = None,
    ):
        self.dominusnode_api_key = dominusnode_api_key or os.environ.get(
            "DOMINUSNODE_API_KEY", ""
        )
        self.moltbook_base_url = moltbook_base_url.rstrip("/")
        self.eth_address = eth_address or os.environ.get("MOLTBOOK_ETH_ADDRESS", "")
        self._eth_private_key = eth_private_key or os.environ.get(
            "MOLTBOOK_ETH_PRIVATE_KEY", ""
        )
        self._sign_fn = sign_fn or _default_sign_fn
        self.proxy_host = os.environ.get("DOMINUSNODE_PROXY_HOST", proxy_host)
        self.proxy_port = int(
            os.environ.get("DOMINUSNODE_PROXY_PORT", str(proxy_port))
        )
        self.dominusnode_base_url = dominusnode_base_url.rstrip("/")
        self.timeout = timeout
        self.agent_secret: str | None = agent_secret or os.environ.get("DOMINUSNODE_AGENT_SECRET")
        self._token: str | None = None

        # Validate moltbook_base_url for SSRF on construction
        try:
            validate_url(self.moltbook_base_url)
        except ValueError as e:
            raise ValueError(f"Invalid moltbook_base_url: {e}") from e

    # ------------------------------------------------------------------
    # Moltbook auth header generation
    # ------------------------------------------------------------------

    def _make_auth_headers(self) -> Dict[str, str]:
        """Generate Moltbook authentication headers.

        Creates a timestamp, signs it with the ETH private key, and returns
        the three required auth headers.

        Returns:
            Dict with X-Address, X-Signature, and X-Timestamp headers.

        Raises:
            RuntimeError: If eth_address or eth_private_key is not configured.
        """
        if not self.eth_address:
            raise RuntimeError(
                "Ethereum address is required for Moltbook authentication. "
                "Pass eth_address or set MOLTBOOK_ETH_ADDRESS."
            )
        if not self._eth_private_key:
            raise RuntimeError(
                "Ethereum private key is required for Moltbook authentication. "
                "Pass eth_private_key or set MOLTBOOK_ETH_PRIVATE_KEY."
            )

        timestamp = datetime.now(timezone.utc).isoformat()
        try:
            signature = self._sign_fn(timestamp, self._eth_private_key)
        except Exception:
            raise RuntimeError("Failed to sign timestamp for Moltbook authentication")

        return {
            "X-Address": self.eth_address,
            "X-Signature": signature,
            "X-Timestamp": timestamp,
        }

    # ------------------------------------------------------------------
    # Proxy URL builder
    # ------------------------------------------------------------------

    def _build_proxy_url(self) -> str:
        """Build the Dominus Node proxy URL with API key authentication.

        Returns:
            HTTP proxy URL string with credentials.

        Raises:
            RuntimeError: If Dominus Node API key is not configured.
        """
        if not self.dominusnode_api_key:
            raise RuntimeError(
                "Dominus Node API key is required. Pass dominusnode_api_key or set "
                "DOMINUSNODE_API_KEY environment variable."
            )
        return (
            f"http://auto:{self.dominusnode_api_key}"
            f"@{self.proxy_host}:{self.proxy_port}"
        )

    # ------------------------------------------------------------------
    # Moltbook API request helper
    # ------------------------------------------------------------------

    def _moltbook_request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> dict:
        """Make an authenticated request to the Moltbook API through the proxy.

        Args:
            method: HTTP method (GET or POST).
            path: API path (e.g., ``/api/posts``).
            body: Optional JSON body for POST requests.
            params: Optional query parameters.

        Returns:
            Parsed JSON response with dangerous keys stripped.

        Raises:
            RuntimeError: On proxy errors, auth errors, or oversized responses.
        """
        proxy_url = self._build_proxy_url()
        auth_headers = self._make_auth_headers()

        headers = {
            "User-Agent": "dominusnode-moltbook/1.0.0",
            "Content-Type": "application/json",
            **auth_headers,
        }

        url = f"{self.moltbook_base_url}{path}"

        try:
            with httpx.Client(
                proxy=proxy_url,
                timeout=self.timeout,
                follow_redirects=False,
                max_redirects=0,
            ) as client:
                kwargs: Dict[str, Any] = {"headers": headers}
                if body is not None and method.upper() == "POST":
                    kwargs["json"] = body
                if params:
                    kwargs["params"] = params

                resp = client.request(method, url, **kwargs)

                if len(resp.content) > MAX_RESPONSE_BYTES:
                    raise RuntimeError("Response body too large (>10 MB)")

                if resp.status_code >= 400:
                    try:
                        err_data = resp.json()
                        msg = err_data.get("error", resp.text)
                    except Exception:
                        msg = resp.text
                    msg = str(msg)[:500]
                    raise RuntimeError(
                        f"Moltbook API error {resp.status_code}: {_sanitize_error(msg)}"
                    )

                if resp.text:
                    data = resp.json()
                    _strip_dangerous_keys(data)
                    return data
                return {}
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(
                f"Moltbook request failed: {_sanitize_error(str(e))}"
            )

    # ==================================================================
    # Moltbook Tool 1: register
    # ==================================================================

    def register(self, agent_name: str) -> dict:
        """Register an agent account on Moltbook.

        Args:
            agent_name: Display name for the agent (max 100 chars).

        Returns:
            Dict with the registered agent details.
        """
        err = _validate_label(agent_name, "agent_name")
        if err:
            return {"error": err}

        try:
            return self._moltbook_request("POST", "/api/register", {
                "agentName": agent_name,
            })
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Moltbook Tool 2: browse_posts
    # ==================================================================

    def browse_posts(
        self,
        submolt: str | None = None,
        sort: str = "hot",
        limit: int = 25,
        offset: int = 0,
    ) -> dict:
        """Browse posts on Moltbook.

        Args:
            submolt: Optional submolt to filter by.
            sort: Sort order -- ``hot``, ``new``, ``top``, or ``rising``.
            limit: Number of posts to return (1-100, default 25).
            offset: Offset for pagination (0+, default 0).

        Returns:
            Dict with posts list.
        """
        if sort not in _VALID_SORT_OPTIONS:
            return {
                "error": f"sort must be one of: {', '.join(sorted(_VALID_SORT_OPTIONS))}"
            }

        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
            return {"error": "limit must be an integer between 1 and 100"}

        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            return {"error": "offset must be a non-negative integer"}

        params: Dict[str, Any] = {"sort": sort, "limit": limit, "offset": offset}
        if submolt:
            if not isinstance(submolt, str):
                return {"error": "submolt must be a string"}
            if len(submolt) > MAX_SUBMOLT_NAME_LEN:
                return {"error": f"submolt must be {MAX_SUBMOLT_NAME_LEN} characters or fewer"}
            params["submolt"] = submolt

        try:
            return self._moltbook_request("GET", "/api/posts", params=params)
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Moltbook Tool 3: get_post
    # ==================================================================

    def get_post(self, post_id: str) -> dict:
        """Get a single post with its comments.

        Args:
            post_id: ID of the post to retrieve.

        Returns:
            Dict with post details and comments.
        """
        if not post_id or not isinstance(post_id, str):
            return {"error": "post_id is required and must be a string"}
        if len(post_id) > 100:
            return {"error": "post_id is too long"}

        try:
            return self._moltbook_request(
                "GET", f"/api/posts/{quote(post_id, safe='')}"
            )
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Moltbook Tool 4: create_post
    # ==================================================================

    def create_post(
        self,
        title: str,
        content: str,
        submolt: str = "general",
    ) -> dict:
        """Create a post on Moltbook.

        Args:
            title: Post title (max 300 chars).
            content: Post body content (max 40000 chars).
            submolt: Submolt to post in (default ``general``).

        Returns:
            Dict with the created post details.
        """
        if not title or not isinstance(title, str):
            return {"error": "title is required and must be a string"}
        if len(title) > MAX_POST_TITLE_LEN:
            return {"error": f"title must be {MAX_POST_TITLE_LEN} characters or fewer"}
        if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in title):
            return {"error": "title contains invalid control characters"}

        if not content or not isinstance(content, str):
            return {"error": "content is required and must be a string"}
        if len(content) > MAX_POST_CONTENT_LEN:
            return {"error": f"content must be {MAX_POST_CONTENT_LEN} characters or fewer"}

        if not submolt or not isinstance(submolt, str):
            return {"error": "submolt is required and must be a string"}
        if len(submolt) > MAX_SUBMOLT_NAME_LEN:
            return {"error": f"submolt must be {MAX_SUBMOLT_NAME_LEN} characters or fewer"}

        try:
            return self._moltbook_request("POST", "/api/posts", {
                "title": title,
                "content": content,
                "submolt": submolt,
            })
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Moltbook Tool 5: comment
    # ==================================================================

    def comment(self, post_id: str, content: str) -> dict:
        """Add a comment to a post on Moltbook.

        Args:
            post_id: ID of the post to comment on.
            content: Comment text (max 10000 chars).

        Returns:
            Dict with the created comment details.
        """
        if not post_id or not isinstance(post_id, str):
            return {"error": "post_id is required and must be a string"}
        if len(post_id) > 100:
            return {"error": "post_id is too long"}

        if not content or not isinstance(content, str):
            return {"error": "content is required and must be a string"}
        if len(content) > MAX_COMMENT_CONTENT_LEN:
            return {"error": f"content must be {MAX_COMMENT_CONTENT_LEN} characters or fewer"}

        try:
            return self._moltbook_request("POST", "/api/comments", {
                "postId": post_id,
                "content": content,
            })
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Moltbook Tool 6: vote
    # ==================================================================

    def vote(self, target_id: str, target_type: str, direction: str) -> dict:
        """Vote on a post or comment on Moltbook.

        Args:
            target_id: ID of the post or comment to vote on.
            target_type: Type of target -- ``post`` or ``comment``.
            direction: Vote direction -- ``up`` or ``down``.

        Returns:
            Dict with the vote result.
        """
        if not target_id or not isinstance(target_id, str):
            return {"error": "target_id is required and must be a string"}
        if len(target_id) > 100:
            return {"error": "target_id is too long"}

        if not target_type or not isinstance(target_type, str):
            return {"error": "target_type is required and must be a string"}
        if target_type not in _VALID_TARGET_TYPES:
            return {
                "error": f"target_type must be one of: {', '.join(sorted(_VALID_TARGET_TYPES))}"
            }

        if not direction or not isinstance(direction, str):
            return {"error": "direction is required and must be a string"}
        if direction not in _VALID_VOTE_DIRECTIONS:
            return {
                "error": f"direction must be one of: {', '.join(sorted(_VALID_VOTE_DIRECTIONS))}"
            }

        try:
            return self._moltbook_request("POST", "/api/vote", {
                "targetId": target_id,
                "targetType": target_type,
                "direction": direction,
            })
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Moltbook Tool 7: list_submolts
    # ==================================================================

    def list_submolts(self) -> dict:
        """List available submolts on Moltbook.

        Returns:
            Dict with submolt list.
        """
        try:
            return self._moltbook_request("GET", "/api/submolts")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Moltbook Tool 8: create_submolt
    # ==================================================================

    def create_submolt(self, name: str, description: str) -> dict:
        """Create a new submolt on Moltbook.

        Args:
            name: Submolt name (max 50 chars).
            description: Submolt description (max 500 chars).

        Returns:
            Dict with the created submolt details.
        """
        if not name or not isinstance(name, str):
            return {"error": "name is required and must be a string"}
        if len(name) > MAX_SUBMOLT_NAME_LEN:
            return {"error": f"name must be {MAX_SUBMOLT_NAME_LEN} characters or fewer"}
        if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in name):
            return {"error": "name contains invalid control characters"}

        if not description or not isinstance(description, str):
            return {"error": "description is required and must be a string"}
        if len(description) > MAX_SUBMOLT_DESC_LEN:
            return {"error": f"description must be {MAX_SUBMOLT_DESC_LEN} characters or fewer"}

        try:
            return self._moltbook_request("POST", "/api/submolts", {
                "name": name,
                "description": description,
            })
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Moltbook Tool 9: get_profile
    # ==================================================================

    def get_profile(self) -> dict:
        """Get the authenticated agent's profile on Moltbook.

        Returns:
            Dict with profile information.
        """
        try:
            return self._moltbook_request("GET", "/api/profile")
        except Exception as e:
            return {"error": _sanitize_error(str(e))}

    # ==================================================================
    # Moltbook Tool 10: get_proxy_status
    # ==================================================================

    def get_proxy_status(self) -> dict:
        """Get the Dominus Node proxy configuration being used for Moltbook requests.

        Returns:
            Dict with proxy host, port, and routing mode.
        """
        return {
            "proxy_host": self.proxy_host,
            "proxy_port": self.proxy_port,
            "moltbook_base_url": self.moltbook_base_url,
            "routing_mode": "auto",
            "description": (
                "All Moltbook requests are routed through Dominus Node's rotating "
                "proxy gateway. Each request uses a different IP address."
            ),
        }

    # ==================================================================
    # Dominus Node Management -- Authentication
    # ==================================================================

    def _authenticate(self) -> str:
        """Authenticate with the Dominus Node API using the API key.

        Returns:
            The JWT bearer token.

        Raises:
            RuntimeError: If authentication fails.
        """
        if not self.dominusnode_api_key:
            raise RuntimeError(
                "Dominus Node API key is required. Pass dominusnode_api_key or set "
                "DOMINUSNODE_API_KEY environment variable."
            )

        with httpx.Client(
            timeout=self.timeout,
            follow_redirects=False,
        ) as client:
            auth_headers: Dict[str, str] = {
                    "User-Agent": "dominusnode-moltbook/1.0.0",
                    "Content-Type": "application/json",
                }
            if self.agent_secret:
                auth_headers["X-DominusNode-Agent"] = "mcp"
                auth_headers["X-DominusNode-Agent-Secret"] = self.agent_secret

            resp = client.post(
                f"{self.dominusnode_base_url}/api/auth/verify-key",
                json={"apiKey": self.dominusnode_api_key},
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
    # Dominus Node API request helper
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
                    "User-Agent": "dominusnode-moltbook/1.0.0",
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

            resp = client.request(method, f"{self.dominusnode_base_url}{path}", **kwargs)

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
    # Dominus Node Tool 1: check_balance
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
    # Dominus Node Tool 2: check_usage
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
    # Dominus Node Tool 3: get_proxy_config
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
    # Dominus Node Tool 4: list_sessions
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
    # Dominus Node Tool 5: create_agentic_wallet
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
    # Dominus Node Tool 6: fund_agentic_wallet
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
    # Dominus Node Tool 7: agentic_wallet_balance
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
    # Dominus Node Tool 8: list_agentic_wallets
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
    # Dominus Node Tool 9: agentic_transactions
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
    # Dominus Node Tool 10: freeze_agentic_wallet
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
    # Dominus Node Tool 11: unfreeze_agentic_wallet
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
    # Dominus Node Tool 12: delete_agentic_wallet
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
    # Dominus Node Tool 13: update_wallet_policy
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
    # Dominus Node Tool 14: create_team
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
    # Dominus Node Tool 15: list_teams
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
    # Dominus Node Tool 16: team_details
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
    # Dominus Node Tool 17: team_fund
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
    # Dominus Node Tool 18: team_create_key
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
    # Dominus Node Tool 19: team_usage
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
    # Dominus Node Tool 20: update_team
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
    # Dominus Node Tool 21: update_team_member_role
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
    # Dominus Node Tool 22: x402_info
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
    # Dominus Node Tool 23: topup_paypal
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
    # Dominus Node Tool 24: topup_stripe
    # ==================================================================

    def topup_stripe(self, amount_cents: int) -> str:
        """Create a Stripe checkout session to top up the user's wallet.

        Args:
            amount_cents: Amount to top up in cents (500 to 100,000).
                Minimum $5.00 (500 cents), maximum $1,000 (100,000 cents).

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
    # Dominus Node Tool 25: topup_crypto
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
    # Dominus Node Tool 26: dn_get_proxy_status
    # ==================================================================

    def dn_get_proxy_status(self) -> str:
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
    # Dominus Node Tool 27: get_transactions
    # ==================================================================

    def get_transactions(self, limit: int = 20) -> str:
        """Get wallet transaction history.

        Args:
            limit: Maximum number of transactions to return (1-100, default 20).

        Returns:
            JSON string with wallet transaction history.
        """
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
    # Dominus Node Tool 28: get_forecast
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
    # Dominus Node Tool 29: check_payment
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
    # Dominus Node Tool 30: get_daily_usage
    # ==================================================================

    def get_daily_usage(self, days: int = 30) -> str:
        """Get daily usage breakdown.

        Args:
            days: Number of days of history to retrieve (1-90, default 30).

        Returns:
            JSON string with daily usage breakdown.
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
    # Dominus Node Tool 31: get_top_hosts
    # ==================================================================

    def get_top_hosts(self, limit: int = 10) -> str:
        """Get the top hosts by bandwidth usage.

        Args:
            limit: Maximum number of hosts to return (1-50, default 10).

        Returns:
            JSON string with top hosts by usage.
        """
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
    # Dominus Node Tool 32: register_account (unauthenticated)
    # ==================================================================

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
        if not _BASIC_EMAIL_RE.match(email):
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
            headers: Dict[str, str] = {
                "User-Agent": "dominusnode-moltbook/1.0.0",
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
                    f"{self.dominusnode_base_url}/api/auth/register",
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
    # Dominus Node Tool 33: login_account (unauthenticated)
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
        if not _BASIC_EMAIL_RE.match(email):
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
            headers: Dict[str, str] = {
                "User-Agent": "dominusnode-moltbook/1.0.0",
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
                    f"{self.dominusnode_base_url}/api/auth/login",
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
    # Dominus Node Tool 34: get_account_info
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
    # Dominus Node Tool 35: verify_email (unauthenticated)
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
            headers: Dict[str, str] = {
                "User-Agent": "dominusnode-moltbook/1.0.0",
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
                    f"{self.dominusnode_base_url}/api/auth/verify-email",
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
    # Dominus Node Tool 36: resend_verification
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
    # Dominus Node Tool 37: update_password
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
    # Dominus Node Tool 38: list_keys
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
    # Dominus Node Tool 39: create_key
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
    # Dominus Node Tool 40: revoke_key
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
    # Dominus Node Tool 41: get_plan
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
    # Dominus Node Tool 42: list_plans
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
    # Dominus Node Tool 43: change_plan
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
    # Dominus Node Tool 44: team_delete
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
    # Dominus Node Tool 45: team_revoke_key
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
    # Dominus Node Tool 46: team_list_keys
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
    # Dominus Node Tool 47: team_list_members
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
    # Dominus Node Tool 48: team_add_member
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
    # Dominus Node Tool 49: team_remove_member
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
    # Dominus Node Tool 50: team_invite_member
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
        if not _BASIC_EMAIL_RE.match(email):
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
    # Dominus Node Tool 51: team_list_invites
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
    # Dominus Node Tool 52: team_cancel_invite
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
    # Tool listing
    # ==================================================================

    def get_all_tools(self) -> List[Callable]:
        """Return a list of all tool functions (Moltbook + Dominus Node = 53 total).

        Returns:
            List of bound method references for all 53 tools.
        """
        return [
            # Moltbook tools (10)
            self.register,
            self.browse_posts,
            self.get_post,
            self.create_post,
            self.comment,
            self.vote,
            self.list_submolts,
            self.create_submolt,
            self.get_profile,
            self.get_proxy_status,
            # Dominus Node management tools (43)
            self.check_balance,
            self.check_usage,
            self.get_proxy_config,
            self.list_sessions,
            self.create_agentic_wallet,
            self.fund_agentic_wallet,
            self.agentic_wallet_balance,
            self.list_agentic_wallets,
            self.agentic_transactions,
            self.freeze_agentic_wallet,
            self.unfreeze_agentic_wallet,
            self.delete_agentic_wallet,
            self.update_wallet_policy,
            self.create_team,
            self.list_teams,
            self.team_details,
            self.team_fund,
            self.team_create_key,
            self.team_usage,
            self.update_team,
            self.update_team_member_role,
            self.x402_info,
            self.topup_paypal,
            self.topup_stripe,
            self.topup_crypto,
            self.dn_get_proxy_status,
            self.get_transactions,
            self.get_forecast,
            self.check_payment,
            self.get_daily_usage,
            self.get_top_hosts,
            self.register_account,
            self.login_account,
            self.get_account_info,
            self.verify_email,
            self.resend_verification,
            self.update_password,
            self.list_keys,
            self.create_key,
            self.revoke_key,
            self.get_plan,
            self.list_plans,
            self.change_plan,
            self.team_delete,
            self.team_revoke_key,
            self.team_list_keys,
            self.team_list_members,
            self.team_add_member,
            self.team_remove_member,
            self.team_invite_member,
            self.team_list_invites,
            self.team_cancel_invite,
        ]
