"""Tests for dominusnode-moltbook integration.

Covers SSRF validation, IP normalization, credential sanitization (including
ETH private key scrubbing), prototype pollution prevention, OFAC blocking,
input validation, Moltbook auth headers, proxy routing, Moltbook API tools
(browse, post, comment, vote, submolts), Dominus Node management tools, PayPal
top-up, and authentication flows.

All tests mock httpx calls so no real network requests are made.
"""

from __future__ import annotations

import json
import os
from unittest.mock import MagicMock, patch

import pytest

from dominusnode_moltbook.client import (
    BLOCKED_HOSTNAMES,
    MAX_COMMENT_CONTENT_LEN,
    MAX_POST_CONTENT_LEN,
    MAX_POST_TITLE_LEN,
    MAX_SUBMOLT_DESC_LEN,
    MAX_SUBMOLT_NAME_LEN,
    MoltbookClient,
    SANCTIONED_COUNTRIES,
    _extract_6to4_ipv4,
    _extract_teredo_ipv4,
    _is_private_ip,
    _normalize_ipv4,
    _sanitize_error,
    _strip_dangerous_keys,
    _validate_label,
    _validate_positive_int,
    _validate_uuid,
    validate_url,
)


# ---------------------------------------------------------------------------
# Helpers for creating a client with test defaults
# ---------------------------------------------------------------------------

_TEST_ETH_ADDRESS = "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18"
_TEST_ETH_KEY = "0x" + "ab" * 32  # 64 hex chars
_TEST_API_KEY = "dn_test_key123"


def _make_client(**kwargs):
    defaults = {
        "dominusnode_api_key": _TEST_API_KEY,
        "eth_address": _TEST_ETH_ADDRESS,
        "eth_private_key": _TEST_ETH_KEY,
        "moltbook_base_url": "https://moltbook.com",
    }
    defaults.update(kwargs)
    return MoltbookClient(**defaults)


def _mock_moltbook_response(data: dict, status_code: int = 200):
    """Create a mock httpx response for Moltbook API calls."""
    mock_resp = MagicMock()
    mock_resp.status_code = status_code
    text = json.dumps(data)
    mock_resp.text = text
    mock_resp.content = text.encode()
    mock_resp.json.return_value = data
    return mock_resp


# ===========================================================================
# TestSSRFValidation (22 tests)
# ===========================================================================


