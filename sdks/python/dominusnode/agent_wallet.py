"""Agentic wallet resource -- server-side custodial sub-wallets with spending limits."""

from __future__ import annotations

from typing import List, Optional
from urllib.parse import quote

from .http_client import AsyncHttpClient, SyncHttpClient
from .types import AgenticWallet, AgenticWalletTransaction
from .wallet import _validate_amount_cents


def _parse_agentic_wallet(data: dict) -> AgenticWallet:
    """Parse an agentic wallet response dict into an AgenticWallet dataclass."""
    return AgenticWallet(
        id=data["id"],
        label=data["label"],
        balance_cents=data["balanceCents"],
        spending_limit_cents=data["spendingLimitCents"],
        status=data["status"],
        created_at=data.get("createdAt", ""),
        daily_limit_cents=data.get("dailyLimitCents"),
        allowed_domains=data.get("allowedDomains"),
    )


class AgenticWalletResource:
    """Synchronous agentic wallet operations."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def create(
        self,
        label: str,
        spending_limit_cents: int = 10000,
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[List[str]] = None,
    ) -> AgenticWallet:
        """Create a new agentic wallet."""
        _validate_amount_cents(spending_limit_cents, "spending_limit_cents")
        body: dict = {
            "label": label,
            "spendingLimitCents": spending_limit_cents,
        }
        if daily_limit_cents is not None:
            _validate_amount_cents(daily_limit_cents, "daily_limit_cents")
            body["dailyLimitCents"] = daily_limit_cents
        if allowed_domains is not None:
            body["allowedDomains"] = allowed_domains
        data = self._http.post("/api/agent-wallet", json=body)
        return _parse_agentic_wallet(data)

    def list(self) -> List[AgenticWallet]:
        """List all agentic wallets."""
        data = self._http.get("/api/agent-wallet")
        return [_parse_agentic_wallet(w) for w in data["wallets"]]

    def get(self, wallet_id: str) -> AgenticWallet:
        """Get a single agentic wallet."""
        data = self._http.get(f"/api/agent-wallet/{quote(wallet_id, safe='')}")
        return _parse_agentic_wallet(data)

    def fund(self, wallet_id: str, amount_cents: int) -> AgenticWalletTransaction:
        """Fund an agentic wallet from the main wallet."""
        _validate_amount_cents(amount_cents, "amount_cents")
        data = self._http.post(f"/api/agent-wallet/{quote(wallet_id, safe='')}/fund", json={
            "amountCents": amount_cents,
        })
        tx = data["transaction"]
        return AgenticWalletTransaction(
            id=tx["id"],
            wallet_id=tx["walletId"],
            type=tx["type"],
            amount_cents=tx["amountCents"],
            description=tx["description"],
            session_id=tx.get("sessionId"),
            created_at=tx["createdAt"],
        )

    def transactions(
        self, wallet_id: str, limit: int = 50, offset: int = 0
    ) -> List[AgenticWalletTransaction]:
        """Get transaction history for an agentic wallet."""
        data = self._http.get(
            f"/api/agent-wallet/{quote(wallet_id, safe='')}/transactions?limit={limit}&offset={offset}"
        )
        return [
            AgenticWalletTransaction(
                id=tx["id"],
                wallet_id=tx["walletId"],
                type=tx["type"],
                amount_cents=tx["amountCents"],
                description=tx["description"],
                session_id=tx.get("sessionId"),
                created_at=tx["createdAt"],
            )
            for tx in data["transactions"]
        ]

    def freeze(self, wallet_id: str) -> AgenticWallet:
        """Freeze an agentic wallet."""
        data = self._http.post(f"/api/agent-wallet/{quote(wallet_id, safe='')}/freeze", json={})
        return _parse_agentic_wallet(data)

    def unfreeze(self, wallet_id: str) -> AgenticWallet:
        """Unfreeze an agentic wallet."""
        data = self._http.post(f"/api/agent-wallet/{quote(wallet_id, safe='')}/unfreeze", json={})
        return _parse_agentic_wallet(data)

    def delete(self, wallet_id: str) -> int:
        """Delete an agentic wallet and refund remaining balance. Returns refunded cents."""
        data = self._http.delete(f"/api/agent-wallet/{quote(wallet_id, safe='')}")
        return data["refundedCents"]

    def update_wallet_policy(
        self,
        wallet_id: str,
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[List[str]] = None,
    ) -> AgenticWallet:
        """Update the policy on an agentic wallet."""
        body: dict = {}
        if daily_limit_cents is not None:
            _validate_amount_cents(daily_limit_cents, "daily_limit_cents")
            body["dailyLimitCents"] = daily_limit_cents
        if allowed_domains is not None:
            body["allowedDomains"] = allowed_domains
        data = self._http.patch(
            f"/api/agent-wallet/{quote(wallet_id, safe='')}/policy", json=body
        )
        return _parse_agentic_wallet(data)


class AsyncAgenticWalletResource:
    """Asynchronous agentic wallet operations."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def create(
        self,
        label: str,
        spending_limit_cents: int = 10000,
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[List[str]] = None,
    ) -> AgenticWallet:
        """Create a new agentic wallet."""
        _validate_amount_cents(spending_limit_cents, "spending_limit_cents")
        body: dict = {
            "label": label,
            "spendingLimitCents": spending_limit_cents,
        }
        if daily_limit_cents is not None:
            _validate_amount_cents(daily_limit_cents, "daily_limit_cents")
            body["dailyLimitCents"] = daily_limit_cents
        if allowed_domains is not None:
            body["allowedDomains"] = allowed_domains
        data = await self._http.post("/api/agent-wallet", json=body)
        return _parse_agentic_wallet(data)

    async def list(self) -> List[AgenticWallet]:
        """List all agentic wallets."""
        data = await self._http.get("/api/agent-wallet")
        return [_parse_agentic_wallet(w) for w in data["wallets"]]

    async def get(self, wallet_id: str) -> AgenticWallet:
        """Get a single agentic wallet."""
        data = await self._http.get(f"/api/agent-wallet/{quote(wallet_id, safe='')}")
        return _parse_agentic_wallet(data)

    async def fund(self, wallet_id: str, amount_cents: int) -> AgenticWalletTransaction:
        """Fund an agentic wallet from the main wallet."""
        _validate_amount_cents(amount_cents, "amount_cents")
        data = await self._http.post(f"/api/agent-wallet/{quote(wallet_id, safe='')}/fund", json={
            "amountCents": amount_cents,
        })
        tx = data["transaction"]
        return AgenticWalletTransaction(
            id=tx["id"],
            wallet_id=tx["walletId"],
            type=tx["type"],
            amount_cents=tx["amountCents"],
            description=tx["description"],
            session_id=tx.get("sessionId"),
            created_at=tx["createdAt"],
        )

    async def transactions(
        self, wallet_id: str, limit: int = 50, offset: int = 0
    ) -> List[AgenticWalletTransaction]:
        """Get transaction history for an agentic wallet."""
        data = await self._http.get(
            f"/api/agent-wallet/{quote(wallet_id, safe='')}/transactions?limit={limit}&offset={offset}"
        )
        return [
            AgenticWalletTransaction(
                id=tx["id"],
                wallet_id=tx["walletId"],
                type=tx["type"],
                amount_cents=tx["amountCents"],
                description=tx["description"],
                session_id=tx.get("sessionId"),
                created_at=tx["createdAt"],
            )
            for tx in data["transactions"]
        ]

    async def freeze(self, wallet_id: str) -> AgenticWallet:
        """Freeze an agentic wallet."""
        data = await self._http.post(f"/api/agent-wallet/{quote(wallet_id, safe='')}/freeze", json={})
        return _parse_agentic_wallet(data)

    async def unfreeze(self, wallet_id: str) -> AgenticWallet:
        """Unfreeze an agentic wallet."""
        data = await self._http.post(f"/api/agent-wallet/{quote(wallet_id, safe='')}/unfreeze", json={})
        return _parse_agentic_wallet(data)

    async def delete(self, wallet_id: str) -> int:
        """Delete an agentic wallet and refund remaining balance. Returns refunded cents."""
        data = await self._http.delete(f"/api/agent-wallet/{quote(wallet_id, safe='')}")
        return data["refundedCents"]

    async def update_wallet_policy(
        self,
        wallet_id: str,
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[List[str]] = None,
    ) -> AgenticWallet:
        """Update the policy on an agentic wallet."""
        body: dict = {}
        if daily_limit_cents is not None:
            _validate_amount_cents(daily_limit_cents, "daily_limit_cents")
            body["dailyLimitCents"] = daily_limit_cents
        if allowed_domains is not None:
            body["allowedDomains"] = allowed_domains
        data = await self._http.patch(
            f"/api/agent-wallet/{quote(wallet_id, safe='')}/policy", json=body
        )
        return _parse_agentic_wallet(data)
