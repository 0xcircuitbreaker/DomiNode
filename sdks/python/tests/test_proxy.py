"""Proxy: username/URL building, SSRF tables, URL refusals, DNS rebinding, fake gateway."""

from __future__ import annotations

import base64
import socket
import threading
from typing import Any, List, Optional

import pytest

from conftest import API_KEY, Recorder, new_async_client, new_client
from dominusnode import AuthenticationError, ProxyError, ValidationError, build_proxy_username, is_private_ip
from dominusnode.ssrf import assert_public_resolution, normalize_ipv4, validate_target_url

W = "123E4567-E89B-12D3-A456-426614174000"
PUBLIC = ["93.184.216.34"]


# ------------------------------------------------------------ username
def test_username_flags_in_order() -> None:
    assert build_proxy_username() == "relay"
    u = build_proxy_username(country="us", ip_class="residential", session_id="abc123", agentic_wallet_id=W, allow_http=True)
    assert u == f"country-US-class-residential-session-abc123-wallet-{W.lower()}-allowhttp-1"
    assert build_proxy_username(ip_class="dc") == "class-dc"
    assert build_proxy_username(ip_class="mobile", allow_http=False) == "class-mobile"


@pytest.mark.parametrize("country", ["CU", "ir", "KP", "ru", "SY"])
def test_ofac_refused(country: str) -> None:
    with pytest.raises(ValidationError, match="OFAC"):
        build_proxy_username(country=country)


@pytest.mark.parametrize("kw", [
    {"country": "USA"}, {"country": "U1"}, {"country": ""}, {"ip_class": "auto"}, {"ip_class": "datacenter"},
    {"session_id": "a-b"}, {"session_id": "x" * 65}, {"session_id": ""}, {"agentic_wallet_id": "not-uuid"},
    {"country": "U_"},
])
def test_flag_validation(kw: dict) -> None:
    with pytest.raises(ValidationError):
        build_proxy_username(**kw)


def test_build_url(rec: Recorder, client: Any) -> None:
    assert client.proxy.build_url(country="US", ip_class="dc") == \
        f"http://country-US-class-dc:{API_KEY}@proxy.dominusnode.com:8080"
    assert client.proxy.build_url(protocol="socks5") == f"socks5://relay:{API_KEY}@proxy.dominusnode.com:1080"
    other = "dn_test_otherkey_123"
    assert client.proxy.build_url(api_key=other).startswith(f"http://relay:{other}@")
    assert client.proxy.build_username(session_id="s1") == "session-s1"
    with pytest.raises(ValidationError):
        client.proxy.build_url(protocol="https")
    with pytest.raises(ValidationError):
        client.proxy.build_url(api_key="dn_node_" + "a" * 64)
    assert rec.requests == []


def test_build_url_needs_key(rec: Recorder) -> None:
    c = new_client(rec)
    with pytest.raises(AuthenticationError):
        c.proxy.build_url()


def test_custom_proxy_config(rec: Recorder) -> None:
    c = new_client(rec, proxy_host="[::1]", http_proxy_port=9000, socks5_proxy_port=9001)
    assert c.proxy.build_url(api_key=API_KEY) == f"http://relay:{API_KEY}@[::1]:9000"


@pytest.mark.parametrize("kw", [{"proxy_host": "evil.com/x"}, {"proxy_host": "a b"}, {"proxy_host": "u@h"},
                                {"http_proxy_port": 0}, {"socks5_proxy_port": 65536}, {"http_proxy_port": 80.0}])
def test_proxy_config_validation(rec: Recorder, kw: dict) -> None:
    with pytest.raises(ValidationError):
        new_client(rec, **kw)


# ------------------------------------------------------------ private IP tables
PRIVATE = [
    "0.0.0.0", "10.0.0.1", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "100.64.0.1", "100.127.255.255", "192.0.0.1", "192.0.2.5", "198.18.0.1", "198.19.255.255",
    "224.0.0.1", "239.255.255.250", "255.255.255.255", "240.0.0.1",
    "2130706433", "0x7f000001", "0177.0.0.1", "127.1", "0x7f.1", "017700000001", "10.1",
    "::", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::127.0.0.1", "::7f00:1",
    "64:ff9b::127.0.0.1", "64:ff9b::a00:1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "fec0::1",
    "ff02::1", "2001:0000:4136:e378:8000:63bf:3fff:fdd2", "2001::1", "2002:c0a8:101::1", "2001:db8::1",
]
PUBLIC_IPS = ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.32.0.1", "100.128.0.1", "192.169.0.1", "198.20.0.1",
              "223.255.255.255", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2a00:1450::1",
              "example.com", "1.2.3.4"]


@pytest.mark.parametrize("ip", PRIVATE)
def test_private(ip: str) -> None:
    assert is_private_ip(ip)


