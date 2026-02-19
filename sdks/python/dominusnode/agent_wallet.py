"""Agentic wallet resource -- server-side custodial sub-wallets with spending limits."""

from __future__ import annotations

from typing import List, Optional
from urllib.parse import quote

from .http_client import AsyncHttpClient, SyncHttpClient
from .types import AgenticWallet, AgenticWalletTransaction


class AgenticWalletResource:
    """Synchronous agentic wallet operations."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def create(self, label: str, spending_limit_cents: int = 10000) -> AgenticWallet:
        """Create a new agentic wallet."""
        data = self._http.post("/api/agent-wallet", json={
            "label": label,
            "spendingLimitCents": spending_limit_cents,
        })
        return AgenticWallet(
            id=data["id"],
            label=data["label"],
            balance_cents=data["balanceCents"],
            spending_limit_cents=data["spendingLimitCents"],
            status=data["status"],
            created_at=data["createdAt"],
        )

    def list(self) -> List[AgenticWallet]:
        """List all agentic wallets."""
        data = self._http.get("/api/agent-wallet")
        return [
            AgenticWallet(
                id=w["id"],
                label=w["label"],
                balance_cents=w["balanceCents"],
                spending_limit_cents=w["spendingLimitCents"],
                status=w["status"],
                created_at=w["createdAt"],
            )
            for w in data["wallets"]
        ]

    def get(self, wallet_id: str) -> AgenticWallet:
        """Get a single agentic wallet."""
        data = self._http.get(f"/api/agent-wallet/{quote(wallet_id, safe='')}")
        return AgenticWallet(
            id=data["id"],
            label=data["label"],
            balance_cents=data["balanceCents"],
            spending_limit_cents=data["spendingLimitCents"],
            status=data["status"],
            created_at=data["createdAt"],
        )

    def fund(self, wallet_id: str, amount_cents: int) -> AgenticWalletTransaction:
        """Fund an agentic wallet from the main wallet."""
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
        return AgenticWallet(
            id=data["id"],
            label=data["label"],
            balance_cents=data["balanceCents"],
            spending_limit_cents=data.get("spendingLimitCents", 0),
            status=data["status"],
            created_at=data.get("createdAt", ""),
        )

    def unfreeze(self, wallet_id: str) -> AgenticWallet:
        """Unfreeze an agentic wallet."""
        data = self._http.post(f"/api/agent-wallet/{quote(wallet_id, safe='')}/unfreeze", json={})
        return AgenticWallet(
            id=data["id"],
            label=data["label"],
            balance_cents=data["balanceCents"],
            spending_limit_cents=data.get("spendingLimitCents", 0),
            status=data["status"],
            created_at=data.get("createdAt", ""),
        )

    def delete(self, wallet_id: str) -> int:
        """Delete an agentic wallet and refund remaining balance. Returns refunded cents."""
        data = self._http.delete(f"/api/agent-wallet/{quote(wallet_id, safe='')}")
        return data["refundedCents"]


class AsyncAgenticWalletResource:
    """Asynchronous agentic wallet operations."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def create(self, label: str, spending_limit_cents: int = 10000) -> AgenticWallet:
        """Create a new agentic wallet."""
        data = await self._http.post("/api/agent-wallet", json={
            "label": label,
            "spendingLimitCents": spending_limit_cents,
        })
        return AgenticWallet(
            id=data["id"],
            label=data["label"],
            balance_cents=data["balanceCents"],
            spending_limit_cents=data["spendingLimitCents"],
            status=data["status"],
            created_at=data["createdAt"],
        )

    async def list(self) -> List[AgenticWallet]:
        """List all agentic wallets."""
        data = await self._http.get("/api/agent-wallet")
        return [
            AgenticWallet(
                id=w["id"],
                label=w["label"],
                balance_cents=w["balanceCents"],
                spending_limit_cents=w["spendingLimitCents"],
                status=w["status"],
                created_at=w["createdAt"],
            )
            for w in data["wallets"]
        ]

    async def get(self, wallet_id: str) -> AgenticWallet:
        """Get a single agentic wallet."""
        data = await self._http.get(f"/api/agent-wallet/{quote(wallet_id, safe='')}")
        return AgenticWallet(
            id=data["id"],
            label=data["label"],
            balance_cents=data["balanceCents"],
            spending_limit_cents=data["spendingLimitCents"],
            status=data["status"],
            created_at=data["createdAt"],
        )

    async def fund(self, wallet_id: str, amount_cents: int) -> AgenticWalletTransaction:
        """Fund an agentic wallet from the main wallet."""
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
        return AgenticWallet(
            id=data["id"],
            label=data["label"],
            balance_cents=data["balanceCents"],
            spending_limit_cents=data.get("spendingLimitCents", 0),
            status=data["status"],
            created_at=data.get("createdAt", ""),
        )

    async def unfreeze(self, wallet_id: str) -> AgenticWallet:
        """Unfreeze an agentic wallet."""
        data = await self._http.post(f"/api/agent-wallet/{quote(wallet_id, safe='')}/unfreeze", json={})
        return AgenticWallet(
            id=data["id"],
            label=data["label"],
            balance_cents=data["balanceCents"],
            spending_limit_cents=data.get("spendingLimitCents", 0),
            status=data["status"],
            created_at=data.get("createdAt", ""),
        )

    async def delete(self, wallet_id: str) -> int:
        """Delete an agentic wallet and refund remaining balance. Returns refunded cents."""
        data = await self._http.delete(f"/api/agent-wallet/{quote(wallet_id, safe='')}")
        return data["refundedCents"]
