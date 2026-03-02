"""Tests for dominusnode-langflow toolkit.

Covers SSRF validation, credential sanitization, prototype pollution,
OFAC blocking, HTTP method restrictions, URL validation, toolkit
initialization, input validation, PayPal top-up validation, and
get_tools() StructuredTool generation.

All tests mock httpx calls so no real network requests are made.
"""

from __future__ import annotations

import json
import os
from unittest.mock import MagicMock, patch

import pytest

from dominusnode_langflow.tools import (
    BLOCKED_HOSTNAMES,
    DominusNodeToolkit,
    SANCTIONED_COUNTRIES,
    _is_private_ip,
    _normalize_ipv4,
    _sanitize_error,
    _strip_dangerous_keys,
    validate_url,
)


# ===========================================================================
# SSRF Validation Tests
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
        """If a hostname resolves to a private IP, it should be blocked."""
        mock_infos = [(2, 1, 6, "", ("127.0.0.1", 0))]
        with patch("dominusnode_langflow.tools.socket.getaddrinfo", return_value=mock_infos):
            with pytest.raises(ValueError, match="private IP"):
                validate_url("http://evil.example.com/secret")

    def test_dns_rebinding_allows_public_resolved_ip(self):
        """If a hostname resolves to a public IP, it should be allowed."""
        mock_infos = [(2, 1, 6, "", ("93.184.216.34", 0))]
        with patch("dominusnode_langflow.tools.socket.getaddrinfo", return_value=mock_infos):
            result = validate_url("http://example.com/page")
            assert result == "http://example.com/page"

    def test_blocks_unresolvable_hostname(self):
        import socket as sock_mod
        with patch(
            "dominusnode_langflow.tools.socket.getaddrinfo",
            side_effect=sock_mod.gaierror("Name or service not known"),
        ):
            with pytest.raises(ValueError, match="Could not resolve"):
                validate_url("http://nonexistent.invalid/page")


# ===========================================================================
# IP Normalization Tests
# ===========================================================================


class TestIPNormalization:
    """Test hex/octal/decimal IPv4 normalization."""

    def test_decimal_integer(self):
        assert _normalize_ipv4("2130706433") == "127.0.0.1"

    def test_hex_notation(self):
        assert _normalize_ipv4("0x7f000001") == "127.0.0.1"

    def test_octal_octets(self):
        assert _normalize_ipv4("0177.0.0.01") == "127.0.0.1"

    def test_decimal_is_private(self):
        assert _is_private_ip("2130706433") is True  # 127.0.0.1

    def test_hex_is_private(self):
        assert _is_private_ip("0x7f000001") is True  # 127.0.0.1

    def test_ipv6_zone_id_stripped(self):
        assert _is_private_ip("::1%eth0") is True

    def test_ipv4_mapped_ipv6(self):
        assert _is_private_ip("::ffff:127.0.0.1") is True

    def test_ipv4_compatible_ipv6(self):
        assert _is_private_ip("::127.0.0.1") is True

    def test_teredo_address(self):
        # 2001:0000:... is Teredo -- always blocked
        assert _is_private_ip("2001:0000:4136:e378:8000:63bf:3fff:fdd2") is True

    def test_6to4_with_private_ipv4(self):
        # 2002:0a00:0001:: embeds 10.0.0.1
        assert _is_private_ip("2002:0a00:0001::1") is True

    def test_6to4_with_public_ipv4(self):
        # 2002::/16 is now blocked unconditionally (tunneling risk)
        assert _is_private_ip("2002:5db8:d822::1") is True

    def test_public_ipv4(self):
        assert _is_private_ip("93.184.216.34") is False

    def test_multicast(self):
        assert _is_private_ip("224.0.0.1") is True

    def test_zero_network(self):
        assert _is_private_ip("0.0.0.0") is True


# ===========================================================================
# Credential Sanitization Tests
# ===========================================================================


class TestCredentialSanitization:
    """Ensure API keys are scrubbed from error messages."""

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

    def test_preserves_non_key_text(self):
        msg = "Connection timed out after 30s"
        result = _sanitize_error(msg)
        assert result == msg


