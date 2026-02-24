"""x402 (HTTP 402 Payment Required) protocol information resource."""

from __future__ import annotations

from typing import List
from dataclasses import dataclass, field

from .http_client import AsyncHttpClient, SyncHttpClient


@dataclass(frozen=True)
class X402Facilitator:
    address: str
    chain: str
    network: str


@dataclass(frozen=True)
class X402Pricing:
    per_request_cents: int
    per_gb_cents: int
    currency: str


@dataclass(frozen=True)
class X402Info:
    supported: bool
    enabled: bool
    protocol: str
    version: str
    facilitators: List[X402Facilitator]
    pricing: X402Pricing
    currencies: List[str]
    wallet_type: str
    agentic_wallets: bool


def _parse_x402_info(data: dict) -> X402Info:
    """Parse x402 info response into typed dataclass."""
    facilitators = [
        X402Facilitator(
            address=f["address"],
            chain=f["chain"],
            network=f["network"],
        )
        for f in data.get("facilitators", [])
    ]
    pricing_data = data.get("pricing", {})
    pricing = X402Pricing(
        per_request_cents=pricing_data.get("perRequestCents", 0),
        per_gb_cents=pricing_data.get("perGbCents", 0),
        currency=pricing_data.get("currency", ""),
    )
    return X402Info(
        supported=data.get("supported", False),
        enabled=data.get("enabled", False),
        protocol=data.get("protocol", ""),
        version=data.get("version", ""),
        facilitators=facilitators,
        pricing=pricing,
        currencies=data.get("currencies", []),
        wallet_type=data.get("walletType", ""),
        agentic_wallets=data.get("agenticWallets", False),
    )


class X402Resource:
    """Synchronous x402 protocol information operations."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def get_info(self) -> X402Info:
        """Get x402 protocol information (no auth required)."""
        data = self._http.get("/api/x402/info", requires_auth=False)
        return _parse_x402_info(data)


class AsyncX402Resource:
    """Asynchronous x402 protocol information operations."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def get_info(self) -> X402Info:
        """Get x402 protocol information (no auth required)."""
        data = await self._http.get("/api/x402/info", requires_auth=False)
        return _parse_x402_info(data)
