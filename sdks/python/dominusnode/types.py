"""Documentation-only TypedDicts for the main results (wire keys are camelCase, as the server sends them)."""

from __future__ import annotations

from typing import Dict, List, Optional

try:
    from typing import TypedDict
except ImportError:  # pragma: no cover
    from typing_extensions import TypedDict  # type: ignore

from .secret import Secret


class Money(TypedDict):
    musd: str  # integer µUSD
    usd: str  # 6 decimals


class ConnectResult(TypedDict, total=False):
    mfaRequired: bool
    userId: str


class ActiveSession(TypedDict):
    id: str
    startedAt: str
    status: str


class CreatedApiKey(TypedDict):
    id: str
    prefix: str
    label: str
    created_at: str
    key: Secret


class PowChallenge(TypedDict):
    challengeId: str
    prefix: str
    difficulty: int
    algorithm: str
    expiresAt: str


class NodeChallenge(TypedDict):
    nonce: str
    attestationText: str
    attestationVersion: int
    policyVersion: int
    message: str
    expiresAt: str
    powChallenge: PowChallenge


class RegisteredNode(TypedDict):
    nodeId: str
    status: str
    attestationVersion: int
    nodeKey: Secret


class Payout(TypedDict, total=False):
    id: str
    amount: Money
    trigger: str
    status: str  # pending held_tax held_frozen submitted confirmed failed reversed
    txHash: Optional[str]
    createdAt: str
    failureReason: Optional[str]
    address: str
    chain: str
    updatedAt: str


class AgenticWallet(TypedDict):
    id: str
    label: str
    balanceCents: int
    spendingLimitCents: int
    dailyLimitCents: Optional[int]
    allowedDomains: Optional[List[str]]
    status: str
    createdAt: str


class PricingEntry(TypedDict):
    ipClass: str
    pricePerGbMusd: str


class NetworkPricing(TypedDict):
    currency: str
    unit: str
    prices: List[PricingEntry]
    nodeShare: List[Dict[str, object]]
    maturationHours: int
    rails: List[str]