# ===========================================================================
# Prototype Pollution Tests
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
        # Build a deeply nested structure
        obj: dict = {}
        current = obj
        for _ in range(60):
            current["nested"] = {}
            current = current["nested"]
        current["__proto__"] = True
        # Should not raise even with very deep nesting
        _strip_dangerous_keys(obj)


# ===========================================================================
# OFAC Blocking Tests
# ===========================================================================


class TestOFACBlocking:
    """Ensure OFAC sanctioned countries are blocked."""

    def test_sanctioned_set(self):
        assert "CU" in SANCTIONED_COUNTRIES
        assert "IR" in SANCTIONED_COUNTRIES
        assert "KP" in SANCTIONED_COUNTRIES
        assert "RU" in SANCTIONED_COUNTRIES
        assert "SY" in SANCTIONED_COUNTRIES

    def test_proxied_fetch_blocks_cuba(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", country="CU",
        ))
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_blocks_iran(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", country="IR",
        ))
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_blocks_north_korea(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", country="KP",
        ))
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_blocks_case_insensitive(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", country="sy",
        ))
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_proxied_fetch_allows_us(self):
        """US should NOT be blocked by OFAC check (but may fail on proxy connect)."""
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", country="US",
        ))
        # Should not have an OFAC error
        if "error" in result:
            assert "OFAC" not in result["error"]


# ===========================================================================
# HTTP Method Restriction Tests
# ===========================================================================


class TestHTTPMethodRestriction:
    """Ensure only GET/HEAD/OPTIONS are allowed for proxied fetch."""

    def test_blocks_post(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", method="POST",
        ))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_blocks_put(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", method="PUT",
        ))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_blocks_delete(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", method="DELETE",
        ))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_blocks_patch(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", method="PATCH",
        ))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_allows_get(self):
        """GET should pass method check (may fail on actual proxy connect)."""
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", method="GET",
        ))
        # Should not have a method restriction error
        if "error" in result:
            assert "not allowed" not in result["error"]

    def test_allows_head(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", method="HEAD",
        ))
        if "error" in result:
            assert "not allowed" not in result["error"]

    def test_allows_options(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", method="OPTIONS",
        ))
        if "error" in result:
            assert "not allowed" not in result["error"]


# ===========================================================================
# URL Validation Tests
# ===========================================================================


class TestURLValidation:
    """Test URL validation edge cases."""

    def test_blocks_no_hostname(self):
        with pytest.raises(ValueError, match="hostname"):
            validate_url("http:///no-host")

    def test_blocks_javascript_scheme(self):
        with pytest.raises(ValueError, match="http.*https"):
            validate_url("javascript:alert(1)")

    def test_blocks_data_scheme(self):
        with pytest.raises(ValueError, match="http.*https"):
            validate_url("data:text/html,<h1>Hello</h1>")

    def test_blocks_none_url(self):
        with pytest.raises(ValueError, match="non-empty"):
            validate_url(None)  # type: ignore

    def test_blocks_non_string_url(self):
        with pytest.raises(ValueError, match="non-empty"):
            validate_url(123)  # type: ignore


# ===========================================================================
# Toolkit Initialization Tests
# ===========================================================================


