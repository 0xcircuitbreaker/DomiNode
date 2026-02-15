"""Tests for the WalletResource (sync) -- balance, transactions, top-ups, forecast."""

from __future__ import annotations

from unittest.mock import MagicMock

from dominusnode.wallet import WalletResource
from dominusnode.types import CryptoInvoice, StripeCheckout, Wallet, WalletForecast, WalletTransaction


class TestWalletResource:
    """Tests for synchronous wallet operations."""

    def _make_wallet(self) -> tuple[WalletResource, MagicMock]:
        mock_http = MagicMock()
        wallet = WalletResource(mock_http)
        return wallet, mock_http

    def test_get_balance_returns_wallet(self) -> None:
        wallet, mock_http = self._make_wallet()
        mock_http.get.return_value = {
            "balanceCents": 5000,
            "balanceUsd": 50.0,
            "currency": "usd",
            "lastToppedUp": "2024-06-01T12:00:00Z",
        }

        result = wallet.get_balance()
        assert isinstance(result, Wallet)
        assert result.balance_cents == 5000
        assert result.balance_usd == 50.0
        assert result.currency == "usd"
        assert result.last_topped_up == "2024-06-01T12:00:00Z"
        mock_http.get.assert_called_once_with("/api/wallet")

    def test_get_balance_without_last_topped_up(self) -> None:
        wallet, mock_http = self._make_wallet()
        mock_http.get.return_value = {
            "balanceCents": 0,
            "balanceUsd": 0.0,
            "currency": "usd",
        }

        result = wallet.get_balance()
        assert result.balance_cents == 0
        assert result.last_topped_up is None

    def test_get_transactions_returns_list(self) -> None:
        wallet, mock_http = self._make_wallet()
        mock_http.get.return_value = {
            "transactions": [
                {
                    "id": "tx-1",
                    "type": "topup",
                    "amountCents": 1000,
                    "amountUsd": 10.0,
                    "description": "Stripe top-up",
                    "paymentProvider": "stripe",
                    "createdAt": "2024-06-01T12:00:00Z",
                },
                {
                    "id": "tx-2",
                    "type": "debit",
                    "amountCents": -50,
                    "amountUsd": -0.5,
                    "description": "Usage charge",
                    "createdAt": "2024-06-02T10:00:00Z",
                },
            ],
        }

        result = wallet.get_transactions(limit=10, offset=0)
        assert len(result) == 2
        assert isinstance(result[0], WalletTransaction)
        assert result[0].id == "tx-1"
        assert result[0].type == "topup"
        assert result[0].amount_cents == 1000
        assert result[0].payment_provider == "stripe"
        assert result[1].type == "debit"
        assert result[1].payment_provider is None

        mock_http.get.assert_called_once_with(
            "/api/wallet/transactions",
            params={"limit": 10, "offset": 0},
        )

    def test_get_transactions_empty_list(self) -> None:
        wallet, mock_http = self._make_wallet()
        mock_http.get.return_value = {"transactions": []}

        result = wallet.get_transactions()
        assert result == []

    def test_top_up_stripe_returns_checkout(self) -> None:
        wallet, mock_http = self._make_wallet()
        mock_http.post.return_value = {
            "sessionId": "cs_test_abc123",
            "url": "https://checkout.stripe.com/pay/cs_test_abc123",
        }

        result = wallet.top_up_stripe(2000)
        assert isinstance(result, StripeCheckout)
        assert result.session_id == "cs_test_abc123"
        assert "stripe.com" in result.url
        mock_http.post.assert_called_once_with(
            "/api/wallet/topup/stripe",
            json={"amountCents": 2000},
        )

    def test_top_up_crypto_returns_invoice(self) -> None:
        wallet, mock_http = self._make_wallet()
        mock_http.post.return_value = {
            "invoiceId": "inv-btc-123",
            "invoiceUrl": "https://nowpayments.io/payment/inv-btc-123",
            "payCurrency": "btc",
            "priceAmount": 0.00025,
        }

        result = wallet.top_up_crypto(10.0, "btc")
        assert isinstance(result, CryptoInvoice)
        assert result.invoice_id == "inv-btc-123"
        assert result.pay_currency == "btc"
        assert result.price_amount == 0.00025
        mock_http.post.assert_called_once_with(
            "/api/wallet/topup/crypto",
            json={"amountUsd": 10.0, "currency": "btc"},
        )

    def test_get_forecast(self) -> None:
        wallet, mock_http = self._make_wallet()
        mock_http.get.return_value = {
            "dailyAvgCents": 150,
            "daysRemaining": 33.3,
            "trend": "stable",
            "trendPct": 2,
        }

        result = wallet.get_forecast()
        assert isinstance(result, WalletForecast)
        assert result.daily_avg_cents == 150
        assert result.days_remaining == 33.3
        assert result.trend == "stable"
        assert result.trend_pct == 2

    def test_get_forecast_no_days_remaining(self) -> None:
        wallet, mock_http = self._make_wallet()
        mock_http.get.return_value = {
            "dailyAvgCents": 0,
            "daysRemaining": None,
            "trend": "stable",
            "trendPct": 0,
        }

        result = wallet.get_forecast()
        assert result.days_remaining is None
