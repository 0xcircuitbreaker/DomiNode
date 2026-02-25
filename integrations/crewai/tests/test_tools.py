"""Tests for dominusnode-crewai tools.

All tests mock the DomiNode SDK client so no real network calls are made.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from dominusnode_crewai.tools import (
    DominusNodeBalanceTool,
    DominusNodeGeoTargetTool,
    DominusNodeWebScrapeTool,
    DominusNodeCreateAgenticWalletTool,
    DominusNodeFundAgenticWalletTool,
    DominusNodeAgenticWalletBalanceTool,
    DominusNodeListAgenticWalletsTool,
    DominusNodeAgenticTransactionsTool,
    DominusNodeFreezeAgenticWalletTool,
    DominusNodeUnfreezeAgenticWalletTool,
    DominusNodeDeleteAgenticWalletTool,
    DominusNodeUpdateWalletPolicyTool,
    _validate_url,
)


# ---------------------------------------------------------------------------
# URL validation tests (SSRF protection)
# ---------------------------------------------------------------------------


class TestValidateUrl:
    """Ensure _validate_url blocks dangerous URLs."""

    def test_allows_https(self):
        # Should not raise for a well-known public hostname
        result = _validate_url("https://example.com/page")
        assert result == "https://example.com/page"

    def test_allows_http(self):
        result = _validate_url("http://example.com/page")
        assert result == "http://example.com/page"

    def test_blocks_empty_url(self):
        with pytest.raises(ValueError, match="must not be empty"):
            _validate_url("")

    def test_blocks_file_scheme(self):
        with pytest.raises(ValueError, match="Only http and https"):
            _validate_url("file:///etc/passwd")

    def test_blocks_ftp_scheme(self):
        with pytest.raises(ValueError, match="Only http and https"):
            _validate_url("ftp://example.com/file")

    def test_blocks_javascript_scheme(self):
        with pytest.raises(ValueError, match="Only http and https"):
            _validate_url("javascript:alert(1)")

    def test_blocks_localhost(self):
        with pytest.raises(ValueError, match="blocked"):
            _validate_url("http://localhost/secret")

    def test_blocks_localhost_upper(self):
        with pytest.raises(ValueError, match="blocked"):
            _validate_url("http://LOCALHOST/secret")

    def test_blocks_127_0_0_1(self):
        with pytest.raises(ValueError, match="private"):
            _validate_url("http://127.0.0.1/admin")

    def test_blocks_10_x_private(self):
        with pytest.raises(ValueError, match="private"):
            _validate_url("http://10.0.0.1/internal")

    def test_blocks_172_16_private(self):
        with pytest.raises(ValueError, match="private"):
            _validate_url("http://172.16.0.1/internal")

    def test_blocks_192_168_private(self):
        with pytest.raises(ValueError, match="private"):
            _validate_url("http://192.168.1.1/router")

    def test_blocks_metadata_endpoint(self):
        with pytest.raises(ValueError, match="blocked"):
            _validate_url("http://169.254.169.254/latest/meta-data/")

    def test_blocks_internal_domain(self):
        with pytest.raises(ValueError, match="blocked domain suffix"):
            _validate_url("http://service.internal/api")

    def test_blocks_local_domain(self):
        with pytest.raises(ValueError, match="blocked domain suffix"):
            _validate_url("http://printer.local/status")

    def test_blocks_decimal_ip(self):
        with pytest.raises(ValueError, match="Decimal-encoded"):
            _validate_url("http://2130706433/secret")

    def test_blocks_octal_ip(self):
        with pytest.raises(ValueError, match="Octal-encoded"):
            _validate_url("http://0177.0.0.01/secret")

    def test_blocks_missing_hostname(self):
        with pytest.raises(ValueError, match="valid hostname"):
            _validate_url("http:///no-host")

    def test_blocks_ipv6_loopback(self):
        with pytest.raises(ValueError, match="private"):
            _validate_url("http://[::1]/secret")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_wallet(balance_cents: int = 1500):
    """Return a mock Wallet object."""
    wallet = MagicMock()
    wallet.balance_cents = balance_cents
    wallet.balance_usd = balance_cents / 100.0
    wallet.currency = "usd"
    return wallet


def _mock_proxy_config(countries=None):
    """Return a mock ProxyConfig object."""
    geo = MagicMock()
    geo.state_support = True
    geo.city_support = True
    geo.asn_support = False
    geo.us_states = ["CA", "NY", "TX"]
    geo.major_us_cities = ["Los Angeles", "New York", "Houston"]

    config = MagicMock()
    config.supported_countries = countries if countries is not None else ["US", "GB", "DE", "JP", "BR"]
    config.blocked_countries = ["CU", "IR", "KP", "RU", "SY"]
    config.geo_targeting = geo
    config.min_rotation_interval_minutes = 1
    config.max_rotation_interval_minutes = 60
    return config


def _mock_client(wallet=None, proxy_config=None, proxy_url="http://user:key@proxy:8080"):
    """Create a fully mocked DominusNodeClient."""
    client = MagicMock()
    client.wallet.get_balance.return_value = wallet or _mock_wallet()
    client.proxy.get_config.return_value = proxy_config or _mock_proxy_config()
    client.proxy.build_url.return_value = proxy_url
    client.close.return_value = None
    return client


# ---------------------------------------------------------------------------
# WebScrapeTool tests
# ---------------------------------------------------------------------------


class TestWebScrapeTool:
    """Tests for DominusNodeWebScrapeTool."""

    @patch("dominusnode_crewai.tools._make_client")
    @patch("dominusnode_crewai.tools._validate_url", return_value="https://example.com")
    @patch("dominusnode_crewai.tools.httpx.Client")
    def test_successful_scrape(self, mock_httpx_cls, mock_validate, mock_make):
        mock_make.return_value = _mock_client()

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = "<html><body>Hello World</body></html>"
        mock_response.headers = {"content-type": "text/html; charset=utf-8"}

        mock_http_instance = MagicMock()
        mock_http_instance.get.return_value = mock_response
        mock_http_instance.__enter__ = MagicMock(return_value=mock_http_instance)
        mock_http_instance.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_http_instance

        tool = DominusNodeWebScrapeTool(api_key="dn_live_test123")
        result = tool._run(url="https://example.com")

        assert "Status: 200" in result
        assert "Hello World" in result
        assert "text/html" in result

    @patch("dominusnode_crewai.tools._make_client")
    @patch("dominusnode_crewai.tools._validate_url", return_value="https://example.com")
    @patch("dominusnode_crewai.tools.httpx.Client")
    def test_truncates_long_body(self, mock_httpx_cls, mock_validate, mock_make):
        mock_make.return_value = _mock_client()

        long_text = "A" * 10000
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = long_text
        mock_response.headers = {"content-type": "text/html"}

        mock_http_instance = MagicMock()
        mock_http_instance.get.return_value = mock_response
        mock_http_instance.__enter__ = MagicMock(return_value=mock_http_instance)
        mock_http_instance.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_http_instance

        tool = DominusNodeWebScrapeTool(api_key="dn_live_test123")
        result = tool._run(url="https://example.com")

        assert "[truncated]" in result
        # Body portion should be at most 4000 chars of "A"s
        body_line_idx = result.index("Body (")
        body_content = result[body_line_idx:]
        assert "AAAA" in body_content

    def test_blocks_private_ip_url(self):
        tool = DominusNodeWebScrapeTool(api_key="dn_live_test123")
        result = tool._run(url="http://192.168.1.1/admin")
        assert "Error" in result
        assert "private" in result.lower() or "validation failed" in result.lower()

    def test_blocks_file_url(self):
        tool = DominusNodeWebScrapeTool(api_key="dn_live_test123")
        result = tool._run(url="file:///etc/passwd")
        assert "Error" in result

    def test_blocks_localhost_url(self):
        tool = DominusNodeWebScrapeTool(api_key="dn_live_test123")
        result = tool._run(url="http://localhost:8080/admin")
        assert "Error" in result

    def test_rejects_invalid_proxy_type(self):
        tool = DominusNodeWebScrapeTool(api_key="dn_live_test123")
        # Use a valid external URL but bad proxy_type -- should fail at proxy_type check
        with patch("dominusnode_crewai.tools._validate_url", return_value="https://example.com"):
            result = tool._run(url="https://example.com", proxy_type="invalid")
        assert "Error" in result
        assert "dc" in result or "residential" in result

    @patch("dominusnode_crewai.tools._make_client")
    @patch("dominusnode_crewai.tools._validate_url", return_value="https://example.com")
    @patch("dominusnode_crewai.tools.httpx.Client")
    def test_passes_country_to_proxy(self, mock_httpx_cls, mock_validate, mock_make):
        mock_client = _mock_client()
        mock_make.return_value = mock_client

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = "OK"
        mock_response.headers = {"content-type": "text/plain"}

        mock_http_instance = MagicMock()
        mock_http_instance.get.return_value = mock_response
        mock_http_instance.__enter__ = MagicMock(return_value=mock_http_instance)
        mock_http_instance.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_http_instance

        tool = DominusNodeWebScrapeTool(api_key="dn_live_test123")
        tool._run(url="https://example.com", country="GB")

        # Verify build_url was called with country set
        call_args = mock_client.proxy.build_url.call_args
        options = call_args[0][0]
        assert options.country == "GB"

    def test_no_api_key_returns_error(self):
        # Clear environment to ensure no fallback
        with patch.dict("os.environ", {}, clear=True):
            tool = DominusNodeWebScrapeTool()
            with patch("dominusnode_crewai.tools._validate_url", return_value="https://example.com"):
                result = tool._run(url="https://example.com")
            assert "Error" in result
            assert "API key" in result

    @patch("dominusnode_crewai.tools._make_client")
    @patch("dominusnode_crewai.tools._validate_url", return_value="https://example.com")
    def test_client_closed_on_error(self, mock_validate, mock_make):
        mock_client = _mock_client()
        mock_client.proxy.build_url.side_effect = Exception("boom")
        mock_make.return_value = mock_client

        tool = DominusNodeWebScrapeTool(api_key="dn_live_test123")
        result = tool._run(url="https://example.com")

        assert "Error" in result
        mock_client.close.assert_called_once()


# ---------------------------------------------------------------------------
# BalanceTool tests
# ---------------------------------------------------------------------------


class TestBalanceTool:
    """Tests for DominusNodeBalanceTool."""

    @patch("dominusnode_crewai.tools._make_client")
    def test_shows_balance_and_estimates(self, mock_make):
        mock_make.return_value = _mock_client(wallet=_mock_wallet(balance_cents=3000))

        tool = DominusNodeBalanceTool(api_key="dn_live_test123")
        result = tool._run()

        assert "$30.00" in result
        assert "Datacenter" in result
        assert "Residential" in result
        # 3000 / 300 = 10.0 GB DC
        assert "10.00 GB" in result
        # 3000 / 500 = 6.0 GB residential
        assert "6.00 GB" in result

    @patch("dominusnode_crewai.tools._make_client")
    def test_zero_balance(self, mock_make):
        mock_make.return_value = _mock_client(wallet=_mock_wallet(balance_cents=0))

        tool = DominusNodeBalanceTool(api_key="dn_live_test123")
        result = tool._run()

        assert "$0.00" in result
        assert "0.00 GB" in result

    @patch("dominusnode_crewai.tools._make_client")
    def test_client_closed_after_check(self, mock_make):
        client = _mock_client()
        mock_make.return_value = client

        tool = DominusNodeBalanceTool(api_key="dn_live_test123")
        tool._run()

        client.close.assert_called_once()

    def test_no_api_key_returns_error(self):
        with patch.dict("os.environ", {}, clear=True):
            tool = DominusNodeBalanceTool()
            result = tool._run()
            assert "Error" in result
            assert "API key" in result

    @patch("dominusnode_crewai.tools._make_client")
    def test_api_error_is_caught(self, mock_make):
        client = _mock_client()
        client.wallet.get_balance.side_effect = Exception("connection refused")
        mock_make.return_value = client

        tool = DominusNodeBalanceTool(api_key="dn_live_test123")
        result = tool._run()

        assert "Error" in result
        assert "connection refused" in result


# ---------------------------------------------------------------------------
# GeoTargetTool tests
# ---------------------------------------------------------------------------


class TestGeoTargetTool:
    """Tests for DominusNodeGeoTargetTool."""

    @patch("dominusnode_crewai.tools._make_client")
    def test_lists_countries(self, mock_make):
        mock_make.return_value = _mock_client()

        tool = DominusNodeGeoTargetTool(api_key="dn_live_test123")
        result = tool._run()

        assert "US" in result
        assert "GB" in result
        assert "DE" in result

    @patch("dominusnode_crewai.tools._make_client")
    def test_shows_blocked_countries(self, mock_make):
        mock_make.return_value = _mock_client()

        tool = DominusNodeGeoTargetTool(api_key="dn_live_test123")
        result = tool._run()

        assert "CU" in result
        assert "IR" in result

    @patch("dominusnode_crewai.tools._make_client")
    def test_shows_targeting_features(self, mock_make):
        mock_make.return_value = _mock_client()

        tool = DominusNodeGeoTargetTool(api_key="dn_live_test123")
        result = tool._run()

        assert "US state targeting" in result
        assert "City targeting" in result

    @patch("dominusnode_crewai.tools._make_client")
    def test_shows_us_states(self, mock_make):
        mock_make.return_value = _mock_client()

        tool = DominusNodeGeoTargetTool(api_key="dn_live_test123")
        result = tool._run()

        assert "CA" in result
        assert "NY" in result

    @patch("dominusnode_crewai.tools._make_client")
    def test_shows_rotation_interval(self, mock_make):
        mock_make.return_value = _mock_client()

        tool = DominusNodeGeoTargetTool(api_key="dn_live_test123")
        result = tool._run()

        assert "1-60 minutes" in result

    @patch("dominusnode_crewai.tools._make_client")
    def test_empty_countries(self, mock_make):
        config = _mock_proxy_config(countries=[])
        mock_make.return_value = _mock_client(proxy_config=config)

        tool = DominusNodeGeoTargetTool(api_key="dn_live_test123")
        result = tool._run()

        assert "None listed" in result

    @patch("dominusnode_crewai.tools._make_client")
    def test_client_closed(self, mock_make):
        client = _mock_client()
        mock_make.return_value = client

        tool = DominusNodeGeoTargetTool(api_key="dn_live_test123")
        tool._run()

        client.close.assert_called_once()

    def test_no_api_key_returns_error(self):
        with patch.dict("os.environ", {}, clear=True):
            tool = DominusNodeGeoTargetTool()
            result = tool._run()
            assert "Error" in result
            assert "API key" in result


# ---------------------------------------------------------------------------
# API key redaction tests
# ---------------------------------------------------------------------------


class TestApiKeyRedaction:
    """Ensure API keys never leak into tool outputs."""

    @patch("dominusnode_crewai.tools._make_client")
    @patch("dominusnode_crewai.tools._validate_url", return_value="https://example.com")
    @patch("dominusnode_crewai.tools.httpx.Client")
    def test_api_key_not_in_scrape_output(self, mock_httpx_cls, mock_validate, mock_make):
        mock_make.return_value = _mock_client()

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = "test response"
        mock_response.headers = {"content-type": "text/html"}

        mock_http_instance = MagicMock()
        mock_http_instance.get.return_value = mock_response
        mock_http_instance.__enter__ = MagicMock(return_value=mock_http_instance)
        mock_http_instance.__exit__ = MagicMock(return_value=False)
        mock_httpx_cls.return_value = mock_http_instance

        api_key = "dn_live_supersecretkey123"
        tool = DominusNodeWebScrapeTool(api_key=api_key)
        result = tool._run(url="https://example.com")

        assert api_key not in result

    @patch("dominusnode_crewai.tools._make_client")
    def test_api_key_not_in_balance_output(self, mock_make):
        mock_make.return_value = _mock_client()

        api_key = "dn_live_supersecretkey456"
        tool = DominusNodeBalanceTool(api_key=api_key)
        result = tool._run()

        assert api_key not in result

    @patch("dominusnode_crewai.tools._make_client")
    def test_api_key_not_in_geo_output(self, mock_make):
        mock_make.return_value = _mock_client()

        api_key = "dn_live_supersecretkey789"
        tool = DominusNodeGeoTargetTool(api_key=api_key)
        result = tool._run()

        assert api_key not in result


# ---------------------------------------------------------------------------
# Environment variable fallback tests
# ---------------------------------------------------------------------------


class TestEnvFallback:
    """Ensure tools pick up DOMINUSNODE_API_KEY from environment."""

    @patch("dominusnode_crewai.tools._make_client")
    def test_balance_uses_env_key(self, mock_make):
        mock_make.return_value = _mock_client()

        with patch.dict("os.environ", {"DOMINUSNODE_API_KEY": "dn_live_from_env"}):
            tool = DominusNodeBalanceTool()
            result = tool._run()

        assert "Error" not in result
        assert "$" in result


# ---------------------------------------------------------------------------
# Agentic Wallet Tool tests
# ---------------------------------------------------------------------------


class TestAgenticWalletValidation:
    """Input validation tests for agentic wallet tools."""

    def test_create_empty_label(self):
        tool = DominusNodeCreateAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(label="", spending_limit_cents=1000)
        assert "Error" in result
        assert "label" in result.lower()

    def test_create_long_label(self):
        tool = DominusNodeCreateAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(label="A" * 101, spending_limit_cents=1000)
        assert "Error" in result
        assert "100 characters" in result

    def test_create_control_char_label(self):
        tool = DominusNodeCreateAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(label="test\x00wallet", spending_limit_cents=1000)
        assert "Error" in result
        assert "control" in result.lower()

    def test_create_zero_spending_limit(self):
        tool = DominusNodeCreateAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(label="test", spending_limit_cents=0)
        assert "Error" in result
        assert "spending_limit_cents" in result

    def test_create_negative_spending_limit(self):
        tool = DominusNodeCreateAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(label="test", spending_limit_cents=-100)
        assert "Error" in result

    def test_create_invalid_daily_limit(self):
        tool = DominusNodeCreateAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(label="test", spending_limit_cents=1000, daily_limit_cents=0)
        assert "Error" in result
        assert "daily_limit_cents" in result

    def test_create_daily_limit_too_high(self):
        tool = DominusNodeCreateAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(label="test", spending_limit_cents=1000, daily_limit_cents=1_000_001)
        assert "Error" in result

    def test_create_invalid_domain(self):
        tool = DominusNodeCreateAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(
            label="test", spending_limit_cents=1000,
            allowed_domains=["not a domain!!"],
        )
        assert "Error" in result
        assert "domain" in result.lower()

    def test_create_too_many_domains(self):
        tool = DominusNodeCreateAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(
            label="test", spending_limit_cents=1000,
            allowed_domains=["example.com"] * 101,
        )
        assert "Error" in result
        assert "100" in result

    def test_create_domain_too_long(self):
        tool = DominusNodeCreateAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(
            label="test", spending_limit_cents=1000,
            allowed_domains=["a" * 254 + ".com"],
        )
        assert "Error" in result
        assert "253" in result

    def test_fund_invalid_wallet_id(self):
        tool = DominusNodeFundAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(wallet_id="not-a-uuid", amount_cents=100)
        assert "Error" in result
        assert "UUID" in result

    def test_fund_empty_wallet_id(self):
        tool = DominusNodeFundAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(wallet_id="", amount_cents=100)
        assert "Error" in result

    def test_fund_zero_amount(self):
        tool = DominusNodeFundAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(
            wallet_id="12345678-1234-1234-1234-123456789012",
            amount_cents=0,
        )
        assert "Error" in result
        assert "amount_cents" in result

    def test_fund_negative_amount(self):
        tool = DominusNodeFundAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(
            wallet_id="12345678-1234-1234-1234-123456789012",
            amount_cents=-50,
        )
        assert "Error" in result

    def test_balance_invalid_wallet_id(self):
        tool = DominusNodeAgenticWalletBalanceTool(api_key="dn_live_test")
        result = tool._run(wallet_id="bad-id")
        assert "Error" in result
        assert "UUID" in result

    def test_transactions_invalid_limit(self):
        tool = DominusNodeAgenticTransactionsTool(api_key="dn_live_test")
        result = tool._run(
            wallet_id="12345678-1234-1234-1234-123456789012",
            limit=0,
        )
        assert "Error" in result
        assert "limit" in result

    def test_transactions_limit_too_high(self):
        tool = DominusNodeAgenticTransactionsTool(api_key="dn_live_test")
        result = tool._run(
            wallet_id="12345678-1234-1234-1234-123456789012",
            limit=101,
        )
        assert "Error" in result

    def test_freeze_invalid_wallet_id(self):
        tool = DominusNodeFreezeAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(wallet_id="not-uuid")
        assert "Error" in result

    def test_unfreeze_invalid_wallet_id(self):
        tool = DominusNodeUnfreezeAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(wallet_id="not-uuid")
        assert "Error" in result

    def test_delete_invalid_wallet_id(self):
        tool = DominusNodeDeleteAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(wallet_id="not-uuid")
        assert "Error" in result

    def test_update_policy_no_changes(self):
        tool = DominusNodeUpdateWalletPolicyTool(api_key="dn_live_test")
        result = tool._run(wallet_id="12345678-1234-1234-1234-123456789012")
        assert "Error" in result
        assert "At least one" in result

    def test_update_policy_invalid_daily_limit(self):
        tool = DominusNodeUpdateWalletPolicyTool(api_key="dn_live_test")
        result = tool._run(
            wallet_id="12345678-1234-1234-1234-123456789012",
            daily_limit_cents=0,
        )
        assert "Error" in result

    def test_update_policy_invalid_domains(self):
        tool = DominusNodeUpdateWalletPolicyTool(api_key="dn_live_test")
        result = tool._run(
            wallet_id="12345678-1234-1234-1234-123456789012",
            allowed_domains=["!!!invalid"],
        )
        assert "Error" in result


class TestAgenticWalletApiCalls:
    """Tests for agentic wallet tools making API calls."""

    @patch("dominusnode_crewai.tools._api_request_sync")
    def test_create_success(self, mock_api):
        mock_api.return_value = {
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "label": "My Agent",
            "status": "active",
        }
        tool = DominusNodeCreateAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(label="My Agent", spending_limit_cents=5000)
        assert "Created" in result
        assert "My Agent" in result
        assert "aaaaaaaa" in result
        mock_api.assert_called_once()

    @patch("dominusnode_crewai.tools._api_request_sync")
    def test_fund_success(self, mock_api):
        mock_api.return_value = {"balanceCents": 1500}
        tool = DominusNodeFundAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(
            wallet_id="12345678-1234-1234-1234-123456789012",
            amount_cents=1000,
        )
        assert "Funded" in result
        assert "1000 cents" in result
        assert "1500" in result

    @patch("dominusnode_crewai.tools._api_request_sync")
    def test_balance_success(self, mock_api):
        mock_api.return_value = {
            "id": "12345678-1234-1234-1234-123456789012",
            "label": "Test",
            "balanceCents": 2500,
            "spendingLimitCents": 5000,
            "status": "active",
        }
        tool = DominusNodeAgenticWalletBalanceTool(api_key="dn_live_test")
        result = tool._run(wallet_id="12345678-1234-1234-1234-123456789012")
        assert "2500 cents" in result
        assert "$25.00" in result
        assert "Test" in result

    @patch("dominusnode_crewai.tools._api_request_sync")
    def test_list_success(self, mock_api):
        mock_api.return_value = {
            "wallets": [
                {"id": "aaa", "label": "W1", "balanceCents": 100, "status": "active"},
                {"id": "bbb", "label": "W2", "balanceCents": 200, "status": "frozen"},
            ]
        }
        tool = DominusNodeListAgenticWalletsTool(api_key="dn_live_test")
        result = tool._run()
        assert "W1" in result
        assert "W2" in result
        assert "2" in result

    @patch("dominusnode_crewai.tools._api_request_sync")
    def test_list_empty(self, mock_api):
        mock_api.return_value = {"wallets": []}
        tool = DominusNodeListAgenticWalletsTool(api_key="dn_live_test")
        result = tool._run()
        assert "No agentic wallets" in result

    @patch("dominusnode_crewai.tools._api_request_sync")
    def test_transactions_success(self, mock_api):
        mock_api.return_value = {
            "transactions": [
                {"type": "fund", "amountCents": 500, "createdAt": "2026-01-15"},
            ]
        }
        tool = DominusNodeAgenticTransactionsTool(api_key="dn_live_test")
        result = tool._run(wallet_id="12345678-1234-1234-1234-123456789012")
        assert "fund" in result
        assert "500" in result

    @patch("dominusnode_crewai.tools._api_request_sync")
    def test_freeze_success(self, mock_api):
        mock_api.return_value = {"status": "frozen"}
        tool = DominusNodeFreezeAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(wallet_id="12345678-1234-1234-1234-123456789012")
        assert "frozen" in result

    @patch("dominusnode_crewai.tools._api_request_sync")
    def test_unfreeze_success(self, mock_api):
        mock_api.return_value = {"status": "active"}
        tool = DominusNodeUnfreezeAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(wallet_id="12345678-1234-1234-1234-123456789012")
        assert "unfrozen" in result

    @patch("dominusnode_crewai.tools._api_request_sync")
    def test_delete_success(self, mock_api):
        mock_api.return_value = {}
        tool = DominusNodeDeleteAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(wallet_id="12345678-1234-1234-1234-123456789012")
        assert "deleted" in result

    @patch("dominusnode_crewai.tools._api_request_sync")
    def test_update_policy_success(self, mock_api):
        mock_api.return_value = {
            "dailyLimitCents": 5000,
            "allowedDomains": ["example.com"],
        }
        tool = DominusNodeUpdateWalletPolicyTool(api_key="dn_live_test")
        result = tool._run(
            wallet_id="12345678-1234-1234-1234-123456789012",
            daily_limit_cents=5000,
            allowed_domains=["example.com"],
        )
        assert "Updated" in result
        assert "5000" in result


class TestAgenticWalletErrorHandling:
    """Tests for error handling in agentic wallet tools."""

    def test_create_no_api_key(self):
        with patch.dict("os.environ", {}, clear=True):
            tool = DominusNodeCreateAgenticWalletTool()
            result = tool._run(label="test", spending_limit_cents=1000)
            assert "Error" in result
            assert "API key" in result

    @patch("dominusnode_crewai.tools._api_request_sync")
    def test_create_api_error_scrubs_credentials(self, mock_api):
        mock_api.side_effect = Exception("Auth failed for dn_live_secret123")
        tool = DominusNodeCreateAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(label="test", spending_limit_cents=1000)
        assert "Error" in result
        assert "dn_live_secret123" not in result
        assert "***" in result

    @patch("dominusnode_crewai.tools._api_request_sync")
    def test_fund_api_error(self, mock_api):
        mock_api.side_effect = Exception("Connection refused")
        tool = DominusNodeFundAgenticWalletTool(api_key="dn_live_test")
        result = tool._run(
            wallet_id="12345678-1234-1234-1234-123456789012",
            amount_cents=100,
        )
        assert "Error" in result
        assert "Connection refused" in result