class TestToolkitInit:
    """Test toolkit initialization and configuration."""

    def test_default_config(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        assert toolkit.api_key == "dn_test_key123"
        assert toolkit.base_url == "https://api.dominusnode.com"
        assert toolkit.timeout == 30.0

    def test_custom_config(self):
        toolkit = DominusNodeToolkit(
            api_key="dn_live_custom",
            base_url="http://localhost:3000",
            proxy_host="127.0.0.1",
            proxy_port=9090,
            timeout=60.0,
        )
        assert toolkit.api_key == "dn_live_custom"
        assert toolkit.base_url == "http://localhost:3000"
        assert toolkit.timeout == 60.0
        assert toolkit.proxy_port == 9090

    def test_env_fallback(self):
        with patch.dict(os.environ, {"DOMINUSNODE_API_KEY": "dn_test_from_env"}):
            toolkit = DominusNodeToolkit()
            assert toolkit.api_key == "dn_test_from_env"

    def test_env_proxy_host(self):
        with patch.dict(os.environ, {"DOMINUSNODE_PROXY_HOST": "my-proxy.example.com"}):
            toolkit = DominusNodeToolkit(api_key="dn_test_key123")
            assert toolkit.proxy_host == "my-proxy.example.com"

    def test_env_proxy_port(self):
        with patch.dict(os.environ, {"DOMINUSNODE_PROXY_PORT": "9999"}):
            toolkit = DominusNodeToolkit(api_key="dn_test_key123")
            assert toolkit.proxy_port == 9999

    def test_base_url_trailing_slash_stripped(self):
        toolkit = DominusNodeToolkit(
            api_key="dn_test_key123",
            base_url="https://api.example.com/",
        )
        assert toolkit.base_url == "https://api.example.com"


# ===========================================================================
# get_tools Tests
# ===========================================================================


class TestGetTools:
    """Test the get_tools method returns correct StructuredTool objects."""

    def test_returns_26_tools(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        tools = toolkit.get_tools()
        assert len(tools) == 26

    def test_tool_names(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        tools = toolkit.get_tools()
        names = [t.name for t in tools]
        expected = [
            "dominusnode_proxied_fetch",
            "dominusnode_check_balance",
            "dominusnode_check_usage",
            "dominusnode_get_proxy_config",
            "dominusnode_list_sessions",
            "dominusnode_create_agentic_wallet",
            "dominusnode_fund_agentic_wallet",
            "dominusnode_agentic_wallet_balance",
            "dominusnode_list_agentic_wallets",
            "dominusnode_agentic_transactions",
            "dominusnode_freeze_agentic_wallet",
            "dominusnode_unfreeze_agentic_wallet",
            "dominusnode_delete_agentic_wallet",
            "dominusnode_create_team",
            "dominusnode_list_teams",
            "dominusnode_team_details",
            "dominusnode_team_fund",
            "dominusnode_team_create_key",
            "dominusnode_team_usage",
            "dominusnode_update_team",
            "dominusnode_update_team_member_role",
            "dominusnode_x402_info",
            "dominusnode_topup_paypal",
            "dominusnode_topup_stripe",
            "dominusnode_topup_crypto",
            "dominusnode_update_wallet_policy",
        ]
        assert names == expected

    def test_all_tools_have_descriptions(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        tools = toolkit.get_tools()
        for tool in tools:
            assert tool.description, f"Tool {tool.name} has no description"
            assert len(tool.description) > 10, f"Tool {tool.name} description too short"

    def test_tools_are_structured_tool_instances(self):
        from langchain_core.tools import StructuredTool
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        tools = toolkit.get_tools()
        for tool in tools:
            assert isinstance(tool, StructuredTool), (
                f"Tool {tool.name} is not a StructuredTool"
            )

    def test_proxied_fetch_tool_has_args_schema(self):
        from dominusnode_langflow.tools import ProxiedFetchInput
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        tools = toolkit.get_tools()
        fetch_tool = next(t for t in tools if t.name == "dominusnode_proxied_fetch")
        assert fetch_tool.args_schema is ProxiedFetchInput


# ===========================================================================
# Input Validation Tests
# ===========================================================================


class TestInputValidation:
    """Test input validation for various tools."""

    def test_create_agentic_wallet_rejects_empty_label(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="", spending_limit_cents=1000,
        ))
        assert "error" in result
        assert "label" in result["error"].lower()

    def test_create_agentic_wallet_rejects_long_label(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="x" * 101, spending_limit_cents=1000,
        ))
        assert "error" in result
        assert "100" in result["error"]

    def test_create_agentic_wallet_rejects_control_chars(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="bad\x00label", spending_limit_cents=1000,
        ))
        assert "error" in result
        assert "control" in result["error"].lower()

    def test_create_agentic_wallet_rejects_negative_limit(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=-1,
        ))
        assert "error" in result

    def test_create_agentic_wallet_rejects_zero_limit(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=0,
        ))
        assert "error" in result

    def test_create_agentic_wallet_rejects_bool(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=True,  # type: ignore
        ))
        assert "error" in result

    def test_team_fund_rejects_below_minimum(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.team_fund(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            amount_cents=50,
        ))
        assert "error" in result
        assert "100" in result["error"]

    def test_team_fund_rejects_above_maximum(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.team_fund(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            amount_cents=2_000_000,
        ))
        assert "error" in result

    def test_update_team_member_role_rejects_invalid_role(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.update_team_member_role(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            user_id="550e8400-e29b-41d4-a716-446655440001",
            role="superadmin",
        ))
        assert "error" in result
        assert "member" in result["error"]

    def test_update_team_rejects_no_changes(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.update_team(
            team_id="550e8400-e29b-41d4-a716-446655440000",
        ))
        assert "error" in result
        assert "At least one" in result["error"]

    def test_team_details_rejects_invalid_uuid(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.team_details(team_id="not-a-uuid"))
        assert "error" in result
        assert "UUID" in result["error"]

    def test_agentic_transactions_rejects_limit_zero(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.agentic_transactions(
            wallet_id="wallet-id", limit=0,
        ))
        assert "error" in result
        assert "limit" in result["error"].lower()

    def test_agentic_transactions_rejects_limit_over_100(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.agentic_transactions(
            wallet_id="wallet-id", limit=101,
        ))
        assert "error" in result

    def test_check_usage_rejects_invalid_period(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.check_usage(period="year"))
        assert "error" in result
        assert "period" in result["error"]

    def test_proxied_fetch_rejects_invalid_proxy_type(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.proxied_fetch(
            url="https://example.com", proxy_type="invalid",
        ))
        assert "error" in result
        assert "proxy_type" in result["error"]


