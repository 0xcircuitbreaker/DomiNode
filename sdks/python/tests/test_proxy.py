"""Tests for proxy URL building and proxy resource."""

from __future__ import annotations

import pytest

from dominusnode import ProxyError, ProxyUrlOptions
from dominusnode.proxy import build_proxy_url


class TestBuildProxyUrl:
    """Tests for the build_proxy_url function."""

    def test_basic_http_url(self) -> None:
        url = build_proxy_url(
            "dn_live_abc123",
            proxy_host="proxy.dominusnode.com",
            http_proxy_port=8080,
            socks5_proxy_port=1080,
        )
        assert url == "http://user:dn_live_abc123@proxy.dominusnode.com:8080"

    def test_socks5_url(self) -> None:
        url = build_proxy_url(
            "dn_live_abc123",
            proxy_host="proxy.dominusnode.com",
            http_proxy_port=8080,
            socks5_proxy_port=1080,
            options=ProxyUrlOptions(protocol="socks5"),
        )
        assert url == "socks5://user:dn_live_abc123@proxy.dominusnode.com:1080"

    def test_with_country(self) -> None:
        url = build_proxy_url(
            "dn_live_key",
            proxy_host="proxy.test.io",
            http_proxy_port=8080,
            socks5_proxy_port=1080,
            options=ProxyUrlOptions(country="us"),
        )
        assert url == "http://user-country_US:dn_live_key@proxy.test.io:8080"

    def test_with_country_and_state(self) -> None:
        url = build_proxy_url(
            "dn_live_key",
            proxy_host="proxy.test.io",
            http_proxy_port=8080,
            socks5_proxy_port=1080,
            options=ProxyUrlOptions(country="us", state="CA"),
        )
        assert url == "http://user-country_US-state_CA:dn_live_key@proxy.test.io:8080"

    def test_with_country_state_city(self) -> None:
        url = build_proxy_url(
            "dn_live_key",
            proxy_host="proxy.test.io",
            http_proxy_port=8080,
            socks5_proxy_port=1080,
            options=ProxyUrlOptions(country="us", state="CA", city="Los Angeles"),
        )
        assert url == "http://user-country_US-state_CA-city_Los%20Angeles:dn_live_key@proxy.test.io:8080"

    def test_with_session_id(self) -> None:
        url = build_proxy_url(
            "dn_live_key",
            proxy_host="proxy.test.io",
            http_proxy_port=8080,
            socks5_proxy_port=1080,
            options=ProxyUrlOptions(session_id="sess-12345"),
        )
        assert url == "http://user-session_sess-12345:dn_live_key@proxy.test.io:8080"

    def test_with_all_options(self) -> None:
        url = build_proxy_url(
            "dn_live_key",
            proxy_host="proxy.test.io",
            http_proxy_port=8080,
            socks5_proxy_port=1080,
            options=ProxyUrlOptions(
                country="gb",
                state="London",
                city="Camden",
                session_id="sticky-1",
                protocol="http",
            ),
        )
        assert "country_GB" in url
        assert "state_London" in url
        assert "city_Camden" in url
        assert "session_sticky-1" in url
        assert url.startswith("http://")
        assert url.endswith("@proxy.test.io:8080")

    def test_with_socks5_and_country(self) -> None:
        url = build_proxy_url(
            "dn_live_key",
            proxy_host="proxy.test.io",
            http_proxy_port=8080,
            socks5_proxy_port=1080,
            options=ProxyUrlOptions(country="de", protocol="socks5"),
        )
        assert url.startswith("socks5://")
        assert url.endswith("@proxy.test.io:1080")
        assert "country_DE" in url

    def test_special_characters_in_key_are_encoded(self) -> None:
        url = build_proxy_url(
            "dn_live_key+with/special=chars",
            proxy_host="proxy.test.io",
            http_proxy_port=8080,
            socks5_proxy_port=1080,
        )
        # The key should be URL-encoded
        assert "dn_live_key%2Bwith%2Fspecial%3Dchars" in url

    def test_empty_api_key_raises(self) -> None:
        with pytest.raises(ProxyError, match="API key is required"):
            build_proxy_url(
                "",
                proxy_host="proxy.test.io",
                http_proxy_port=8080,
                socks5_proxy_port=1080,
            )

    def test_custom_ports(self) -> None:
        url = build_proxy_url(
            "dn_live_key",
            proxy_host="localhost",
            http_proxy_port=9999,
            socks5_proxy_port=7777,
        )
        assert url == "http://user:dn_live_key@localhost:9999"

        url_socks = build_proxy_url(
            "dn_live_key",
            proxy_host="localhost",
            http_proxy_port=9999,
            socks5_proxy_port=7777,
            options=ProxyUrlOptions(protocol="socks5"),
        )
        assert url_socks == "socks5://user:dn_live_key@localhost:7777"

    def test_none_options_uses_defaults(self) -> None:
        url = build_proxy_url(
            "dn_live_key",
            proxy_host="proxy.test.io",
            http_proxy_port=8080,
            socks5_proxy_port=1080,
            options=None,
        )
        assert url == "http://user:dn_live_key@proxy.test.io:8080"


class TestProxyUrlOptionsCombinations:
    """Test various ProxyUrlOptions combinations."""

    def test_only_session(self) -> None:
        opts = ProxyUrlOptions(session_id="abc")
        assert opts.country is None
        assert opts.state is None
        assert opts.city is None
        assert opts.session_id == "abc"
        assert opts.protocol == "http"

    def test_defaults(self) -> None:
        opts = ProxyUrlOptions()
        assert opts.country is None
        assert opts.protocol == "http"
