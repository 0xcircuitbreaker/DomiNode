"""Proxy username builder and the GET/HEAD fetch helper (stdlib sockets + ssl, no extra deps)."""

from __future__ import annotations

import base64
import http.client
import io
import re
import socket
import ssl
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional, Union

from .constants import DEFAULT_TLS_PROXY_PORT, MAX_RESPONSE_BYTES
from .errors import ProxyError, invalid_arg, scrub_credentials
from .ssrf import LookupAll, assert_public_resolution, validate_target_url
from .validation import UUID_RE

OFAC_BLOCKED = frozenset({"CU", "IR", "KP", "RU", "SY"})
# masked = anonymizer (VPN/WARP/Tor) exits: cheapest, opt-in, never chosen unless requested.
IP_CLASSES = ("residential", "dc", "mobile", "masked")
_COUNTRY_RE = re.compile(r"^[A-Za-z]{2}\Z")
_SESSION_RE = re.compile(r"^[A-Za-z0-9]{1,64}\Z")
_TOKEN_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+\Z")
_CTL_RE = re.compile(r"[\r\n\0]")

FORBIDDEN_HEADERS = frozenset(
    {
        "host", "connection", "content-length", "transfer-encoding", "proxy-authorization",
        "proxy-connection", "authorization", "upgrade", "te", "trailer", "keep-alive",
    }
)


def build_proxy_username(
    country: Optional[str] = None,
    ip_class: Optional[str] = None,
    session_id: Optional[str] = None,
    agentic_wallet_id: Optional[str] = None,
    allow_http: bool = False,
) -> str:
    """Gateway username: hyphen-joined routing flags in fixed order; ``relay`` when none."""
    parts = []
    if country is not None:
        if not isinstance(country, str) or not _COUNTRY_RE.match(country):
            raise invalid_arg("country must be a 2-letter ISO code")
        c = country.upper()
        if c in OFAC_BLOCKED:
            raise invalid_arg(f"country {c} is sanctioned (OFAC) and cannot be targeted")
        parts.append(f"country-{c}")
    if ip_class is not None:
        if ip_class not in IP_CLASSES:
            raise invalid_arg("ip_class must be residential, dc, mobile or masked")
        parts.append(f"class-{ip_class}")
    if session_id is not None:
        if not isinstance(session_id, str) or not _SESSION_RE.match(session_id):
            raise invalid_arg("session_id must be 1-64 alphanumeric characters")
        parts.append(f"session-{session_id}")
    if agentic_wallet_id is not None:
        if not isinstance(agentic_wallet_id, str) or not UUID_RE.match(agentic_wallet_id):
            raise invalid_arg("agentic_wallet_id must be a UUID")
        parts.append(f"wallet-{agentic_wallet_id.lower()}")
    if allow_http is True:
        parts.append("allowhttp-1")
    return "-".join(parts) if parts else "relay"


@dataclass
class ProxyFetchResponse:
    status: int
    status_text: str
    headers: Dict[str, str]
    body: bytes = field(repr=False)
    truncated: bool

    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