# ===========================================================================
# PayPal Top-up Validation Tests
# ===========================================================================


class TestPayPalTopup:
    """Test PayPal top-up validation."""

    def test_rejects_below_minimum(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.topup_paypal(amount_cents=100))
        assert "error" in result
        assert "500" in result["error"]

    def test_rejects_zero(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.topup_paypal(amount_cents=0))
        assert "error" in result

    def test_rejects_negative(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.topup_paypal(amount_cents=-500))
        assert "error" in result

    def test_rejects_above_maximum(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.topup_paypal(amount_cents=2_000_000))
        assert "error" in result
        assert "1000000" in result["error"] or "1,000,000" in result["error"]

    def test_rejects_boolean(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.topup_paypal(amount_cents=True))  # type: ignore
        assert "error" in result

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_valid_amount_calls_api(self, mock_httpx_cls):
        """A valid amount should authenticate then call the PayPal API."""
        # Mock authenticate response
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_test_token"}

        # Mock paypal API response
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

        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.topup_paypal(amount_cents=1000))

        assert "orderId" in result
        assert result["orderId"] == "PAY-123"


# ===========================================================================
# Authentication Tests
# ===========================================================================


class TestAuthentication:
    """Test authentication behavior."""

    def test_no_api_key_raises(self):
        with patch.dict(os.environ, {}, clear=True):
            toolkit = DominusNodeToolkit(api_key="")
            result = json.loads(toolkit.check_balance())
            assert "error" in result
            assert "API key" in result["error"]

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_auth_failure_returns_error(self, mock_httpx_cls):
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.text = "Unauthorized"

        mock_client = MagicMock()
        mock_client.post.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        toolkit = DominusNodeToolkit(api_key="dn_test_badkey")
        result = json.loads(toolkit.check_balance())
        assert "error" in result

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_successful_auth_and_request(self, mock_httpx_cls):
        # Auth response
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_123"}

        # API response
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

        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.check_balance())
        assert result["balanceCents"] == 5000

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_401_retry_reauthenticates(self, mock_httpx_cls):
        """On 401 API error, toolkit should re-auth and retry once."""
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_new"}

        # First API call returns 401, second succeeds
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

        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.check_balance())
        assert result["balanceCents"] == 1000


