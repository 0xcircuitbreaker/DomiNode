"""Tests for x402 resource."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from dominusnode.x402 import X402Resource, AsyncX402Resource, _parse_x402_info


MOCK_X402_INFO = {
    "supported": True,
    "enabled": True,
    "protocol": "x402",
    "version": "1.0",
    "facilitators": [
        {"address": "0xabc123", "chain": "base", "network": "mainnet"},
    ],
    "pricing": {"perRequestCents": 1, "perGbCents": 300, "currency": "USDC"},
    "currencies": ["USDC", "USDT"],
    "walletType": "evm",
    "agenticWallets": True,
}


class TestX402Resource:

    def test_get_info(self) -> None:
        http = MagicMock()
        http.get.return_value = MOCK_X402_INFO

        resource = X402Resource(http)
        result = resource.get_info()

        http.get.assert_called_once_with("/api/x402/info", requires_auth=False)
        assert result.supported is True
        assert result.enabled is True
        assert result.protocol == "x402"
        assert len(result.facilitators) == 1
        assert result.facilitators[0].address == "0xabc123"
        assert result.pricing.per_request_cents == 1
        assert result.pricing.per_gb_cents == 300
        assert "USDC" in result.currencies
        assert result.agentic_wallets is True


class TestParseX402Info:

    def test_parses_full_response(self) -> None:
        info = _parse_x402_info(MOCK_X402_INFO)
        assert info.supported is True
        assert info.version == "1.0"
        assert info.wallet_type == "evm"

    def test_handles_missing_fields(self) -> None:
        info = _parse_x402_info({})
        assert info.supported is False
        assert info.enabled is False
        assert info.facilitators == []
        assert info.currencies == []