def _clean_headers(headers: Optional[Mapping[str, str]]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not headers:
        return out
    for k, v in headers.items():
        if (
            not isinstance(k, str)
            or not isinstance(v, str)
            or _CTL_RE.search(k)
            or _CTL_RE.search(v)
            or not _TOKEN_RE.match(k)
        ):
            raise invalid_arg(f'header "{str(k)[:40]}" contains invalid characters')
        if k.lower() not in FORBIDDEN_HEADERS:
            out[k] = v
    return out


@dataclass
class _Prepared:
    scheme: str
    host: str
    port: int
    host_header: str
    path: str
    method: str
    headers: Dict[str, str]
    proxy_auth: str
    timeout: float
    max_bytes: int


def prepare_fetch(
    api_key: str,
    url: str,
    method: str = "GET",
    headers: Optional[Mapping[str, str]] = None,
    timeout_ms: Optional[float] = None,
    max_bytes: Optional[int] = None,
    country: Optional[str] = None,
    ip_class: Optional[str] = None,
    session_id: Optional[str] = None,
    agentic_wallet_id: Optional[str] = None,
    allow_http: bool = False,
) -> _Prepared:
    """Steps 1-5: every check that needs no network I/O."""
    m = str(method or "GET").upper()
    if m not in ("GET", "HEAD"):
        raise invalid_arg("proxy.fetch only allows GET and HEAD")
    u = validate_target_url(url)
    scheme = u.scheme.lower()
    if scheme == "http" and allow_http is not True:
        raise invalid_arg(
            "plaintext http:// requires allow_http=True (the exit node can read and modify it); prefer https://"
        )
    username = build_proxy_username(country, ip_class, session_id, agentic_wallet_id, allow_http)
    clean = _clean_headers(headers)
    t = 30_000.0 if timeout_ms is None else float(timeout_ms)
    if t != t:  # NaN guard
        raise invalid_arg("timeout_ms must be a number")
    t = min(max(t, 1.0), 120_000.0)
    mb = MAX_RESPONSE_BYTES if max_bytes is None else max_bytes
    if not isinstance(mb, int) or isinstance(mb, bool):
        raise invalid_arg("max_bytes must be an integer")
    mb = min(max(mb, 1), MAX_RESPONSE_BYTES)
    host = (u.hostname or "").lower().rstrip(".")
    default_port = 443 if scheme == "https" else 80
    port = u.port or default_port
    bracketed = f"[{host}]" if ":" in host else host
    host_header = bracketed if port == default_port else f"{bracketed}:{port}"
    path = (u.path or "/") + (f"?{u.query}" if u.query else "")
    token = base64.b64encode(f"{username}:{api_key}".encode("utf-8")).decode("ascii")
    return _Prepared(scheme, host, port, host_header, path, m, clean, "Basic " + token, t / 1000.0, mb)


def _read_head(sock: socket.socket, limit: int = 64 * 1024) -> bytes:
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(1)
        if not chunk:
            break
        buf += chunk
        if len(buf) > limit:
            raise ProxyError("Proxy response header too large")
    return buf


def _request_bytes(method: str, target: str, host_header: str, headers: Dict[str, str], extra: Dict[str, str]) -> bytes:
    lines = [f"{method} {target} HTTP/1.1", f"Host: {host_header}"]
    lines += [f"{k}: {v}" for k, v in headers.items()]
    lines += [f"{k}: {v}" for k, v in extra.items()]
    lines.append("Connection: close")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")


def _collect(sock: socket.socket, method: str, max_bytes: int, deadline: float) -> ProxyFetchResponse:
    resp = http.client.HTTPResponse(sock, method=method)  # type: ignore[arg-type]
    try:
        resp.begin()
        headers: Dict[str, str] = {}
        for k, v in resp.getheaders():
            lk = k.lower()
            headers[lk] = f"{headers[lk]}, {v}" if lk in headers else v
        chunks = []
        size = 0
        truncated = False
        if method != "HEAD":
            while size < max_bytes:
                if time.monotonic() > deadline:
                    raise socket.timeout("deadline")
                c = resp.read(min(65536, max_bytes - size))
                if not c:
                    break
                chunks.append(c)
                size += len(c)
            if size >= max_bytes and resp.read(1):
                truncated = True
        return ProxyFetchResponse(resp.status, resp.reason or "", headers, b"".join(chunks), truncated)
    finally:
        resp.close()


@dataclass(frozen=True)
class GatewayTls:
    """TLS to the gateway's HTTPS proxy listener (PROXY_TLS_PORT). Verification is always on;
    ``ca`` (PEM) is added to the system roots, ``servername`` overrides SNI/verified name."""

    port: int = DEFAULT_TLS_PROXY_PORT
    ca: Optional[Union[str, bytes]] = field(default=None, repr=False)
    servername: Optional[str] = None


def _tls_context(ca: Optional[Union[str, bytes]] = None) -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    if ca is not None:
        ctx.load_verify_locations(cadata=ca.decode("ascii") if isinstance(ca, bytes) else ca)
    return ctx


class _RawTls(io.RawIOBase):
    def __init__(self, conn: "_TlsOverStream") -> None:
        self._conn = conn

    def readable(self) -> bool:
        return True

    def readinto(self, b: Any) -> int:
        data = self._conn.recv(len(b))
        b[: len(data)] = data
        return len(data)


class _TlsOverStream:
    """TLS client over an existing (already TLS) stream: TLS-in-TLS via MemoryBIO.

    ``ssl.wrap_socket`` on an SSLSocket would write to the raw fd and skip the outer layer."""

    def __init__(self, outer: ssl.SSLSocket, ctx: ssl.SSLContext, server_hostname: str) -> None:
        self._outer = outer
        self._in = ssl.MemoryBIO()
        self._out = ssl.MemoryBIO()
        self._obj = ctx.wrap_bio(self._in, self._out, server_hostname=server_hostname)
        self._run(self._obj.do_handshake)

    def _flush(self) -> None:
        data = self._out.read()
        if data:
            self._outer.sendall(data)

    def _run(self, fn: Any, *args: Any) -> Any:
        while True:
            try:
                r = fn(*args)
                self._flush()
                return r
            except ssl.SSLWantReadError:
                self._flush()
                d = self._outer.recv(65536)
                if d:
                    self._in.write(d)
                else:
                    self._in.write_eof()

    def sendall(self, data: bytes) -> None:
        view = memoryview(data)
        while view:
            n = self._run(self._obj.write, view)
            view = view[n:]

    def recv(self, n: int) -> bytes:
        try:
            return self._run(self._obj.read, n)
        except (ssl.SSLZeroReturnError, ssl.SSLEOFError):
            return b""

    def makefile(self, mode: str = "rb", *args: Any, **kw: Any) -> io.BufferedReader:
        return io.BufferedReader(_RawTls(self))

    def close(self) -> None:
        self._outer.close()


def execute_fetch(
    proxy_host: str,
    proxy_port: int,
    p: _Prepared,
    lookup: Optional[LookupAll] = None,
    gateway_tls: Optional[GatewayTls] = None,
) -> ProxyFetchResponse:
    """Steps 6-9: DNS-rebinding check, then the request through the gateway. Redirects are returned, never followed.

    With ``gateway_tls`` the connection goes to ``proxy_host:gateway_tls.port`` over verified TLS and
    everything (CONNECT included) runs inside it; https targets then use TLS-in-TLS."""
    assert_public_resolution(p.host, lookup)
    deadline = time.monotonic() + p.timeout
    sock: Any = None
    try:
        port = gateway_tls.port if gateway_tls is not None else proxy_port
        sock = socket.create_connection((proxy_host, port), timeout=p.timeout)
        if gateway_tls is not None:
            sock = _tls_context(gateway_tls.ca).wrap_socket(sock, server_hostname=gateway_tls.servername or proxy_host)
        if p.scheme == "https":
            bracketed = f"[{p.host}]" if ":" in p.host else p.host
            authority = f"{bracketed}:{p.port}"
            sock.sendall(
                (
                    f"CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n"
                    f"Proxy-Authorization: {p.proxy_auth}\r\n\r\n"
                ).encode("latin-1")
            )
            head = _read_head(sock)
            m = re.match(rb"^HTTP/\d\.\d (\d{3})", head)
            status = int(m.group(1)) if m else 0
            if status != 200:
                raise ProxyError(f"Proxy refused CONNECT (HTTP {status})", status or None)
            # The inner TLS session rides the CONNECT tunnel socket; never dial the target directly.
            if gateway_tls is not None:
                sock = _TlsOverStream(sock, _tls_context(), p.host)
            else:
                sock = _tls_context().wrap_socket(sock, server_hostname=p.host)
            sock.sendall(_request_bytes(p.method, p.path, p.host_header, p.headers, {}))
        else:
            target = f"http://{p.host_header}{p.path}"
            sock.sendall(
                _request_bytes(p.method, target, p.host_header, p.headers, {"Proxy-Authorization": p.proxy_auth})
            )
        return _collect(sock, p.method, p.max_bytes, deadline)
    except ProxyError:
        raise
    except (socket.timeout, TimeoutError):
        raise ProxyError(f"Proxy request timed out after {int(p.timeout * 1000)}ms") from None
    except Exception as err:  # noqa: BLE001
        raise ProxyError(scrub_credentials(f"Proxy request failed: {err}")) from None
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