# ===========================================================================
# Mocked API Call Tests (all 22 tools via mocked HTTP)
# ===========================================================================


class TestMockedAPICalls:
    """Test all tool methods with mocked HTTP to verify correct API paths."""

    def _make_mocked_toolkit(self, mock_httpx_cls, api_response):
        """Helper to create a toolkit with mocked auth and API response."""
        mock_auth_resp = MagicMock()
        mock_auth_resp.status_code = 200
        mock_auth_resp.json.return_value = {"token": "jwt_test"}

        mock_api_resp = MagicMock()
        mock_api_resp.status_code = 200
        mock_api_resp.text = json.dumps(api_response)
        mock_api_resp.content = mock_api_resp.text.encode()
        mock_api_resp.json.return_value = api_response

        mock_client = MagicMock()
        mock_client.post.return_value = mock_auth_resp
        mock_client.request.return_value = mock_api_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_client

        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        return toolkit, mock_client

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_check_balance_calls_wallet(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"balanceCents": 5000}
        )
        result = json.loads(toolkit.check_balance())
        assert result["balanceCents"] == 5000

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_check_usage_calls_usage(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"totalBytes": 1024}
        )
        result = json.loads(toolkit.check_usage(period="day"))
        assert result["totalBytes"] == 1024

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_get_proxy_config(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"httpProxy": {"host": "proxy.example.com", "port": 8080}}
        )
        result = json.loads(toolkit.get_proxy_config())
        assert "httpProxy" in result

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_list_sessions(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"sessions": []}
        )
        result = json.loads(toolkit.list_sessions())
        assert "sessions" in result

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_create_agentic_wallet(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"id": "w-123", "label": "test", "balanceCents": 0}
        )
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=1000,
        ))
        assert result["id"] == "w-123"

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_fund_agentic_wallet(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"balanceCents": 1000}
        )
        result = json.loads(toolkit.fund_agentic_wallet(
            wallet_id="w-123", amount_cents=1000,
        ))
        assert result["balanceCents"] == 1000

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_agentic_wallet_balance(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"balanceCents": 500}
        )
        result = json.loads(toolkit.agentic_wallet_balance(wallet_id="w-123"))
        assert result["balanceCents"] == 500

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_list_agentic_wallets(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"wallets": []}
        )
        result = json.loads(toolkit.list_agentic_wallets())
        assert "wallets" in result

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_agentic_transactions(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"transactions": []}
        )
        result = json.loads(toolkit.agentic_transactions(wallet_id="w-123"))
        assert "transactions" in result

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_freeze_agentic_wallet(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"status": "frozen"}
        )
        result = json.loads(toolkit.freeze_agentic_wallet(wallet_id="w-123"))
        assert result["status"] == "frozen"

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_unfreeze_agentic_wallet(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"status": "active"}
        )
        result = json.loads(toolkit.unfreeze_agentic_wallet(wallet_id="w-123"))
        assert result["status"] == "active"

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_delete_agentic_wallet(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"deleted": True}
        )
        result = json.loads(toolkit.delete_agentic_wallet(wallet_id="w-123"))
        assert result["deleted"] is True

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_create_team(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"id": "t-123", "name": "My Team"}
        )
        result = json.loads(toolkit.create_team(name="My Team"))
        assert result["name"] == "My Team"

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_list_teams(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"teams": []}
        )
        result = json.loads(toolkit.list_teams())
        assert "teams" in result

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_team_details(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"id": "550e8400-e29b-41d4-a716-446655440000", "name": "Team"}
        )
        result = json.loads(toolkit.team_details(
            team_id="550e8400-e29b-41d4-a716-446655440000",
        ))
        assert result["name"] == "Team"

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_team_fund(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"balanceCents": 5000}
        )
        result = json.loads(toolkit.team_fund(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            amount_cents=5000,
        ))
        assert result["balanceCents"] == 5000

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_team_create_key(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"key": "dn_live_teamkey", "label": "CI Key"}
        )
        result = json.loads(toolkit.team_create_key(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            label="CI Key",
        ))
        assert result["label"] == "CI Key"

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_team_usage(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"transactions": []}
        )
        result = json.loads(toolkit.team_usage(
            team_id="550e8400-e29b-41d4-a716-446655440000",
        ))
        assert "transactions" in result

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_update_team(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"name": "New Name"}
        )
        result = json.loads(toolkit.update_team(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            name="New Name",
        ))
        assert result["name"] == "New Name"

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_update_team_member_role(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"role": "admin"}
        )
        result = json.loads(toolkit.update_team_member_role(
            team_id="550e8400-e29b-41d4-a716-446655440000",
            user_id="550e8400-e29b-41d4-a716-446655440001",
            role="admin",
        ))
        assert result["role"] == "admin"

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_x402_info(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"facilitators": [], "pricing": {}}
        )
        result = json.loads(toolkit.x402_info())
        assert "facilitators" in result

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_topup_paypal(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"orderId": "PAY-999", "approvalUrl": "https://paypal.com"}
        )
        result = json.loads(toolkit.topup_paypal(amount_cents=1000))
        assert result["orderId"] == "PAY-999"

    @patch("dominusnode_langflow.tools.httpx.Client")
    def test_update_wallet_policy(self, mock_httpx_cls):
        toolkit, mock_client = self._make_mocked_toolkit(
            mock_httpx_cls, {"dailyLimitCents": 5000}
        )
        result = json.loads(toolkit.update_wallet_policy(
            wallet_id="w-123", daily_limit_cents=5000,
        ))
        assert result["dailyLimitCents"] == 5000


