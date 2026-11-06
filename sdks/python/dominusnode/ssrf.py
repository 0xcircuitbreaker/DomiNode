"""Client-side SSRF guard for proxy.fetch().

The gateway and node re-check after their own DNS resolution; this layer fails
fast and blocks DNS rebinding by resolving the name and checking EVERY address.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from typing import Callable, List, Optional
from urllib.parse import SplitResult, urlsplit

from .errors import ProxyError

#: Resolver: hostname -> every address (A + AAAA). Injectable for tests.
LookupAll = Callable[[str], List[str]]


def default_lookup(hostname: str) -> List[str]:
    infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    return [str(info[4][0]) for info in infos]


BLOCKED_HOSTNAMES = frozenset({"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"})
BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".arpa")

_HEX = re.compile(r"^0x[0-9a-f]+\Z", re.IGNORECASE)
_OCT = re.compile(r"^0[0-7]+\Z")
_DEC = re.compile(r"^(0|[1-9][0-9]*)\Z")


def normalize_ipv4(host: str) -> Optional[str]:
    """Decode decimal/hex/octal/short IPv4 forms (2130706433, 0x7f000001, 0177.0.0.1, 127.1); None if not IPv4-like."""
    parts = host.split(".")
    if len(parts) < 1 or len(parts) > 4:
        return None
    nums: List[int] = []
    for p in parts:
        if _HEX.match(p):
            nums.append(int(p, 16))
        elif _OCT.match(p):
            nums.append(int(p, 8))
        elif _DEC.match(p):
            nums.append(int(p, 10))
        else:
            return None
    last = nums.pop()
    if any(n > 255 for n in nums):
        return None
    rem = 4 - len(nums)
    if last >= 2 ** (8 * rem):
        return None
    out = list(nums)
    for i in range(rem - 1, -1, -1):
        out.append((last >> (8 * i)) & 0xFF)
    return ".".join(str(b) for b in out)


def _is_private_v4(ip: str) -> bool:
    a, b = (int(x) for x in ip.split(".")[:2])
    return (
        a in (0, 10, 127)
        or (a == 169 and b == 254)
        or (a == 172 and 16 <= b <= 31)
        or (a == 192 and b == 168)
        or (a == 100 and 64 <= b <= 127)
        or (a == 192 and b == 0)  # 192.0.0.0/24 IETF + 192.0.2.0/24 docs
        or (a == 198 and b in (18, 19))  # benchmarking
        or a >= 224  # multicast, reserved, broadcast
    )


def is_private_ip(host: str) -> bool:
    """True for private/reserved IPv4 (any spelling) and IPv6 literals; False for public IPs and non-IP names."""
    ip = host
    if ip.startswith("["):
        ip = ip[1:]
    if ip.endswith("]"):
        ip = ip[:-1]
    zone = ip.find("%")
    if zone != -1:
        ip = ip[:zone]
    v4 = normalize_ipv4(ip)
    if v4 is not None:
        return _is_private_v4(v4)
    try:
        b = ipaddress.IPv6Address(ip).packed
    except ValueError:
        return False
    zero10 = all(x == 0 for x in b[:10])
    tail = ".".join(str(x) for x in b[12:])
    if zero10 and b[10] == 0xFF and b[11] == 0xFF:
        return _is_private_v4(tail)  # ::ffff:a.b.c.d
    if zero10 and b[10] == 0 and b[11] == 0:
        # ::, ::1 and IPv4-compatible ::a.b.c.d
        return True if all(x == 0 for x in b[12:15]) else _is_private_v4(tail)
    if b[:4] == b"\x00\x64\xff\x9b":
        return _is_private_v4(tail)  # NAT64 64:ff9b::/96
    if (b[0] & 0xFE) == 0xFC:
        return True  # fc00::/7
    if b[0] == 0xFE and (b[1] & 0xC0) == 0x80:
        return True  # fe80::/10
    if b[0] == 0xFE and (b[1] & 0xC0) == 0xC0:
        return True  # fec0::/10
    if b[0] == 0xFF:
        return True  # multicast
    if b[:4] == b"\x20\x01\x00\x00":
        return True  # Teredo 2001::/32
    if b[:2] == b"\x20\x02":
        return True  # 6to4
    if b[:4] == b"\x20\x01\x0d\xb8":
        return True  # documentation
    return False


_HOST_RE = re.compile(r"^[a-z0-9._-]+\Z")


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host.split("%", 1)[0])
        return True
    except ValueError:
        return False


def validate_target_url(url: str) -> SplitResult:
    """http(s) only, no userinfo, port empty/80/443, no local names or private literals."""
    if not isinstance(url, str):
        raise ProxyError("Invalid URL")
    try:
        u = urlsplit(url.strip())
        port = u.port
    except ValueError:
        raise ProxyError("Invalid URL") from None
    scheme = u.scheme.lower()
    if scheme not in ("http", "https"):
        raise ProxyError("Only http: and https: URLs are supported")
    if "@" in u.netloc:
        raise ProxyError("URLs with embedded credentials are not allowed")
    if port is not None and port not in (80, 443):
        raise ProxyError("Only ports 80 and 443 are reachable through the relay network")
    host = (u.hostname or "").lower()
    if host.endswith("."):
        host = host[:-1]
    if not host:
        raise ProxyError("URL has no host")
    if not _is_ip_literal(host) and not _HOST_RE.match(host):
        raise ProxyError("Invalid URL")
    if host in BLOCKED_HOSTNAMES or any(host.endswith(s) for s in BLOCKED_SUFFIXES):
        raise ProxyError("Requests to local/internal hostnames are blocked")
    if is_private_ip(host):
        raise ProxyError("Requests to private/internal IP addresses are blocked")
    return u


def assert_public_resolution(hostname: str, lookup: Optional[LookupAll] = None) -> None:
    """DNS-rebinding guard: resolve and reject if resolution fails, is empty, or ANY address is private."""
    host = hostname.strip("[]")
    if host.endswith("."):
        host = host[:-1]
    if _is_ip_literal(host) or normalize_ipv4(host) is not None:
        if is_private_ip(host):
            raise ProxyError("Requests to private/internal IP addresses are blocked")
        return
    try:
        addrs = (lookup or default_lookup)(host)
    except Exception:
        raise ProxyError(f"DNS resolution failed for {host}") from None
    if not addrs:
        raise ProxyError(f"DNS resolution returned no addresses for {host}")
    for a in addrs:
        if is_private_ip(str(a)):
            raise ProxyError("Hostname resolves to a private/internal IP address (blocked)")