@pytest.mark.parametrize("ip", PUBLIC_IPS)
def test_public(ip: str) -> None:
    assert not is_private_ip(ip)


def test_normalize_ipv4() -> None:
    assert normalize_ipv4("2130706433") == "127.0.0.1"
    assert normalize_ipv4("0x7f000001") == "127.0.0.1"
    assert normalize_ipv4("0177.0.0.1") == "127.0.0.1"
    assert normalize_ipv4("127.1") == "127.0.0.1"
    assert normalize_ipv4("256.0.0.1") is None
    assert normalize_ipv4("example.com") is None


# ------------------------------------------------------------ URL refusals
@pytest.mark.parametrize("url", [
    "ftp://example.com/", "file:///etc/passwd", "https://user:pw@example.com/", "https://user@example.com/",
    "https://example.com:8443/", "http://example.com:22/", "https://localhost/", "https://LOCALHOST./",
    "https://localhost.localdomain/", "https://ip6-localhost/", "https://ip6-loopback/", "https://a.localhost/",
    "https://printer.local/", "https://db.internal/", "https://1.0.0.127.in-addr.arpa/", "https://127.0.0.1/",
    "https://2130706433/", "https://0x7f000001/", "https://0177.0.0.1/", "https://127.1/", "https://[::1]/",
    "https://[::ffff:127.0.0.1]/", "https://[fe80::1]/", "https://169.254.169.254/latest/meta-data", "https:///x",
    "https://exa mple.com/", "not a url",
])
def test_url_refused(url: str) -> None:
    with pytest.raises(ProxyError):
        validate_target_url(url)


@pytest.mark.parametrize("url", ["https://example.com/", "https://example.com:443/a?b=c", "http://example.com:80/",
                                 "https://[2606:4700:4700::1111]/", "https://Example.COM./"])
def test_url_allowed(url: str) -> None:
    validate_target_url(url)


# ------------------------------------------------------------ DNS rebinding
def test_dns_rebinding_mixed_answer_refused() -> None:
    with pytest.raises(ProxyError, match="resolves to a private"):
        assert_public_resolution("rebind.test", lambda h: ["93.184.216.34", "127.0.0.1"])
    with pytest.raises(ProxyError):
        assert_public_resolution("rebind.test", lambda h: ["2606:4700::1", "::ffff:10.0.0.1"])
    with pytest.raises(ProxyError, match="no addresses"):
        assert_public_resolution("empty.test", lambda h: [])

    def fail(h: str) -> List[str]:
        raise OSError("nxdomain")

    with pytest.raises(ProxyError, match="DNS resolution failed"):
        assert_public_resolution("nx.test", fail)
    assert_public_resolution("ok.test", lambda h: PUBLIC)


def test_fetch_rebinding_checked_before_connect(rec: Recorder, client: Any) -> None:
    client.proxy.set_lookup(lambda h: ["93.184.216.34", "10.0.0.5"])
    with pytest.raises(ProxyError):
        client.proxy.fetch("https://rebind.test/")


# ------------------------------------------------------------ fetch argument checks
@pytest.mark.parametrize("kw,exc", [
    ({"method": "POST"}, ValidationError), ({"method": "DELETE"}, ValidationError),
    ({"headers": {"X-A": "b\r\nInjected: 1"}}, ValidationError), ({"headers": {"Bad Name": "x"}}, ValidationError),
    ({"headers": {"X-A": "nul\0"}}, ValidationError), ({"country": "RU"}, ValidationError),
    ({"timeout_ms": float("nan")}, ValidationError), ({"max_bytes": 1.5}, ValidationError),
])
def test_fetch_argument_refusals(rec: Recorder, client: Any, kw: dict, exc: type) -> None:
    client.proxy.set_lookup(lambda h: pytest.fail("no DNS before validation"))  # type: ignore[arg-type]
    with pytest.raises(exc):
        client.proxy.fetch("https://example.com/", **kw)


def test_fetch_http_requires_allow_http(rec: Recorder, client: Any) -> None:
    with pytest.raises(ValidationError, match="allow_http"):
        client.proxy.fetch("http://example.com/")


def test_fetch_needs_key(rec: Recorder) -> None:
    c = new_client(rec)
    with pytest.raises(AuthenticationError):
        c.proxy.fetch("https://example.com/")