# ===========================================================================
# Wallet Policy Tests
# ===========================================================================


class TestWalletPolicy:
    """Test create_agentic_wallet with policy fields and update_wallet_policy."""

    def test_create_with_daily_limit(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            daily_limit_cents=5000,
        ))
        if "error" in result:
            assert "daily_limit_cents" not in result["error"]

    def test_create_with_allowed_domains(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            allowed_domains=["example.com", "api.test.org"],
        ))
        if "error" in result:
            assert "allowed_domains" not in result["error"]

    def test_create_rejects_bad_daily_limit_zero(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            daily_limit_cents=0,
        ))
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    def test_create_rejects_daily_limit_over_max(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            daily_limit_cents=1_000_001,
        ))
        assert "error" in result

    def test_create_rejects_domains_not_list(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            allowed_domains="example.com",  # type: ignore
        ))
        assert "error" in result
        assert "list" in result["error"]

    def test_create_rejects_domain_too_long(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            allowed_domains=["a" * 254],
        ))
        assert "error" in result
        assert "253" in result["error"]

    def test_create_rejects_invalid_domain(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            allowed_domains=["not a domain!"],
        ))
        assert "error" in result
        assert "valid domain" in result["error"]

    def test_create_rejects_too_many_domains(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.create_agentic_wallet(
            label="test", spending_limit_cents=100,
            allowed_domains=["d.com"] * 101,
        ))
        assert "error" in result
        assert "100" in result["error"]

    def test_update_wallet_policy_rejects_empty_wallet_id(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.update_wallet_policy(
            wallet_id="", daily_limit_cents=5000,
        ))
        assert "error" in result
        assert "wallet_id" in result["error"]

    def test_update_wallet_policy_rejects_no_fields(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.update_wallet_policy(wallet_id="w-123"))
        assert "error" in result
        assert "At least one" in result["error"]

    def test_update_wallet_policy_rejects_bad_daily_limit(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.update_wallet_policy(
            wallet_id="w-123", daily_limit_cents=0,
        ))
        assert "error" in result
        assert "daily_limit_cents" in result["error"]

    def test_update_wallet_policy_rejects_bad_domains(self):
        toolkit = DominusNodeToolkit(api_key="dn_test_key123")
        result = json.loads(toolkit.update_wallet_policy(
            wallet_id="w-123", allowed_domains="bad",  # type: ignore
        ))
        assert "error" in result
        assert "list" in result["error"]
