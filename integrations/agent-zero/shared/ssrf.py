"""SSRF (Server-Side Request Forgery) prevention utilities.

Provides URL validation, private IP detection (IPv4 + IPv6), DNS rebinding
protection, and normalisation of non-standard IPv4 representations
(hex, octal, decimal integer).

Every proxied-fetch tool MUST call ``validate_url`` before issuing any
outbound HTTP request.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from typing import Optional
from urllib.parse import urlparse

from .constants import BLOCKED_HOSTNAMES

# ---------------------------------------------------------------------------
# IPv4 normalisation (hex / octal / decimal integer)
# ---------------------------------------------------------------------------


def normalize_ipv4(hostname: str) -> Optional[str]:
    """Normalise non-standard IPv4 representations to dotted-decimal.

    Handles:
    - Single decimal integer (``2130706433`` -> ``127.0.0.1``)
    - Hex notation (``0x7f000001`` -> ``127.0.0.1``)
    - Octal or mixed-radix octets (``0177.0.0.1`` -> ``127.0.0.1``)

    Returns ``None`` if *hostname* is not a recognisable IPv4 variant.
    """
    # Single decimal integer (e.g. 2130706433 = 127.0.0.1)
    if re.match(r"^\d+$", hostname):
        n = int(hostname)
        if 0 <= n <= 0xFFFFFFFF:
            return (
                f"{(n >> 24) & 0xFF}.{(n >> 16) & 0xFF}"
                f".{(n >> 8) & 0xFF}.{n & 0xFF}"
            )

    # Hex notation (e.g. 0x7f000001)
    if re.match(r"^0x[0-9a-fA-F]+$", hostname, re.IGNORECASE):
        n = int(hostname, 16)
        if 0 <= n <= 0xFFFFFFFF:
            return (
                f"{(n >> 24) & 0xFF}.{(n >> 16) & 0xFF}"
                f".{(n >> 8) & 0xFF}.{n & 0xFF}"
            )

    # Octal or mixed-radix octets (e.g. 0177.0.0.1)
    parts = hostname.split(".")
    if len(parts) == 4:
        octets: list[int] = []
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


# ---------------------------------------------------------------------------
# Private / reserved IP detection
# ---------------------------------------------------------------------------


def is_private_ip(hostname: str) -> bool:
    """Return ``True`` if *hostname* is a private, reserved, or loopback address.

    Handles raw IPv4, raw IPv6 (with bracket stripping and zone-ID removal),
    hex/octal/decimal-encoded IPv4, IPv4-mapped IPv6 (``::ffff:``),
    IPv4-compatible IPv6 (``::127.0.0.1``), Teredo (``2001:0000::/32``),
    6to4 (``2002::/16``), CGNAT (``100.64.0.0/10``), and multicast ranges.
    """
    ip = hostname.strip("[]")

    # Strip IPv6 zone ID (%25... or %...)
    zone_idx = ip.find("%")
    if zone_idx != -1:
        ip = ip[:zone_idx]

    # Try normalising non-standard IPv4 first
    normalized = normalize_ipv4(ip)
    check_ip = normalized if normalized else ip

    # --- IPv4 private ranges ---
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
            return True  # 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
        return False

    # --- IPv6 private ranges ---
    ip_lower = ip.lower()

    if ip_lower == "::1":
        return True  # loopback
    if ip_lower == "::":
        return True  # unspecified

    # fc00::/7 ULA
    if ip_lower.startswith("fc") or ip_lower.startswith("fd"):
        return True
    # fe80::/10 link-local
    if ip_lower.startswith("fe80"):
        return True
    # ff00::/8 multicast
    if ip_lower.startswith("ff"):
        return True

    # IPv4-mapped IPv6 (::ffff:x.x.x.x)
    if ip_lower.startswith("::ffff:"):
        embedded = ip_lower[7:]
        if "." in embedded:
            return is_private_ip(embedded)
        # Hex form (::ffff:7f00:1)
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

    # IPv4-compatible IPv6 (::127.0.0.1 or hex form ::7f00:1)
    if ip_lower.startswith("::") and not ip_lower.startswith("::ffff:"):
        try:
            addr = ipaddress.IPv6Address(ip_lower)
            packed = addr.packed
            if all(b == 0 for b in packed[:12]):
                embedded = ipaddress.IPv4Address(packed[12:16])
                if embedded.is_private or embedded.is_loopback or embedded.is_reserved:
                    return True
        except (ValueError, ipaddress.AddressValueError):
            pass

    # Teredo tunnelling (2001:0000::/32) — block unconditionally
    if ip_lower.startswith("2001:0000:") or ip_lower.startswith("2001:0:"):
        return True

    # 6to4 tunnelling (2002::/16) — block unconditionally
    if ip_lower.startswith("2002:"):
        return True

    return False


# ---------------------------------------------------------------------------
# URL validation
# ---------------------------------------------------------------------------


def validate_url(url: str) -> str:
    """Validate a URL for SSRF safety.

    Checks:
    - Only ``http`` and ``https`` schemes
    - Non-empty hostname
    - Not in the blocked hostnames list
    - Not a private/reserved IP address (all forms)
    - Not a ``.localhost``, ``.local``, ``.internal``, or ``.arpa`` TLD
    - No embedded credentials
    - DNS rebinding protection (resolve hostname, verify all IPs are public)

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

    # .localhost TLD (RFC 6761) resolves to loopback
    if hostname.endswith(".localhost"):
        raise ValueError("Requests to localhost/loopback addresses are blocked")

    # Internal network TLDs
    if (
        hostname.endswith(".local")
        or hostname.endswith(".internal")
        or hostname.endswith(".arpa")
    ):
        raise ValueError("Requests to internal network hostnames are blocked")

    # Block embedded credentials in URL
    if parsed.username or parsed.password:
        raise ValueError("URLs with embedded credentials are not allowed")

    # DNS rebinding protection
    check_dns_rebinding(hostname)

    return url


# ---------------------------------------------------------------------------
# DNS rebinding protection
# ---------------------------------------------------------------------------


def check_dns_rebinding(hostname: str) -> None:
    """Resolve *hostname* and verify that ALL resolved IPs are public.

    This prevents DNS rebinding attacks where a hostname initially resolves
    to a public IP but later resolves to a private/loopback address.

    Args:
        hostname: The hostname to check.

    Raises:
        ValueError: If the hostname resolves to any private IP, or if
            DNS resolution fails entirely.
    """
    # Skip for raw IP addresses (already checked by is_private_ip)
    try:
        ipaddress.ip_address(hostname.strip("[]"))
        return  # It is a literal IP -- already validated
    except ValueError:
        pass  # It is a hostname -- proceed with DNS resolution

    try:
        infos = socket.getaddrinfo(
            hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM
        )
        for _family, _type, _proto, _canonname, sockaddr in infos:
            addr_str = sockaddr[0]
            # Strip IPv6 zone ID from resolved address
            if "%" in addr_str:
                addr_str = addr_str.split("%")[0]
            if is_private_ip(addr_str):
                raise ValueError(
                    f"Hostname {hostname!r} resolves to private IP {addr_str}"
                )
    except socket.gaierror:
        raise ValueError(f"Could not resolve hostname: {hostname!r}")