class TestSSRFValidation:
    """Ensure validate_url blocks dangerous URLs."""

    def test_allows_https(self):
        result = validate_url("https://example.com/page")
        assert result == "https://example.com/page"

    def test_allows_http(self):
        result = validate_url("http://example.com/page")
        assert result == "http://example.com/page"

    def test_blocks_localhost(self):
        with pytest.raises(ValueError, match="localhost"):
            validate_url("http://localhost/secret")

    def test_blocks_127_0_0_1(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://127.0.0.1/admin")

    def test_blocks_10_x_private(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://10.0.0.1/internal")

    def test_blocks_172_16_private(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://172.16.0.1/internal")

    def test_blocks_192_168_private(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://192.168.1.1/router")

    def test_blocks_169_254_link_local(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://169.254.169.254/latest/meta-data/")

    def test_blocks_cgnat_100_64(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://100.64.0.1/internal")

    def test_blocks_ipv6_loopback(self):
        with pytest.raises(ValueError, match="private"):
            validate_url("http://[::1]/secret")

    def test_blocks_dot_localhost_tld(self):
        with pytest.raises(ValueError, match="(private|localhost|blocked)"):
            validate_url("http://app.localhost/admin")

    def test_blocks_dot_local_tld(self):
        with pytest.raises(ValueError, match="internal"):
            validate_url("http://printer.local/status")

    def test_blocks_dot_internal_tld(self):
        with pytest.raises(ValueError, match="internal"):
            validate_url("http://service.internal/api")

    def test_blocks_dot_arpa_tld(self):
        with pytest.raises(ValueError, match="internal"):
            validate_url("http://1.0.0.127.in-addr.arpa/")

    def test_blocks_embedded_credentials(self):
        with pytest.raises(ValueError, match="credentials"):
            validate_url("http://user:pass@example.com/page")

    def test_blocks_file_scheme(self):
        with pytest.raises(ValueError, match="http.*https"):
            validate_url("file:///etc/passwd")

    def test_blocks_ftp_scheme(self):
        with pytest.raises(ValueError, match="http.*https"):
            validate_url("ftp://example.com/file")

    def test_blocks_empty_url(self):
        with pytest.raises(ValueError, match="non-empty"):
            validate_url("")

    def test_blocks_url_too_long(self):
        long_url = "https://example.com/" + "a" * 2048
        with pytest.raises(ValueError, match="maximum length"):
            validate_url(long_url)

    def test_dns_rebinding_blocks_private_resolved_ip(self):
        mock_infos = [(2, 1, 6, "", ("127.0.0.1", 0))]
        with patch("dominusnode_moltbook.client.socket.getaddrinfo", return_value=mock_infos):
            with pytest.raises(ValueError, match="private IP"):
                validate_url("http://evil.example.com/secret")

    def test_dns_rebinding_allows_public_resolved_ip(self):
        mock_infos = [(2, 1, 6, "", ("93.184.216.34", 0))]
        with patch("dominusnode_moltbook.client.socket.getaddrinfo", return_value=mock_infos):
            result = validate_url("http://example.com/page")
            assert result == "http://example.com/page"

    def test_blocks_unresolvable_hostname(self):
        import socket as sock_mod
        with patch(
            "dominusnode_moltbook.client.socket.getaddrinfo",
            side_effect=sock_mod.gaierror("Name or service not known"),
        ):
            with pytest.raises(ValueError, match="Could not resolve"):
                validate_url("http://nonexistent.invalid/page")


# ===========================================================================
# TestIPNormalization (14 tests)
# ===========================================================================


class TestIPNormalization:
    """Test hex/octal/decimal IPv4 normalization and IPv6 variants."""

    def test_decimal_integer(self):
        assert _normalize_ipv4("2130706433") == "127.0.0.1"

    def test_hex_notation(self):
        assert _normalize_ipv4("0x7f000001") == "127.0.0.1"

    def test_octal_octets(self):
        assert _normalize_ipv4("0177.0.0.01") == "127.0.0.1"

    def test_decimal_is_private(self):
        assert _is_private_ip("2130706433") is True

    def test_hex_is_private(self):
        assert _is_private_ip("0x7f000001") is True

    def test_ipv6_zone_id_stripped(self):
        assert _is_private_ip("::1%eth0") is True

    def test_ipv4_mapped_ipv6(self):
        assert _is_private_ip("::ffff:127.0.0.1") is True

    def test_ipv4_compatible_ipv6(self):
        assert _is_private_ip("::127.0.0.1") is True

    def test_teredo_address(self):
        assert _is_private_ip("2001:0000:4136:e378:8000:63bf:3fff:fdd2") is True

    def test_6to4_with_private_ipv4(self):
        assert _is_private_ip("2002:0a00:0001::1") is True

    def test_6to4_with_public_ipv4(self):
        assert _is_private_ip("2002:5db8:d822::1") is True

    def test_public_ipv4(self):
        assert _is_private_ip("93.184.216.34") is False

    def test_multicast(self):
        assert _is_private_ip("224.0.0.1") is True

    def test_zero_network(self):
        assert _is_private_ip("0.0.0.0") is True


# ===========================================================================
# TestCredentialSanitization (4 tests)
# ===========================================================================


class TestCredentialSanitization:
    """Ensure API keys and ETH private keys are scrubbed from error messages."""

    def test_scrubs_live_key(self):
        msg = "Error with key dn_live_abc123XYZ in request"
        result = _sanitize_error(msg)
        assert "dn_live_abc123XYZ" not in result
        assert "***" in result

    def test_scrubs_test_key(self):
        msg = "Auth failed for dn_test_mykey999"
        result = _sanitize_error(msg)
        assert "dn_test_mykey999" not in result
        assert "***" in result

    def test_scrubs_multiple_keys(self):
        msg = "Keys: dn_live_one and dn_test_two"
        result = _sanitize_error(msg)
        assert "dn_live_one" not in result
        assert "dn_test_two" not in result
        assert result.count("***") == 2

    def test_scrubs_eth_private_key(self):
        key = "0x" + "ab" * 32
        msg = f"Error with private key {key} in message"
        result = _sanitize_error(msg)
        assert key not in result
        assert "***ETH_KEY***" in result


# ===========================================================================
# TestPrototypePollution (6 tests)
# ===========================================================================


class TestPrototypePollution:
    """Ensure dangerous keys are stripped from parsed JSON."""

    def test_strips_proto(self):
        obj = {"__proto__": {"admin": True}, "name": "test"}
        _strip_dangerous_keys(obj)
        assert "__proto__" not in obj
        assert obj["name"] == "test"

    def test_strips_constructor(self):
        obj = {"constructor": {"polluted": True}, "data": 1}
        _strip_dangerous_keys(obj)
        assert "constructor" not in obj
        assert obj["data"] == 1

    def test_strips_prototype(self):
        obj = {"prototype": {}, "value": "ok"}
        _strip_dangerous_keys(obj)
        assert "prototype" not in obj
        assert obj["value"] == "ok"

    def test_strips_nested(self):
        obj = {"nested": {"__proto__": True, "safe": "data"}}
        _strip_dangerous_keys(obj)
        assert "__proto__" not in obj.get("nested", {})
        assert obj["nested"]["safe"] == "data"

    def test_strips_in_list(self):
        obj = [{"__proto__": True, "val": 1}, {"constructor": True, "val": 2}]
        _strip_dangerous_keys(obj)
        assert "__proto__" not in obj[0]
        assert "constructor" not in obj[1]

    def test_depth_limit(self):
        obj: dict = {}
        current = obj
        for _ in range(60):
            current["nested"] = {}
            current = current["nested"]
        current["__proto__"] = True
        _strip_dangerous_keys(obj)


# ===========================================================================
# TestOFACBlocking (6 tests)
# ===========================================================================


class TestOFACBlocking:
    """Ensure OFAC sanctioned countries are blocked."""

    def test_sanctioned_set(self):
        assert "CU" in SANCTIONED_COUNTRIES
        assert "IR" in SANCTIONED_COUNTRIES
        assert "KP" in SANCTIONED_COUNTRIES
        assert "RU" in SANCTIONED_COUNTRIES
        assert "SY" in SANCTIONED_COUNTRIES

    def test_client_construction_blocks_ssrf_base_url(self):
        """Moltbook base URL pointing to private IP should be rejected."""
        with pytest.raises(ValueError, match="Invalid moltbook_base_url"):
            MoltbookClient(
                dominusnode_api_key=_TEST_API_KEY,
                eth_address=_TEST_ETH_ADDRESS,
                eth_private_key=_TEST_ETH_KEY,
                moltbook_base_url="http://127.0.0.1/api",
            )

    def test_construction_blocks_localhost_base_url(self):
        with pytest.raises(ValueError, match="Invalid moltbook_base_url"):
            MoltbookClient(
                dominusnode_api_key=_TEST_API_KEY,
                eth_address=_TEST_ETH_ADDRESS,
                eth_private_key=_TEST_ETH_KEY,
                moltbook_base_url="http://localhost/api",
            )

    def test_construction_blocks_internal_tld(self):
        with pytest.raises(ValueError, match="Invalid moltbook_base_url"):
            MoltbookClient(
                dominusnode_api_key=_TEST_API_KEY,
                eth_address=_TEST_ETH_ADDRESS,
                eth_private_key=_TEST_ETH_KEY,
                moltbook_base_url="http://service.internal/api",
            )

    def test_construction_allows_valid_url(self):
        client = _make_client()
        assert client.moltbook_base_url == "https://moltbook.com"

    def test_construction_strips_trailing_slash(self):
        client = _make_client(moltbook_base_url="https://moltbook.com/")
        assert client.moltbook_base_url == "https://moltbook.com"


# ===========================================================================
# TestInputValidation (10+ tests)
# ===========================================================================


class TestInputValidation:
    """Test input validation for Moltbook-specific fields."""

    def test_post_title_too_long(self):
        client = _make_client()
        result = client.create_post(
            title="x" * (MAX_POST_TITLE_LEN + 1),
            content="Hello",
            submolt="general",
        )
        assert "error" in result
        assert str(MAX_POST_TITLE_LEN) in result["error"]

    def test_post_title_empty(self):
        client = _make_client()
        result = client.create_post(title="", content="Hello", submolt="general")
        assert "error" in result
        assert "title" in result["error"]

    def test_post_title_control_chars(self):
        client = _make_client()
        result = client.create_post(
            title="bad\x00title", content="Hello", submolt="general"
        )
        assert "error" in result
        assert "control" in result["error"]

    def test_post_content_too_long(self):
        client = _make_client()
        result = client.create_post(
            title="Valid Title",
            content="x" * (MAX_POST_CONTENT_LEN + 1),
            submolt="general",
        )
        assert "error" in result
        assert str(MAX_POST_CONTENT_LEN) in result["error"]

    def test_post_content_empty(self):
        client = _make_client()
        result = client.create_post(
            title="Valid Title", content="", submolt="general"
        )
        assert "error" in result
        assert "content" in result["error"]

    def test_comment_content_too_long(self):
        client = _make_client()
        result = client.comment(
            post_id="post123",
            content="x" * (MAX_COMMENT_CONTENT_LEN + 1),
        )
        assert "error" in result
        assert str(MAX_COMMENT_CONTENT_LEN) in result["error"]

    def test_comment_empty_content(self):
        client = _make_client()
        result = client.comment(post_id="post123", content="")
        assert "error" in result
        assert "content" in result["error"]

    def test_comment_empty_post_id(self):
        client = _make_client()
        result = client.comment(post_id="", content="Hello")
        assert "error" in result
        assert "post_id" in result["error"]

    def test_vote_invalid_direction(self):
        client = _make_client()
        result = client.vote(
            target_id="post123", target_type="post", direction="sideways"
        )
        assert "error" in result
        assert "direction" in result["error"]

    def test_vote_invalid_target_type(self):
        client = _make_client()
        result = client.vote(
            target_id="post123", target_type="reply", direction="up"
        )
        assert "error" in result
        assert "target_type" in result["error"]

    def test_vote_empty_target_id(self):
        client = _make_client()
        result = client.vote(target_id="", target_type="post", direction="up")
        assert "error" in result
        assert "target_id" in result["error"]

    def test_browse_posts_invalid_sort(self):
        client = _make_client()
        result = client.browse_posts(sort="popular")
        assert "error" in result
        assert "sort" in result["error"]

    def test_browse_posts_invalid_limit(self):
        client = _make_client()
        result = client.browse_posts(limit=0)
        assert "error" in result
        assert "limit" in result["error"]

    def test_browse_posts_limit_over_100(self):
        client = _make_client()
        result = client.browse_posts(limit=101)
        assert "error" in result

    def test_browse_posts_negative_offset(self):
        client = _make_client()
        result = client.browse_posts(offset=-1)
        assert "error" in result
        assert "offset" in result["error"]

    def test_submolt_name_too_long(self):
        client = _make_client()
        result = client.create_submolt(
            name="x" * (MAX_SUBMOLT_NAME_LEN + 1),
            description="Test",
        )
        assert "error" in result
        assert str(MAX_SUBMOLT_NAME_LEN) in result["error"]

    def test_submolt_description_too_long(self):
        client = _make_client()
        result = client.create_submolt(
            name="test-submolt",
            description="x" * (MAX_SUBMOLT_DESC_LEN + 1),
        )
        assert "error" in result
        assert str(MAX_SUBMOLT_DESC_LEN) in result["error"]

    def test_submolt_empty_name(self):
        client = _make_client()
        result = client.create_submolt(name="", description="Test")
        assert "error" in result
        assert "name" in result["error"]

    def test_submolt_empty_description(self):
        client = _make_client()
        result = client.create_submolt(name="test-submolt", description="")
        assert "error" in result
        assert "description" in result["error"]

    def test_register_empty_name(self):
        client = _make_client()
        result = client.register(agent_name="")
        assert "error" in result
        assert "agent_name" in result["error"]

    def test_register_name_too_long(self):
        client = _make_client()
        result = client.register(agent_name="x" * 101)
        assert "error" in result
        assert "100" in result["error"]

    def test_get_post_empty_id(self):
        client = _make_client()
        result = client.get_post(post_id="")
        assert "error" in result
        assert "post_id" in result["error"]


# ===========================================================================
# TestMoltbookAuth (6+ tests)
# ===========================================================================


class TestMoltbookAuth:
    """Test Moltbook Ethereum wallet authentication."""

    def test_missing_eth_address_errors(self):
        client = _make_client(eth_address="")
        result = client.browse_posts()
        assert "error" in result
        assert "Ethereum address" in result["error"]

    def test_missing_eth_private_key_errors(self):
        client = _make_client(eth_private_key="")
        result = client.browse_posts()
        assert "error" in result
        assert "private key" in result["error"]

    def test_auth_headers_format(self):
        client = _make_client()
        headers = client._make_auth_headers()
        assert "X-Address" in headers
        assert "X-Signature" in headers
        assert "X-Timestamp" in headers
        assert headers["X-Address"] == _TEST_ETH_ADDRESS

    def test_timestamp_is_iso8601(self):
        client = _make_client()
        headers = client._make_auth_headers()
        ts = headers["X-Timestamp"]
        # Should contain a T separator (ISO 8601)
        assert "T" in ts

    def test_signature_is_hex_prefixed(self):
        client = _make_client()
        headers = client._make_auth_headers()
        sig = headers["X-Signature"]
        assert sig.startswith("0x")

    def test_custom_sign_fn(self):
        def custom_signer(msg: str, key: str) -> str:
            return "0xcustom_signature_abc"

        client = _make_client(sign_fn=custom_signer)
        headers = client._make_auth_headers()
        assert headers["X-Signature"] == "0xcustom_signature_abc"

    def test_sign_fn_failure_returns_error(self):
        def failing_signer(msg: str, key: str) -> str:
            raise ValueError("signing failed")

        client = _make_client(sign_fn=failing_signer)
        result = client.browse_posts()
        assert "error" in result
        assert "sign" in result["error"].lower() or "authentication" in result["error"].lower()

    def test_eth_private_key_not_in_repr(self):
        """Ensure the ETH private key is not accessible in error messages."""
        client = _make_client(dominusnode_api_key="")
        # This will fail at proxy URL build, producing an error with sanitized text
        result = client.browse_posts()
        assert _TEST_ETH_KEY not in str(result)


# ===========================================================================
# TestProxyRouting (6+ tests)
# ===========================================================================


class TestProxyRouting:
    """Test that requests are routed through the Dominus Node proxy."""

    def test_proxy_url_format(self):
        client = _make_client()
        proxy_url = client._build_proxy_url()
        assert proxy_url == f"http://auto:{_TEST_API_KEY}@proxy.dominusnode.com:8080"

    def test_proxy_url_custom_host_port(self):
        client = _make_client(proxy_host="my-proxy.io", proxy_port=9090)
        proxy_url = client._build_proxy_url()
        assert "my-proxy.io:9090" in proxy_url

    def test_proxy_url_requires_api_key(self):
        client = _make_client(dominusnode_api_key="")
        with pytest.raises(RuntimeError, match="API key"):
            client._build_proxy_url()

    def test_proxy_status_returns_config(self):
        client = _make_client()
        status = client.get_proxy_status()
        assert status["proxy_host"] == "proxy.dominusnode.com"
        assert status["proxy_port"] == 8080
        assert status["moltbook_base_url"] == "https://moltbook.com"
        assert status["routing_mode"] == "auto"

    def test_env_proxy_host(self):
        with patch.dict(os.environ, {"DOMINUSNODE_PROXY_HOST": "custom.proxy.net"}):
            client = _make_client()
            assert client.proxy_host == "custom.proxy.net"

    def test_env_proxy_port(self):
        with patch.dict(os.environ, {"DOMINUSNODE_PROXY_PORT": "7777"}):
            client = _make_client()
            assert client.proxy_port == 7777

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_moltbook_request_uses_proxy(self, mock_httpx_cls):
        """Verify that Moltbook requests are sent through the Dominus Node proxy."""
        mock_resp = _mock_moltbook_response({"posts": []})
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        client.browse_posts()

        # httpx.Client should have been called with a proxy= argument
        call_kwargs = mock_httpx_cls.call_args
        assert "proxy" in call_kwargs.kwargs or (
            len(call_kwargs.args) > 0 and "proxy" in str(call_kwargs)
        )


# ===========================================================================
# TestBrowsePosts (4+ tests)
# ===========================================================================


class TestBrowsePosts:
    """Test the browse_posts Moltbook tool."""

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_default_params(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response({"posts": [{"id": "1", "title": "Test"}]})
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.browse_posts()
        assert "posts" in result
        assert len(result["posts"]) == 1

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_with_submolt_filter(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response({"posts": []})
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.browse_posts(submolt="ai-agents", sort="new")
        assert "error" not in result

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_with_pagination(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response({"posts": [], "total": 100})
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.browse_posts(limit=10, offset=50)
        assert "error" not in result

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_api_error_returns_error(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response(
            {"error": "Rate limited"}, status_code=429
        )
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.browse_posts()
        assert "error" in result


# ===========================================================================
# TestCreatePost (4+ tests)
# ===========================================================================


class TestCreatePost:
    """Test the create_post Moltbook tool."""

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_valid_post(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response(
            {"id": "post123", "title": "Hello", "content": "World"}
        )
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.create_post(
            title="Hello", content="World", submolt="general"
        )
        assert "id" in result
        assert result["id"] == "post123"

    def test_empty_title_rejected(self):
        client = _make_client()
        result = client.create_post(title="", content="Body", submolt="general")
        assert "error" in result

    def test_content_too_long_rejected(self):
        client = _make_client()
        result = client.create_post(
            title="Title",
            content="x" * (MAX_POST_CONTENT_LEN + 1),
            submolt="general",
        )
        assert "error" in result

    def test_empty_submolt_rejected(self):
        client = _make_client()
        result = client.create_post(title="Title", content="Body", submolt="")
        assert "error" in result
        assert "submolt" in result["error"]

    def test_submolt_too_long_rejected(self):
        client = _make_client()
        result = client.create_post(
            title="Title",
            content="Body",
            submolt="x" * (MAX_SUBMOLT_NAME_LEN + 1),
        )
        assert "error" in result


# ===========================================================================
# TestComment (4+ tests)
# ===========================================================================


class TestComment:
    """Test the comment Moltbook tool."""

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_valid_comment(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response(
            {"id": "comment123", "content": "Great post!"}
        )
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.comment(post_id="post123", content="Great post!")
        assert "id" in result

    def test_empty_content_rejected(self):
        client = _make_client()
        result = client.comment(post_id="post123", content="")
        assert "error" in result

    def test_empty_post_id_rejected(self):
        client = _make_client()
        result = client.comment(post_id="", content="Hello")
        assert "error" in result

    def test_content_too_long_rejected(self):
        client = _make_client()
        result = client.comment(
            post_id="post123",
            content="x" * (MAX_COMMENT_CONTENT_LEN + 1),
        )
        assert "error" in result

    def test_post_id_too_long_rejected(self):
        client = _make_client()
        result = client.comment(post_id="x" * 101, content="Hello")
        assert "error" in result


# ===========================================================================
# TestVote (4+ tests)
# ===========================================================================


class TestVote:
    """Test the vote Moltbook tool."""

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_valid_upvote(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response({"success": True, "score": 42})
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.vote(
            target_id="post123", target_type="post", direction="up"
        )
        assert "success" in result

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_valid_downvote_on_comment(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response({"success": True, "score": -1})
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.vote(
            target_id="comment456", target_type="comment", direction="down"
        )
        assert "success" in result

    def test_invalid_direction_rejected(self):
        client = _make_client()
        result = client.vote(
            target_id="post123", target_type="post", direction="sideways"
        )
        assert "error" in result

    def test_invalid_target_type_rejected(self):
        client = _make_client()
        result = client.vote(
            target_id="post123", target_type="reply", direction="up"
        )
        assert "error" in result

    def test_empty_direction_rejected(self):
        client = _make_client()
        result = client.vote(
            target_id="post123", target_type="post", direction=""
        )
        assert "error" in result

    def test_empty_target_type_rejected(self):
        client = _make_client()
        result = client.vote(
            target_id="post123", target_type="", direction="up"
        )
        assert "error" in result


# ===========================================================================
# TestSubmolts (4+ tests)
# ===========================================================================


class TestSubmolts:
    """Test submolt Moltbook tools."""

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_list_submolts(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response(
            {"submolts": [{"name": "general"}, {"name": "ai-agents"}]}
        )
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.list_submolts()
        assert "submolts" in result
        assert len(result["submolts"]) == 2

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_create_submolt(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response(
            {"name": "new-submolt", "description": "A new community"}
        )
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.create_submolt(name="new-submolt", description="A new community")
        assert "name" in result

    def test_create_submolt_empty_name_rejected(self):
        client = _make_client()
        result = client.create_submolt(name="", description="Test")
        assert "error" in result

    def test_create_submolt_control_char_name_rejected(self):
        client = _make_client()
        result = client.create_submolt(name="bad\nname", description="Test")
        assert "error" in result
        assert "control" in result["error"]

    def test_create_submolt_desc_too_long(self):
        client = _make_client()
        result = client.create_submolt(
            name="valid", description="x" * (MAX_SUBMOLT_DESC_LEN + 1)
        )
        assert "error" in result


# ===========================================================================
# TestGetPost (4 tests)
# ===========================================================================


class TestGetPost:
    """Test the get_post Moltbook tool."""

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_valid_get_post(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response(
            {"id": "post123", "title": "Hello", "comments": []}
        )
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.get_post(post_id="post123")
        assert result["id"] == "post123"
        assert "comments" in result

    def test_empty_post_id_rejected(self):
        client = _make_client()
        result = client.get_post(post_id="")
        assert "error" in result

    def test_post_id_too_long(self):
        client = _make_client()
        result = client.get_post(post_id="x" * 101)
        assert "error" in result

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_prototype_pollution_stripped(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response(
            {"id": "post123", "__proto__": {"admin": True}, "title": "Test"}
        )
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.get_post(post_id="post123")
        assert "__proto__" not in result


# ===========================================================================
# TestGetProfile (2 tests)
# ===========================================================================


class TestGetProfile:
    """Test the get_profile Moltbook tool."""

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_get_profile(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response(
            {"address": _TEST_ETH_ADDRESS, "agentName": "TestBot", "karma": 100}
        )
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.get_profile()
        assert result["agentName"] == "TestBot"

    def test_get_profile_no_address_errors(self):
        client = _make_client(eth_address="")
        result = client.get_profile()
        assert "error" in result


# ===========================================================================
# TestRegister (2 tests)
# ===========================================================================


class TestRegister:
    """Test the register Moltbook tool."""

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_register_success(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response(
            {"address": _TEST_ETH_ADDRESS, "agentName": "MyBot"}
        )
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.register(agent_name="MyBot")
        assert result["agentName"] == "MyBot"

    def test_register_empty_name_rejected(self):
        client = _make_client()
        result = client.register(agent_name="")
        assert "error" in result


# ===========================================================================
# TestDominusNodeTools (8+ tests)
# ===========================================================================


class TestDominusNodeTools:
    """Test Dominus Node management tools exposed by MoltbookClient."""

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_check_balance(self, mock_httpx_cls):
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_test"}

        mock_api_resp = MagicMock()
        mock_api_resp.status_code = 200
        mock_api_resp.text = '{"balanceCents":5000}'
        mock_api_resp.content = mock_api_resp.text.encode()
        mock_api_resp.json.return_value = {"balanceCents": 5000}

        mock_client = MagicMock()
        mock_client.post.return_value = mock_auth_resp
        mock_client.request.return_value = mock_api_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = json.loads(client.check_balance())
        assert result["balanceCents"] == 5000

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_check_usage(self, mock_httpx_cls):
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_test"}

        mock_api_resp = MagicMock()
        mock_api_resp.status_code = 200
        mock_api_resp.text = '{"totalBytes":1024}'
        mock_api_resp.content = mock_api_resp.text.encode()
        mock_api_resp.json.return_value = {"totalBytes": 1024}

        mock_client = MagicMock()
        mock_client.post.return_value = mock_auth_resp
        mock_client.request.return_value = mock_api_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = json.loads(client.check_usage(period="day"))
        assert result["totalBytes"] == 1024

    def test_check_usage_invalid_period(self):
        client = _make_client()
        result = json.loads(client.check_usage(period="year"))
        assert "error" in result

    def test_create_agentic_wallet_validation(self):
        client = _make_client()
        result = json.loads(
            client.create_agentic_wallet(label="", spending_limit_cents=1000)
        )
        assert "error" in result

    def test_create_agentic_wallet_rejects_bool(self):
        client = _make_client()
        result = json.loads(
            client.create_agentic_wallet(label="test", spending_limit_cents=True)
        )
        assert "error" in result

    def test_team_details_rejects_invalid_uuid(self):
        client = _make_client()
        result = json.loads(client.team_details(team_id="not-a-uuid"))
        assert "error" in result
        assert "UUID" in result["error"]

    def test_update_team_rejects_no_changes(self):
        client = _make_client()
        result = json.loads(
            client.update_team(
                team_id="550e8400-e29b-41d4-a716-446655440000",
            )
        )
        assert "error" in result
        assert "At least one" in result["error"]

    def test_update_team_member_role_rejects_invalid_role(self):
        client = _make_client()
        result = json.loads(
            client.update_team_member_role(
                team_id="550e8400-e29b-41d4-a716-446655440000",
                user_id="550e8400-e29b-41d4-a716-446655440001",
                role="superadmin",
            )
        )
        assert "error" in result

    def test_team_fund_rejects_below_minimum(self):
        client = _make_client()
        result = json.loads(
            client.team_fund(
                team_id="550e8400-e29b-41d4-a716-446655440000",
                amount_cents=50,
            )
        )
        assert "error" in result

    def test_agentic_transactions_rejects_bad_limit(self):
        client = _make_client()
        result = json.loads(
            client.agentic_transactions(wallet_id="w-id", limit=0)
        )
        assert "error" in result


# ===========================================================================
# TestPayPalTopup (6 tests)
# ===========================================================================


class TestPayPalTopup:
    """Test PayPal top-up validation."""

    def test_rejects_below_minimum(self):
        client = _make_client()
        result = json.loads(client.topup_paypal(amount_cents=100))
        assert "error" in result
        assert "500" in result["error"]

    def test_rejects_zero(self):
        client = _make_client()
        result = json.loads(client.topup_paypal(amount_cents=0))
        assert "error" in result

    def test_rejects_negative(self):
        client = _make_client()
        result = json.loads(client.topup_paypal(amount_cents=-500))
        assert "error" in result

    def test_rejects_above_maximum(self):
        client = _make_client()
        result = json.loads(client.topup_paypal(amount_cents=2_000_000))
        assert "error" in result
        assert "1000000" in result["error"] or "1,000,000" in result["error"]

    def test_rejects_boolean(self):
        client = _make_client()
        result = json.loads(client.topup_paypal(amount_cents=True))
        assert "error" in result

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_valid_amount_calls_api(self, mock_httpx_cls):
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_test_token"}

        mock_paypal_resp = MagicMock()
        mock_paypal_resp.status_code = 200
        mock_paypal_resp.text = '{"orderId":"PAY-123","approvalUrl":"https://paypal.com/approve"}'
        mock_paypal_resp.content = mock_paypal_resp.text.encode()
        mock_paypal_resp.json.return_value = {
            "orderId": "PAY-123",
            "approvalUrl": "https://paypal.com/approve",
            "amountCents": 1000,
        }

        mock_client = MagicMock()
        mock_client.post.return_value = mock_auth_resp
        mock_client.request.return_value = mock_paypal_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = json.loads(client.topup_paypal(amount_cents=1000))
        assert "orderId" in result
        assert result["orderId"] == "PAY-123"


# ===========================================================================
# TestAuthentication (4 tests)
# ===========================================================================


class TestAuthentication:
    """Test Dominus Node authentication behavior."""

    def test_no_api_key_raises(self):
        with patch.dict(os.environ, {}, clear=True):
            client = _make_client(dominusnode_api_key="")
            result = json.loads(client.check_balance())
            assert "error" in result
            assert "API key" in result["error"]

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_auth_failure_returns_error(self, mock_httpx_cls):
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.text = "Unauthorized"

        mock_client = MagicMock()
        mock_client.post.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client(dominusnode_api_key="dn_test_badkey")
        result = json.loads(client.check_balance())
        assert "error" in result

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_successful_auth_and_request(self, mock_httpx_cls):
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_123"}

        mock_api_resp = MagicMock()
        mock_api_resp.status_code = 200
        mock_api_resp.text = '{"balanceCents":5000}'
        mock_api_resp.content = mock_api_resp.text.encode()
        mock_api_resp.json.return_value = {"balanceCents": 5000}

        mock_client = MagicMock()
        mock_client.post.return_value = mock_auth_resp
        mock_client.request.return_value = mock_api_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = json.loads(client.check_balance())
        assert result["balanceCents"] == 5000

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_401_retry_reauthenticates(self, mock_httpx_cls):
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_new"}

        mock_401_resp = MagicMock()
        mock_401_resp.status_code = 401
        mock_401_resp.text = "Token expired"
        mock_401_resp.content = b"Token expired"
        mock_401_resp.json.return_value = {"error": "Token expired"}

        mock_ok_resp = MagicMock()
        mock_ok_resp.status_code = 200
        mock_ok_resp.text = '{"balanceCents":1000}'
        mock_ok_resp.content = mock_ok_resp.text.encode()
        mock_ok_resp.json.return_value = {"balanceCents": 1000}

        mock_client = MagicMock()
        mock_client.post.return_value = mock_auth_resp
        mock_client.request.side_effect = [mock_401_resp, mock_ok_resp]
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = json.loads(client.check_balance())
        assert result["balanceCents"] == 1000


# ===========================================================================
# TestGetAllTools (2 tests)
# ===========================================================================


class TestGetAllTools:
    """Test the get_all_tools method."""

    def test_returns_33_tools(self):
        client = _make_client()
        tools = client.get_all_tools()
        assert len(tools) == 33

    def test_all_tools_are_callable(self):
        client = _make_client()
        tools = client.get_all_tools()
        for tool in tools:
            assert callable(tool)

    def test_tools_include_moltbook_tools(self):
        client = _make_client()
        tools = client.get_all_tools()
        tool_names = [t.__name__ for t in tools]
        assert "register" in tool_names
        assert "browse_posts" in tool_names
        assert "create_post" in tool_names
        assert "comment" in tool_names
        assert "vote" in tool_names
        assert "list_submolts" in tool_names
        assert "create_submolt" in tool_names
        assert "get_profile" in tool_names
        assert "get_proxy_status" in tool_names

    def test_tools_include_dominusnode_tools(self):
        client = _make_client()
        tools = client.get_all_tools()
        tool_names = [t.__name__ for t in tools]
        assert "check_balance" in tool_names
        assert "check_usage" in tool_names
        assert "create_team" in tool_names
        assert "topup_paypal" in tool_names
        assert "x402_info" in tool_names


# ===========================================================================
# TestClientInit (5 tests)
# ===========================================================================


class TestClientInit:
    """Test client initialization and configuration."""

    def test_default_config(self):
        client = _make_client()
        assert client.dominusnode_api_key == _TEST_API_KEY
        assert client.moltbook_base_url == "https://moltbook.com"
        assert client.eth_address == _TEST_ETH_ADDRESS
        assert client.timeout == 30.0

    def test_custom_config(self):
        client = _make_client(
            dominusnode_base_url="http://api.example.com",
            proxy_host="127.0.0.1",
            proxy_port=9090,
            timeout=60.0,
        )
        assert client.dominusnode_base_url == "http://api.example.com"
        assert client.proxy_port == 9090
        assert client.timeout == 60.0

    def test_env_fallback_api_key(self):
        with patch.dict(os.environ, {"DOMINUSNODE_API_KEY": "dn_test_from_env"}):
            client = MoltbookClient(
                dominusnode_api_key=None,
                eth_address=_TEST_ETH_ADDRESS,
                eth_private_key=_TEST_ETH_KEY,
            )
            assert client.dominusnode_api_key == "dn_test_from_env"

    def test_env_fallback_eth_address(self):
        with patch.dict(os.environ, {"MOLTBOOK_ETH_ADDRESS": "0xENV_ADDR"}):
            client = MoltbookClient(
                dominusnode_api_key=_TEST_API_KEY,
                eth_address="",
                eth_private_key=_TEST_ETH_KEY,
            )
            assert client.eth_address == "0xENV_ADDR"

    def test_env_fallback_eth_key(self):
        env_key = "0x" + "cd" * 32
        with patch.dict(os.environ, {"MOLTBOOK_ETH_PRIVATE_KEY": env_key}):
            client = MoltbookClient(
                dominusnode_api_key=_TEST_API_KEY,
                eth_address=_TEST_ETH_ADDRESS,
                eth_private_key="",
            )
            assert client._eth_private_key == env_key


# ===========================================================================
# TestResponseSizeLimit (2 tests)
# ===========================================================================


class TestResponseSizeLimit:
    """Test response size enforcement."""

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_rejects_oversized_response(self, mock_httpx_cls):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.content = b"x" * (10 * 1024 * 1024 + 1)  # > 10MB
        mock_resp.text = "x" * 100

        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.browse_posts()
        assert "error" in result
        assert "too large" in result["error"]

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_accepts_normal_size_response(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response({"posts": []})
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        result = client.browse_posts()
        assert "error" not in result


# ===========================================================================
# TestMoltbookRequestHeaders (3 tests)
# ===========================================================================


class TestMoltbookRequestHeaders:
    """Verify Moltbook requests include correct headers."""

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_auth_headers_sent(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response({"posts": []})
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        client.browse_posts()

        call_args = mock_client.request.call_args
        headers = call_args.kwargs.get("headers", {})
        assert "X-Address" in headers
        assert "X-Signature" in headers
        assert "X-Timestamp" in headers

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_user_agent_sent(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response({"posts": []})
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        client.browse_posts()

        call_args = mock_client.request.call_args
        headers = call_args.kwargs.get("headers", {})
        assert headers.get("User-Agent") == "dominusnode-moltbook/1.0.0"

    @patch("dominusnode_moltbook.client.httpx.Client")
    def test_content_type_json(self, mock_httpx_cls):
        mock_resp = _mock_moltbook_response({"posts": []})
        mock_client = MagicMock()
        mock_client.request.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        client = _make_client()
        client.browse_posts()

        call_args = mock_client.request.call_args
        headers = call_args.kwargs.get("headers", {})
        assert headers.get("Content-Type") == "application/json"


# ===========================================================================
# Wallet Policy Tests
# ===========================================================================


class TestWalletPolicy:
    """Test wallet policy fields on create_agentic_wallet and update_wallet_policy."""

    def test_create_with_daily_limit(self):
        client = _make_client()
        result = json.loads(client.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
            daily_limit_cents=5000,
        ))
        if "error" in result:
            assert "daily_limit_cents" not in result["error"]

    def test_create_with_allowed_domains(self):
        client = _make_client()
        result = json.loads(client.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
            allowed_domains=["example.com", "api.test.org"],
        ))
        if "error" in result:
            assert "allowed_domains" not in result["error"]

    def test_create_rejects_daily_limit_zero(self):
        client = _make_client()
        result = json.loads(client.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
            daily_limit_cents=0,
        ))
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    def test_create_rejects_daily_limit_over_max(self):
        client = _make_client()
        result = json.loads(client.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
            daily_limit_cents=1_000_001,
        ))
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    def test_create_rejects_invalid_domain(self):
        client = _make_client()
        result = json.loads(client.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
            allowed_domains=["-invalid.com"],
        ))
        assert "error" in result
        assert "allowed_domains" in result["error"]

    def test_create_rejects_too_many_domains(self):
        client = _make_client()
        domains = [f"d{i}.com" for i in range(101)]
        result = json.loads(client.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
            allowed_domains=domains,
        ))
        assert "error" in result
        assert "100" in result["error"]

    def test_create_rejects_domains_not_list(self):
        client = _make_client()
        result = json.loads(client.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
            allowed_domains="example.com",  # type: ignore
        ))
        assert "error" in result
        assert "allowed_domains" in result["error"]

    def test_update_wallet_policy_rejects_invalid_uuid(self):
        client = _make_client()
        result = json.loads(client.update_wallet_policy(
            wallet_id="not-a-uuid",
            daily_limit_cents=5000,
        ))
        assert "error" in result
        assert "UUID" in result["error"]

    def test_update_wallet_policy_rejects_daily_limit_zero(self):
        client = _make_client()
        result = json.loads(client.update_wallet_policy(
            wallet_id="550e8400-e29b-41d4-a716-446655440000",
            daily_limit_cents=0,
        ))
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    def test_update_wallet_policy_rejects_invalid_domain(self):
        client = _make_client()
        result = json.loads(client.update_wallet_policy(
            wallet_id="550e8400-e29b-41d4-a716-446655440000",
            allowed_domains=["bad domain"],
        ))
        assert "error" in result
        assert "allowed_domains" in result["error"]

    def test_update_wallet_policy_in_tools(self):
        client = _make_client()
        tools = client.get_all_tools()
        names = [fn.__name__ for fn in tools]
        assert "update_wallet_policy" in names
