"""Tests for agentic wallet tools (CRUD, fund, freeze, unfreeze, delete).

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

_mod = importlib.import_module("tools.03_agentic_wallets")
create_agentic_wallet = _mod.create_agentic_wallet
fund_agentic_wallet = _mod.fund_agentic_wallet
agentic_wallet_balance = _mod.agentic_wallet_balance
list_agentic_wallets = _mod.list_agentic_wallets
agentic_transactions = _mod.agentic_transactions
freeze_agentic_wallet = _mod.freeze_agentic_wallet
unfreeze_agentic_wallet = _mod.unfreeze_agentic_wallet
delete_agentic_wallet = _mod.delete_agentic_wallet


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_auth() -> MagicMock:
    """Create a mock DominusNodeAuth."""
    auth = MagicMock()
    auth.api_key = "dn_live_testkey123"
    auth.api_request.return_value = {"id": "wallet-uuid", "label": "test", "balanceCents": 0}
    auth.sanitize_error.side_effect = lambda msg: msg
    auth.url_encode.side_effect = lambda v: v
    return auth


# ---------------------------------------------------------------------------
# create_agentic_wallet tests
# ---------------------------------------------------------------------------


class TestCreateAgenticWallet:
    """Tests for the create_agentic_wallet tool."""

    def test_valid_creation(self):
        auth = _mock_auth()
        result = json.loads(create_agentic_wallet(auth, {
            "label": "My Agent Wallet",
            "spending_limit_cents": 5000,
        }))
        assert "id" in result
        # Verify API was called with correct body
        auth.api_request.assert_called_once()
        call_args = auth.api_request.call_args
        assert call_args[0][1] == "/api/agent-wallet"
        assert call_args[0][2]["label"] == "My Agent Wallet"
        assert call_args[0][2]["spendingLimitCents"] == 5000

    def test_rejects_missing_label(self):
        auth = _mock_auth()
        result = json.loads(create_agentic_wallet(auth, {
            "spending_limit_cents": 5000,
        }))
        assert "error" in result
        assert "label" in result["error"]

    def test_rejects_long_label(self):
        auth = _mock_auth()
        result = json.loads(create_agentic_wallet(auth, {
            "label": "x" * 101,
            "spending_limit_cents": 5000,
        }))
        assert "error" in result
        assert "100" in result["error"]

    def test_rejects_control_chars_in_label(self):
        auth = _mock_auth()
        result = json.loads(create_agentic_wallet(auth, {
            "label": "test\x00wallet",
            "spending_limit_cents": 5000,
        }))
        assert "error" in result
        assert "control" in result["error"]

    def test_rejects_zero_spending_limit(self):
        auth = _mock_auth()
        result = json.loads(create_agentic_wallet(auth, {
            "label": "Test",
            "spending_limit_cents": 0,
        }))
        assert "error" in result

    def test_rejects_negative_spending_limit(self):
        auth = _mock_auth()
        result = json.loads(create_agentic_wallet(auth, {
            "label": "Test",
            "spending_limit_cents": -100,
        }))
        assert "error" in result

    def test_rejects_overflow_spending_limit(self):
        auth = _mock_auth()
        result = json.loads(create_agentic_wallet(auth, {
            "label": "Test",
            "spending_limit_cents": 2_147_483_648,
        }))
        assert "error" in result


# ---------------------------------------------------------------------------
# fund_agentic_wallet tests
# ---------------------------------------------------------------------------


class TestFundAgenticWallet:
    """Tests for the fund_agentic_wallet tool."""

    def test_valid_funding(self):
        auth = _mock_auth()
        result = json.loads(fund_agentic_wallet(auth, {
            "wallet_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
            "amount_cents": 1000,
        }))
        assert "id" in result

    def test_rejects_missing_wallet_id(self):
        auth = _mock_auth()
        result = json.loads(fund_agentic_wallet(auth, {"amount_cents": 1000}))
        assert "error" in result
        assert "wallet_id" in result["error"]

    def test_rejects_zero_amount(self):
        auth = _mock_auth()
        result = json.loads(fund_agentic_wallet(auth, {
            "wallet_id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
            "amount_cents": 0,
        }))
        assert "error" in result


# ---------------------------------------------------------------------------
# agentic_wallet_balance tests
# ---------------------------------------------------------------------------


class TestAgenticWalletBalance:
    """Tests for the agentic_wallet_balance tool."""

    def test_returns_balance(self):
        auth = _mock_auth()
        auth.api_request.return_value = {"id": "b2c3d4e5-f6a7-8901-bcde-f12345678901", "balanceCents": 500}
        result = json.loads(agentic_wallet_balance(auth, {"wallet_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901"}))
        assert result["balanceCents"] == 500

    def test_rejects_missing_wallet_id(self):
        auth = _mock_auth()
        result = json.loads(agentic_wallet_balance(auth, {}))
        assert "error" in result


# ---------------------------------------------------------------------------
# list_agentic_wallets tests
# ---------------------------------------------------------------------------


class TestListAgenticWallets:
    """Tests for the list_agentic_wallets tool."""

    def test_returns_list(self):
        auth = _mock_auth()
        auth.api_request.return_value = {"wallets": []}
        result = json.loads(list_agentic_wallets(auth, {}))
        assert "wallets" in result


# ---------------------------------------------------------------------------
# agentic_transactions tests
# ---------------------------------------------------------------------------


class TestAgenticTransactions:
    """Tests for the agentic_transactions tool."""

    def test_rejects_missing_wallet_id(self):
        auth = _mock_auth()
        result = json.loads(agentic_transactions(auth, {}))
        assert "error" in result

    def test_rejects_invalid_limit(self):
        auth = _mock_auth()
        result = json.loads(agentic_transactions(auth, {
            "wallet_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
            "limit": 200,
        }))
        assert "error" in result
        assert "1 and 100" in result["error"]

    def test_rejects_zero_limit(self):
        auth = _mock_auth()
        result = json.loads(agentic_transactions(auth, {
            "wallet_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
            "limit": 0,
        }))
        assert "error" in result


# ---------------------------------------------------------------------------
# freeze / unfreeze / delete tests
# ---------------------------------------------------------------------------


class TestFreezeUnfreezeDelete:
    """Tests for freeze, unfreeze, and delete tools."""

    def test_freeze_rejects_missing_wallet_id(self):
        auth = _mock_auth()
        result = json.loads(freeze_agentic_wallet(auth, {}))
        assert "error" in result

    def test_unfreeze_rejects_missing_wallet_id(self):
        auth = _mock_auth()
        result = json.loads(unfreeze_agentic_wallet(auth, {}))
        assert "error" in result

    def test_delete_rejects_missing_wallet_id(self):
        auth = _mock_auth()
        result = json.loads(delete_agentic_wallet(auth, {}))
        assert "error" in result

    def test_freeze_calls_correct_endpoint(self):
        auth = _mock_auth()
        freeze_agentic_wallet(auth, {"wallet_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"})
        call_args = auth.api_request.call_args
        assert "/freeze" in call_args[0][1]

    def test_unfreeze_calls_correct_endpoint(self):
        auth = _mock_auth()
        unfreeze_agentic_wallet(auth, {"wallet_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"})
        call_args = auth.api_request.call_args
        assert "/unfreeze" in call_args[0][1]

    def test_delete_calls_correct_endpoint(self):
        auth = _mock_auth()
        delete_agentic_wallet(auth, {"wallet_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"})
        call_args = auth.api_request.call_args
        assert call_args[0][0] == "DELETE"
