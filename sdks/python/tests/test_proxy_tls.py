"""CONNECT tunnel integrity (no direct dial to the target) and gateway_tls (TLS to the gateway)."""

from __future__ import annotations

import base64
import socket
import ssl
import subprocess
import threading
from pathlib import Path
from typing import Any, List, Optional, Tuple

import pytest

from conftest import API_KEY, Recorder, new_client
from dominusnode import ProxyError, ValidationError

PUBLIC = ["93.184.216.34"]


@pytest.fixture(scope="module")
def cert(tmp_path_factory: pytest.TempPathFactory) -> Tuple[Path, Path, str]:
    d = tmp_path_factory.mktemp("tls")
    crt, key = d / "gw.crt", d / "gw.key"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
         "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", str(key), "-out", str(crt)],
        check=True, capture_output=True,
    )
    return crt, key, crt.read_text()


class Gateway:
    """Fake gateway (plain or TLS). After a 200 to CONNECT it records the first bytes the client
    sends on the SAME connection: a TLS ClientHello there proves the inner TLS rides the tunnel."""

    def __init__(self, ctx: Optional[ssl.SSLContext] = None, http_response: bytes = b"") -> None:
        self.ctx = ctx
        self.http_response = http_response
        self.heads: List[bytes] = []
        self.tunneled: List[bytes] = []
        self.accepted = 0
        self.tls_ok = 0
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                raw, _ = self.sock.accept()
            except OSError:
                return
            self.accepted += 1
            conn: Any = raw
            try:
                conn.settimeout(3)
                if self.ctx is not None:
                    conn = self.ctx.wrap_socket(raw, server_side=True)
                    self.tls_ok += 1
                buf = b""
                while b"\r\n\r\n" not in buf:
                    c = conn.recv(4096)
                    if not c:
                        break
                    buf += c
                self.heads.append(buf)
                if buf.startswith(b"CONNECT "):
                    conn.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    self.tunneled.append(conn.recv(8192))
                else:
                    conn.sendall(self.http_response)
            except (OSError, ssl.SSLError):
                pass
            finally:
                try:
                    conn.close()
                except OSError:
                    pass

    def close(self) -> None:
        self.sock.close()


def _server_ctx(cert: Tuple[Path, Path, str]) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(cert[0]), str(cert[1]))
    return ctx


def _client(rec: Recorder, **kw: Any) -> Any:
    c = new_client(rec, **kw)
    c._ctx.api_key = API_KEY
    c.proxy.set_lookup(lambda h: PUBLIC)
    return c


def _assert_client_hello(data: bytes, sni: bytes) -> None:
    assert data[:1] == b"\x16", "first tunneled bytes must be a TLS handshake record"
    assert sni in data, "ClientHello must carry the target SNI"


def test_https_rides_connect_tunnel_plain_gateway(rec: Recorder) -> None:
    gw = Gateway()
    try:
        c = _client(rec, proxy_host="127.0.0.1", http_proxy_port=gw.port)
        with pytest.raises(ProxyError):
            c.proxy.fetch("https://example.com/x", timeout_ms=3000)
        assert gw.accepted == 1 and gw.heads[0].startswith(b"CONNECT example.com:443 HTTP/1.1\r\n")
        _assert_client_hello(gw.tunneled[0], b"example.com")
    finally:
        gw.close()


def test_gateway_tls_connect_inside_tls(rec: Recorder, cert: Any) -> None:
    gw = Gateway(_server_ctx(cert))
    try:
        c = _client(rec, proxy_host="localhost", gateway_tls={"port": gw.port, "ca": cert[2]})
        err = None
        try:
            c.proxy.fetch("https://example.com/x", country="US", timeout_ms=3000)
        except ProxyError as e:  # inner TLS: the fake target cert is not publicly trusted
            err = e
        assert err is not None and API_KEY not in str(err)
        assert gw.tls_ok == 1
        assert gw.heads[0].startswith(b"CONNECT example.com:443 HTTP/1.1\r\n")
        auth = [ln for ln in gw.heads[0].split(b"\r\n") if ln.lower().startswith(b"proxy-authorization:")][0]
        assert base64.b64decode(auth.split(b" ")[-1]) == f"country-US:{API_KEY}".encode()
        _assert_client_hello(gw.tunneled[0], b"example.com")  # TLS-in-TLS, read through the outer layer
    finally:
        gw.close()


def test_gateway_tls_http_absolute_uri(rec: Recorder, cert: Any) -> None:
    gw = Gateway(_server_ctx(cert), b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi")
    try:
        c = _client(rec, proxy_host="127.0.0.1",
                    gateway_tls={"port": gw.port, "ca": cert[2].encode(), "servername": "localhost"})
        r = c.proxy.fetch("http://example.com/p", allow_http=True)
        assert r.text() == "hi" and gw.heads[0].startswith(b"GET http://example.com/p HTTP/1.1\r\n")
    finally:
        gw.close()


def test_gateway_tls_unverified_cert_refused(rec: Recorder, cert: Any) -> None:
    gw = Gateway(_server_ctx(cert))
    try:
        c = _client(rec, proxy_host="localhost", gateway_tls={"port": gw.port})
        with pytest.raises(ProxyError) as ei:
            c.proxy.fetch("https://example.com/", timeout_ms=3000)
        assert API_KEY not in str(ei.value)
        assert gw.heads == []  # nothing (no CONNECT, no key) was sent
    finally:
        gw.close()


def test_gateway_tls_wrong_name_refused(rec: Recorder, cert: Any) -> None:
    gw = Gateway(_server_ctx(cert))
    try:
        c = _client(rec, proxy_host="localhost",
                    gateway_tls={"port": gw.port, "ca": cert[2], "servername": "other.example"})
        with pytest.raises(ProxyError):
            c.proxy.fetch("https://example.com/", timeout_ms=3000)
        assert gw.heads == []
    finally:
        gw.close()


def test_build_url_https_default(rec: Recorder) -> None:
    c = new_client(rec, proxy_host="proxy.example.com", gateway_tls=True)
    c._ctx.api_key = API_KEY
    assert c.proxy.build_url().startswith("https://relay:dn_live_")
    assert c.proxy.build_url().endswith("@proxy.example.com:8443")
    assert c.proxy.build_url(protocol="http").endswith(":8080")
    plain = new_client(rec, proxy_host="proxy.example.com")
    plain._ctx.api_key = API_KEY
    assert plain.proxy.build_url().startswith("http://") and plain.proxy.build_url().endswith(":8080")
    with pytest.raises(ValidationError):
        plain.proxy.build_url(protocol="https")


@pytest.mark.parametrize("g", [{"port": 0}, {"port": 70000}, {"servername": "bad name"}, {"ca": 5}, {"x": 1}, "yes"])
def test_gateway_tls_config_validation(rec: Recorder, g: Any) -> None:
    with pytest.raises(ValidationError):
        new_client(rec, gateway_tls=g)
