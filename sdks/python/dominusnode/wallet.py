"""Wallet resource -- balance, transactions, top-ups, and forecasting."""

from __future__ import annotations

import math
from typing import List, Optional

from .http_client import AsyncHttpClient, SyncHttpClient
from .types import CryptoInvoice, StripeCheckout, Wallet, WalletForecast, WalletTransaction


def _validate_amount_cents(value: int, name: str = "amount_cents") -> None:
    """Validate that a financial amount is a positive integer within PostgreSQL int4 range."""
    if not isinstance(value, int) or value <= 0 or value > 2_147_483_647:
        raise ValueError(f"{name} must be a positive integer <= 2,147,483,647")


def _parse_wallet(data: dict) -> Wallet:
    return Wallet(
        balance_cents=data["balanceCents"],
        balance_usd=data["balanceUsd"],
        currency=data.get("currency", "usd"),
        last_topped_up=data.get("lastToppedUp"),
    )


def _parse_transaction(tx: dict) -> WalletTransaction:
    return WalletTransaction(
        id=tx["id"],
        type=tx["type"],
        amount_cents=tx["amountCents"],
        amount_usd=tx["amountUsd"],
        description=tx.get("description", ""),
        payment_provider=tx.get("paymentProvider"),
        created_at=str(tx.get("createdAt", "")),
    )


# ──────────────────────────────────────────────────────────────────────
# Sync
# ──────────────────────────────────────────────────────────────────────


class WalletResource:
    """Synchronous wallet operations."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def get_balance(self) -> Wallet:
        """Get current wallet balance."""
        data = self._http.get("/api/wallet")
        return _parse_wallet(data)

    def get_transactions(self, *, limit: int = 50, offset: int = 0) -> List[WalletTransaction]:
        """Get wallet transaction history."""
        data = self._http.get("/api/wallet/transactions", params={"limit": limit, "offset": offset})
        return [_parse_transaction(tx) for tx in data.get("transactions", [])]

    def top_up_stripe(self, amount_cents: int) -> StripeCheckout:
        """Create a Stripe checkout session for wallet top-up.

        Args:
            amount_cents: Amount in cents (e.g. 1000 = $10.00).
        """
        _validate_amount_cents(amount_cents, "amount_cents")
        data = self._http.post("/api/wallet/topup/stripe", json={"amountCents": amount_cents})
        return StripeCheckout(
            session_id=data["sessionId"],
            url=data["url"],
        )

    def top_up_crypto(self, amount_usd: float, currency: str) -> CryptoInvoice:
        """Create a crypto invoice for wallet top-up.

        Args:
            amount_usd: Amount in USD (min $10.00).
            currency: Crypto currency code (btc, eth, xmr, sol, zec).
        """
        if not isinstance(amount_usd, (int, float)) or math.isnan(amount_usd) or math.isinf(amount_usd):
            raise ValueError("amount_usd must be a finite number")
        if amount_usd < 10:
            raise ValueError("Minimum crypto top-up is $10.00")
        # Validate amount_usd converted to cents stays within int4 range
        amount_cents_approx = int(amount_usd * 100)
        _validate_amount_cents(amount_cents_approx, "amount_usd (as cents)")
        data = self._http.post(
            "/api/wallet/topup/crypto",
            json={"amountUsd": amount_usd, "currency": currency},
        )
        return CryptoInvoice(
            invoice_id=data["invoiceId"],
            invoice_url=data["invoiceUrl"],
            pay_currency=data["payCurrency"],
            price_amount=data["priceAmount"],
        )

    def get_forecast(self) -> WalletForecast:
        """Get wallet balance forecast based on recent usage."""
        data = self._http.get("/api/wallet/forecast")
        return WalletForecast(
            daily_avg_cents=data["dailyAvgCents"],
            days_remaining=data.get("daysRemaining"),
            trend=data["trend"],
            trend_pct=data["trendPct"],
        )


# ──────────────────────────────────────────────────────────────────────
# Async
# ──────────────────────────────────────────────────────────────────────


class AsyncWalletResource:
    """Asynchronous wallet operations."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def get_balance(self) -> Wallet:
        data = await self._http.get("/api/wallet")
        return _parse_wallet(data)

    async def get_transactions(self, *, limit: int = 50, offset: int = 0) -> List[WalletTransaction]:
        data = await self._http.get("/api/wallet/transactions", params={"limit": limit, "offset": offset})
        return [_parse_transaction(tx) for tx in data.get("transactions", [])]

    async def top_up_stripe(self, amount_cents: int) -> StripeCheckout:
        _validate_amount_cents(amount_cents, "amount_cents")
        data = await self._http.post("/api/wallet/topup/stripe", json={"amountCents": amount_cents})
        return StripeCheckout(
            session_id=data["sessionId"],
            url=data["url"],
        )

    async def top_up_crypto(self, amount_usd: float, currency: str) -> CryptoInvoice:
        if not isinstance(amount_usd, (int, float)) or math.isnan(amount_usd) or math.isinf(amount_usd):
            raise ValueError("amount_usd must be a finite number")
        if amount_usd < 10:
            raise ValueError("Minimum crypto top-up is $10.00")
        # Validate amount_usd converted to cents stays within int4 range
        amount_cents_approx = int(amount_usd * 100)
        _validate_amount_cents(amount_cents_approx, "amount_usd (as cents)")
        data = await self._http.post(
            "/api/wallet/topup/crypto",
            json={"amountUsd": amount_usd, "currency": currency},
        )
        return CryptoInvoice(
            invoice_id=data["invoiceId"],
            invoice_url=data["invoiceUrl"],
            pay_currency=data["payCurrency"],
            price_amount=data["priceAmount"],
        )

    async def get_forecast(self) -> WalletForecast:
        data = await self._http.get("/api/wallet/forecast")
        return WalletForecast(
            daily_avg_cents=data["dailyAvgCents"],
            days_remaining=data.get("daysRemaining"),
            trend=data["trend"],
            trend_pct=data["trendPct"],
        )