# ------------------------------------------------------------ fake gateway
class FakeGateway:
    def __init__(self, response: bytes) -> None:
        self.response = response
        self.heads: List[bytes] = []
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.port = self.sock.getsockname()[1]
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            with conn:
                buf = b""
                while b"\r\n\r\n" not in buf:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
                self.heads.append(buf)
                try:
                    conn.sendall(self.response)
                except OSError:
                    pass

    def close(self) -> None:
        self.sock.close()

    def header(self, name: str, i: int = -1) -> Optional[str]:
        for line in self.heads[i].decode("latin-1").split("\r\n")[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                if k.strip().lower() == name.lower():
                    return v.strip()
        return None


def gateway_client(rec: Recorder, gw: FakeGateway) -> Any:
    c = new_client(rec, proxy_host="127.0.0.1", http_proxy_port=gw.port)
    c._ctx.api_key = API_KEY
    c.proxy.set_lookup(lambda h: PUBLIC)
    return c


def test_http_path_absolute_uri_and_auth(rec: Recorder) -> None:
    gw = FakeGateway(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")
    try:
        c = gateway_client(rec, gw)
        r = c.proxy.fetch("http://example.com/path?q=1", allow_http=True, country="US",
                          headers={"X-Test": "1", "Authorization": "drop", "Host": "evil", "Proxy-Authorization": "x"})
        assert r.status == 200 and r.text() == "hello" and not r.truncated and r.headers["content-type"] == "text/plain"
        line = gw.heads[0].split(b"\r\n")[0]
        assert line == b"GET http://example.com/path?q=1 HTTP/1.1"
        expected = base64.b64encode(f"country-US-allowhttp-1:{API_KEY}".encode()).decode()
        assert gw.header("proxy-authorization") == f"Basic {expected}"
        assert gw.header("host") == "example.com" and gw.header("connection") == "close"
        assert gw.header("x-test") == "1" and gw.header("authorization") is None
        assert gw.heads[0].lower().count(b"proxy-authorization") == 1
        assert rec.requests == []
    finally:
        gw.close()


def test_http_redirect_returned_not_followed(rec: Recorder) -> None:
    gw = FakeGateway(b"HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/\r\nContent-Length: 0\r\n\r\n")
    try:
        c = gateway_client(rec, gw)
        r = c.proxy.fetch("http://example.com/", allow_http=True)
        assert r.status == 302 and r.headers["location"] == "http://169.254.169.254/" and len(gw.heads) == 1
    finally:
        gw.close()


def test_http_truncation(rec: Recorder) -> None:
    gw = FakeGateway(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n" + b"x" * 100)
    try:
        c = gateway_client(rec, gw)
        r = c.proxy.fetch("http://example.com/", allow_http=True, max_bytes=10)
        assert r.body == b"x" * 10 and r.truncated
    finally:
        gw.close()


def test_head_reads_no_body(rec: Recorder) -> None:
    gw = FakeGateway(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
    try:
        c = gateway_client(rec, gw)
        r = c.proxy.fetch("http://example.com/", allow_http=True, method="head")
        assert r.status == 200 and r.body == b"" and gw.heads[0].startswith(b"HEAD http://example.com/ HTTP/1.1")
    finally:
        gw.close()


def test_connect_refusal(rec: Recorder) -> None:
    gw = FakeGateway(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
    try:
        c = gateway_client(rec, gw)
        with pytest.raises(ProxyError) as ei:
            c.proxy.fetch("https://example.com/x", session_id="s1")
        assert ei.value.status_code == 407
        assert gw.heads[0].startswith(b"CONNECT example.com:443 HTTP/1.1\r\n")
        assert gw.header("host") == "example.com:443"
        expected = base64.b64encode(f"session-s1:{API_KEY}".encode()).decode()
        assert gw.header("proxy-authorization") == f"Basic {expected}"
        assert API_KEY not in str(ei.value)
    finally:
        gw.close()


def test_tls_failure_is_scrubbed_proxy_error(rec: Recorder) -> None:
    gw = FakeGateway(b"HTTP/1.1 200 Connection established\r\n\r\nnot tls at all")
    try:
        c = gateway_client(rec, gw)
        with pytest.raises(ProxyError) as ei:
            c.proxy.fetch("https://example.com/", timeout_ms=2000)
        assert API_KEY not in str(ei.value)
    finally:
        gw.close()


def test_timeout(rec: Recorder) -> None:
    srv = socket.socket()  # accepts the TCP connection, never answers
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    try:
        c = new_client(rec, proxy_host="127.0.0.1", http_proxy_port=srv.getsockname()[1])
        c._ctx.api_key = API_KEY
        c.proxy.set_lookup(lambda h: PUBLIC)
        with pytest.raises(ProxyError, match="timed out"):
            c.proxy.fetch("http://example.com/", allow_http=True, timeout_ms=200)
    finally:
        srv.close()


async def test_async_fetch(rec: Recorder) -> None:
    gw = FakeGateway(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
    try:
        c = new_async_client(rec, proxy_host="127.0.0.1", http_proxy_port=gw.port)
        c._ctx.api_key = API_KEY
        c.proxy.set_lookup(lambda h: PUBLIC)
        r = await c.proxy.fetch("http://example.com/", allow_http=True)
        assert r.text() == "ok"
    finally:
        gw.close()
