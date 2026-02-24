"""Tests for wallet balance, usage, and PayPal top-up tools.

All tests mock API calls so no real network requests are made.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

_mod = importlib.import_module("tools.02_wallet")
check_balance = _mod.check_balance
check_usage = _mod.check_usage
topup_paypal = _mod.topup_paypal


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_auth() -> MagicMock:
    """Create a mock DominusNodeAuth."""
    auth = MagicMock()
    auth.api_key = "dn_live_testkey123"
    auth.api_request.return_value = {"balanceCents": 5000, "balanceUsd": "50.00"}
    auth.sanitize_error.side_effect = lambda msg: msg
    auth.url_encode.side_effect = lambda v: v
    return auth


# ---------------------------------------------------------------------------
# check_balance tests
# ---------------------------------------------------------------------------


class TestCheckBalance:
    """Tests for the check_balance tool."""

    def test_returns_balance(self):
        auth = _mock_auth()
        result = json.loads(check_balance(auth, {}))
        assert "balanceCents" in result
        assert result["balanceCents"] == 5000

    def test_handles_api_error(self):
        auth = _mock_auth()
        auth.api_request.side_effect = RuntimeError("API error 500: Internal")
        result = json.loads(check_balance(auth, {}))
        assert "error" in result

    def test_credential_not_leaked(self):
        auth = _mock_auth()
        auth.api_request.side_effect = RuntimeError("Error with dn_live_testkey123")
        result = json.loads(check_balance(auth, {}))
        assert "dn_live_testkey123" not in result["error"]


# ---------------------------------------------------------------------------
# check_usage tests
# ---------------------------------------------------------------------------


class TestCheckUsage:
    """Tests for the check_usage tool."""

    def test_default_period_is_month(self):
        auth = _mock_auth()
        auth.api_request.return_value = {"totalBytes": 1024}
        result = json.loads(check_usage(auth, {}))
        assert "totalBytes" in result

        # Verify the API was called with since/until params
        call_args = auth.api_request.call_args
        path = call_args[0][1]
        assert "since=" in path
        assert "until=" in path

    def test_day_period(self):
        auth = _mock_auth()
        auth.api_request.return_value = {"totalBytes": 512}
        result = json.loads(check_usage(auth, {"period": "day"}))
        assert "totalBytes" in result

    def test_week_period(self):
        auth = _mock_auth()
        auth.api_request.return_value = {"totalBytes": 2048}
        result = json.loads(check_usage(auth, {"period": "week"}))
        assert "totalBytes" in result

    def test_rejects_invalid_period(self):
        auth = _mock_auth()
        result = json.loads(check_usage(auth, {"period": "year"}))
        assert "error" in result
        assert "period" in result["error"]

    def test_handles_api_error(self):
        auth = _mock_auth()
        auth.api_request.side_effect = RuntimeError("API error 401")
        result = json.loads(check_usage(auth, {}))
        assert "error" in result


# ---------------------------------------------------------------------------
# topup_paypal tests
# ---------------------------------------------------------------------------


class TestTopupPaypal:
    """Tests for the topup_paypal tool."""

    def test_valid_amount(self):
        auth = _mock_auth()
        auth.api_request.return_value = {
            "checkoutUrl": "https://paypal.com/checkout/123"
        }
        result = json.loads(topup_paypal(auth, {"amount_cents": 1000}))
        assert "checkoutUrl" in result

    def test_rejects_amount_below_minimum(self):
        auth = _mock_auth()
        result = json.loads(topup_paypal(auth, {"amount_cents": 50}))
        assert "error" in result
        assert "100" in result["error"]

    def test_rejects_amount_above_maximum(self):
        auth = _mock_auth()
        result = json.loads(topup_paypal(auth, {"amount_cents": 2_000_000}))
        assert "error" in result
        assert "1,000,000" in result["error"]

    def test_rejects_zero_amount(self):
        auth = _mock_auth()
        result = json.loads(topup_paypal(auth, {"amount_cents": 0}))
        assert "error" in result

    def test_rejects_negative_amount(self):
        auth = _mock_auth()
        result = json.loads(topup_paypal(auth, {"amount_cents": -500}))
        assert "error" in result

    def test_rejects_non_integer_amount(self):
        auth = _mock_auth()
        result = json.loads(topup_paypal(auth, {"amount_cents": 10.5}))
        assert "error" in result

    def test_rejects_string_amount(self):
        auth = _mock_auth()
        result = json.loads(topup_paypal(auth, {"amount_cents": "1000"}))
        assert "error" in result

    def test_handles_api_error(self):
        auth = _mock_auth()
        auth.api_request.side_effect = RuntimeError("API error 402: Payment Required")
        result = json.loads(topup_paypal(auth, {"amount_cents": 1000}))
        assert "error" in result
